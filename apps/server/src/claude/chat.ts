import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  ChatContext,
  ChatErrorCode,
  DrawingAnchor,
  DrawingMark,
  ChatMessage,
  ServerChatEvent,
  StudyMode,
  ThreadScope,
  ToolEvent,
} from '@pdfclaudeassistant/shared';
import type { FastifyBaseLogger } from 'fastify';
import { FORBIDDEN_CLAUDE_ENV_VARS } from '../auth-guard.js';
import type { AppConfig } from '../config.js';
import { renderMarkImage } from '../ingest/extract.js';
import { HttpError } from '../services/errors.js';
import type { UserServices } from '../services/scope.js';
import type { ClaudeAuth, ClaudeCredentials } from './credentials.js';
import { classifyAssistantError, classifyErrorText } from './errors.js';
import { baseAgentOptions } from './options.js';
import { scopeOf } from '../services/threads.js';
import { buildTurnPrompt, documentScope, groupScope, SYSTEM_PROMPT } from './prompt.js';
import type { ClaudeStatusService } from './status.js';
import { buildStudyServer } from './tools.js';

type QueryFn = typeof query;

/** Upper bound on agent turns (tool round-trips) per answer. */
const MAX_TURNS = 30;

export interface TurnInput {
  threadId: string;
  clientId: string;
  text: string;
  mode: StudyMode;
  context: ChatContext;
}

class TurnError extends Error {
  constructor(
    readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Runs chat turns against Claude Code (SPEC §6.4): one session per thread, resumed on
 * every turn, streaming text and tool activity to the client as it happens. Each turn
 * runs with the services and the Claude credentials of the thread's owner.
 */
export class ChatService {
  /** Running turns by thread id (thread ids are unique across users). */
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly config: AppConfig,
    private readonly credentials: ClaudeCredentials,
    private readonly status: ClaudeStatusService,
    private readonly log: FastifyBaseLogger,
    private readonly runQuery: QueryFn = query,
  ) {}

  isRunning(threadId: string) {
    return this.running.has(threadId);
  }

  stop(threadId: string) {
    this.running.get(threadId)?.abort();
  }

  stopAll() {
    for (const ctrl of this.running.values()) ctrl.abort();
  }

  /** The caller checks that the thread is the user's (`threads.get`) before stopping it. */
  async send(
    svc: UserServices,
    input: TurnInput,
    emit: (event: ServerChatEvent) => void,
  ): Promise<void> {
    const thread = svc.threads.get(input.threadId);
    const scope = scopeOf(thread);
    const ctx = input.context;
    const scopeId =
      scope.kind === 'document' ? ctx.docId : scope.kind === 'topic' ? ctx.topicId : ctx.subjectId;
    if (scopeId !== scope.id) throw new HttpError(400, 'invalid_request');
    if (this.running.has(thread.id)) {
      emit({ type: 'error', threadId: thread.id, code: 'busy' });
      return;
    }
    const auth = this.credentials.forUser(svc.userId);
    if (!auth) {
      emit({
        type: 'error',
        threadId: thread.id,
        code: 'not_configured',
        message: 'No Claude token saved for this account.',
      });
      return;
    }
    const docId = scope.kind === 'document' ? scope.id : null;
    const scopeLines = this.describeScope(svc, scope, ctx.currentPage);

    const abort = new AbortController();
    this.running.set(thread.id, abort);
    const userMessage = svc.threads.addUserMessage(
      thread.id,
      input.text,
      input.mode,
      input.context,
    );
    emit({ type: 'user_message', clientId: input.clientId, message: userMessage });
    const assistant = svc.threads.addAssistantMessage(thread.id);
    emit({ type: 'assistant_start', threadId: thread.id, message: assistant });

    const toolEvents: ToolEvent[] = [];
    let content = '';
    const turn = {
      emitDelta: (text: string) => {
        content += text;
        emit({ type: 'assistant_delta', threadId: thread.id, messageId: assistant.id, text });
      },
    };

    const finish = (status: 'complete' | 'interrupted' | 'error', errorCode?: ChatErrorCode) => {
      const message: ChatMessage = svc.threads.finishAssistantMessage(assistant.id, {
        content,
        toolEvents,
        status,
        errorCode,
      });
      emit({ type: 'assistant_done', threadId: thread.id, message });
    };

    try {
      const markImage = docId && ctx.mark ? await this.markImage(svc, docId, ctx.mark) : null;
      const prompt = (recoveredTranscript?: string) =>
        buildTurnPrompt({
          text: input.text,
          mode: input.mode,
          context: input.context,
          scope: scopeLines,
          memory: svc.memory.contextFor(docId),
          recoveredTranscript,
          markImage: markImage !== null,
        });
      const run = (resume: string | null, recovered?: string) =>
        this.runTurn(svc, auth, {
          prompt: withImage(prompt(recovered), markImage),
          resume,
          abort,
          threadId: thread.id,
          messageId: assistant.id,
          docId: docId ?? undefined,
          scope,
          emit,
          onText: turn.emitDelta,
          onTool: (e) => toolEvents.push(e),
        });

      try {
        await run(thread.claudeSessionId);
      } catch (err) {
        // A session lost on disk (e.g. Claude's config dir was reset): start a new one
        // seeded with the recent transcript instead of failing the question.
        if (thread.claudeSessionId && !content && isMissingSession(err)) {
          this.log.warn(`Claude session ${thread.claudeSessionId} not found; starting a new one`);
          svc.threads.setClaudeSession(thread.id, null);
          await run(null, svc.threads.recentTranscript(thread.id));
        } else {
          throw err;
        }
      }
      finish('complete');
    } catch (err) {
      if (abort.signal.aborted) {
        finish('interrupted');
      } else {
        const code = err instanceof TurnError ? err.code : 'internal';
        if (code === 'internal') this.log.error(err);
        if (code === 'auth_expired' || code === 'rate_limited') {
          this.status.report(svc.userId, auth, {
            state: code,
            model: null,
            message: (err as Error).message,
          });
        }
        emit({
          type: 'error',
          threadId: thread.id,
          messageId: assistant.id,
          code,
          message: (err as Error).message,
        });
        finish('error', code);
      }
    } finally {
      this.running.delete(thread.id);
    }
  }

  /** Image of the area the student marked with their drawings, or null if unavailable. */
  private async markImage(
    svc: UserServices,
    docId: string,
    mark: DrawingMark,
  ): Promise<Buffer | null> {
    const strokes = svc.annotations
      .list(docId)
      .filter(
        (a) => a.type === 'drawing' && a.page === mark.page && mark.annotationIds.includes(a.id),
      )
      .flatMap((a) => (a.anchor as DrawingAnchor).strokes);
    if (!strokes.length) return null;
    try {
      const row = svc.library.getLive(docId);
      return (await renderMarkImage(row.filePath, mark.page, mark.rect, strokes)).png;
    } catch (err) {
      this.log.warn({ err }, 'Could not render the marked area; asking without the image');
      return null;
    }
  }

  /** Context lines describing what the conversation is about. */
  private describeScope(svc: UserServices, scope: ThreadScope, currentPage?: number): string[] {
    if (scope.kind === 'document') return documentScope(svc.library.detail(scope.id), currentPage);
    const tree = svc.library.tree();
    if (scope.kind === 'topic') {
      for (const s of tree.subjects) {
        const topic = s.topics.find((t) => t.id === scope.id);
        if (topic)
          return groupScope('topic', `${topic.name}" (subject "${s.name}`, topic.documents);
      }
    } else {
      const subject = tree.subjects.find((s) => s.id === scope.id);
      if (subject) {
        const docs = subject.topics.flatMap((t) =>
          t.documents.map((d) => ({ ...d, topicName: t.name })),
        );
        return groupScope('subject', subject.name, docs);
      }
    }
    throw new HttpError(404, 'not_found');
  }

  private async runTurn(
    svc: UserServices,
    auth: ClaudeAuth,
    t: {
      prompt: string | AsyncIterable<SDKUserMessage>;
      resume: string | null;
      abort: AbortController;
      threadId: string;
      messageId: string;
      docId?: string;
      scope: ThreadScope;
      emit: (event: ServerChatEvent) => void;
      onText: (text: string) => void;
      onTool: (event: ToolEvent) => void;
    },
  ) {
    const { server, allowedTools } = buildStudyServer(svc, {
      threadId: t.threadId,
      messageId: t.messageId,
      docId: t.docId,
      scope: t.scope,
      emit: t.emit,
      record: t.onTool,
    });
    const q = this.runQuery({
      prompt: t.prompt,
      options: {
        ...baseAgentOptions(this.config, auth),
        ...(svc.settings.claudeModel() ? { model: svc.settings.claudeModel()! } : {}),
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: { [server.name]: server },
        allowedTools,
        includePartialMessages: true,
        maxTurns: MAX_TURNS,
        abortController: t.abort,
        ...(t.resume ? { resume: t.resume } : {}),
      },
    });

    // Text arrives as stream deltas; separate text blocks (before/after tool calls)
    // are joined with a blank line.
    let textBlocks = 0;
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        if ((FORBIDDEN_CLAUDE_ENV_VARS as readonly string[]).includes(msg.apiKeySource)) {
          throw new TurnError(
            'auth_expired',
            'Claude Code is using an API key, not the subscription.',
          );
        }
        if (msg.session_id !== t.resume) svc.threads.setClaudeSession(t.threadId, msg.session_id);
      } else if (msg.type === 'stream_event' && msg.parent_tool_use_id === null) {
        const ev = msg.event;
        if (ev.type === 'content_block_start' && ev.content_block.type === 'text') {
          if (textBlocks++ > 0) t.onText('\n\n');
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          t.onText(ev.delta.text);
        }
      } else if (msg.type === 'rate_limit_event' && msg.rate_limit_info.status === 'rejected') {
        throw new TurnError('rate_limited', 'Usage limit reached.');
      } else if (msg.type === 'assistant' && msg.error) {
        const state = classifyAssistantError(msg.error);
        throw new TurnError(
          state === 'auth_expired' || state === 'rate_limited' ? state : 'internal',
          msg.error,
        );
      } else if (msg.type === 'result') {
        if (msg.subtype === 'success' && !msg.is_error) return;
        const detail = msg.subtype === 'success' ? msg.result : msg.errors.join('; ');
        if (msg.subtype === 'error_max_turns') return; // keep what was written so far
        const state = classifyErrorText(detail);
        throw new TurnError(
          state === 'auth_expired' || state === 'rate_limited' ? state : 'internal',
          detail,
        );
      }
    }
  }
}

/** The turn prompt, as a user message with an image block when there is one. */
function withImage(text: string, png: Buffer | null): string | AsyncIterable<SDKUserMessage> {
  if (!png) return text;
  const message: SDKUserMessage = {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
        },
        { type: 'text', text },
      ],
    },
  };
  return (async function* () {
    yield message;
  })();
}

function isMissingSession(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /no conversation found|session.*not found/i.test(text);
}
