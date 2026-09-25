import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  type OutlineEntry,
  type ServerChatEvent,
  type ToolEvent,
} from '@pdfclaudeassistant/shared';
import { and, asc, between, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { pages } from '../db/schema.js';
import { renderPageImage } from '../ingest/extract.js';
import { newId } from '../services/ids.js';
import type { LibraryService } from '../services/library.js';
import type { SearchService } from '../services/search.js';

export const MCP_SERVER_NAME = 'pca';
/** Max pages returned by one `get_pages` call (SPEC §7). */
export const MAX_PAGES_PER_CALL = 10;

type CallToolResult = Awaited<ReturnType<Parameters<typeof tool>[3]>>;

/** Everything a tool call needs to know about the turn it runs in. */
export interface ToolContext {
  threadId: string;
  messageId: string;
  /** Document open in the reader (default scope for search). */
  docId: string;
  emit: (event: ServerChatEvent) => void;
  /** Collects tool events so they are stored with the assistant message. */
  record: (event: ToolEvent) => void;
}

export interface ToolDeps {
  db: Db;
  library: LibraryService;
  search: SearchService;
}

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): CallToolResult => ({
  content: [{ type: 'text', text: t }],
  isError: true,
});

function flattenOutline(items: OutlineEntry[], depth = 0, out: string[] = []): string[] {
  for (const item of items) {
    if (out.length >= 300) break;
    out.push(`${'  '.repeat(depth)}- ${item.title}${item.page ? ` (p. ${item.page})` : ''}`);
    flattenOutline(item.items, depth + 1, out);
  }
  return out;
}

/**
 * Wraps a handler so the chat shows what Claude is doing ("Leyendo p. 3–5") and the
 * event is stored with the answer. Errors become tool errors Claude can recover from.
 */
function tracked<A>(
  ctx: ToolContext,
  name: string,
  summarize: (args: A) => string,
  run: (args: A) => Promise<CallToolResult>,
) {
  return async (args: A): Promise<CallToolResult> => {
    const event: ToolEvent = { id: newId(), name, summary: summarize(args), status: 'running' };
    ctx.emit({ type: 'tool_event', threadId: ctx.threadId, messageId: ctx.messageId, event });
    let result: CallToolResult;
    try {
      result = await run(args);
    } catch (err) {
      result = fail(err instanceof Error ? err.message : String(err));
    }
    const done: ToolEvent = { ...event, status: result.isError ? 'error' : 'done' };
    ctx.emit({ type: 'tool_event', threadId: ctx.threadId, messageId: ctx.messageId, event: done });
    ctx.record(done);
    return result;
  };
}

/** Reading tools (SPEC §7 "Lectura"). */
export function readingTools(deps: ToolDeps, ctx: ToolContext) {
  const { db, library, search } = deps;
  const docOrError = (docId: string) => {
    try {
      return library.detail(docId);
    } catch {
      return null;
    }
  };

  return [
    tool(
      'get_document_info',
      'Title, page count, subject/topic and table of contents (outline) of a document.',
      { docId: z.string().describe('Document id') },
      tracked(
        ctx,
        'get_document_info',
        () => '',
        async ({ docId }) => {
          const doc = docOrError(docId);
          if (!doc) return fail(`Unknown document ${docId}.`);
          const outline = flattenOutline(doc.outline);
          return text(
            [
              `Title: ${doc.title}`,
              `Id: ${doc.id}`,
              `Pages: ${doc.pageCount ?? 'unknown'}`,
              `Subject: ${doc.subjectName ?? '-'} / Topic: ${doc.topicName ?? '-'}`,
              `Status: ${doc.status}`,
              outline.length
                ? `Outline:\n${outline.join('\n')}`
                : 'Outline: none (the PDF has no bookmarks).',
            ].join('\n'),
          );
        },
      ),
    ),

    tool(
      'get_pages',
      `Text of a range of pages (at most ${MAX_PAGES_PER_CALL} per call). Pages are 1-based.`,
      {
        docId: z.string(),
        fromPage: z.number().int().min(1),
        toPage: z.number().int().min(1),
      },
      tracked(
        ctx,
        'get_pages',
        ({ fromPage, toPage }) =>
          fromPage === toPage ? `p. ${fromPage}` : `p. ${fromPage}–${toPage}`,
        async ({ docId, fromPage, toPage }) => {
          const doc = docOrError(docId);
          if (!doc) return fail(`Unknown document ${docId}.`);
          const to = Math.min(toPage, fromPage + MAX_PAGES_PER_CALL - 1, doc.pageCount ?? toPage);
          if (to < fromPage) return fail(`The document has ${doc.pageCount} pages.`);
          const rows = db
            .select({ n: pages.pageNumber, text: pages.text })
            .from(pages)
            .where(and(eq(pages.documentId, docId), between(pages.pageNumber, fromPage, to)))
            .orderBy(asc(pages.pageNumber))
            .all();
          const body = rows
            .map(
              (r) =>
                `--- Page ${r.n} ---\n${r.text || '(no text layer on this page: try get_page_image)'}`,
            )
            .join('\n\n');
          const note =
            to < toPage ? `\n\n(Truncated at page ${to}; request the rest separately.)` : '';
          return text(`Document "${doc.title}" (${docId})\n\n${body}${note}`);
        },
      ),
    ),

    tool(
      'get_page_image',
      'Rendered image of one page, for figures, diagrams, tables and formulas.',
      { docId: z.string(), page: z.number().int().min(1) },
      tracked(
        ctx,
        'get_page_image',
        ({ page }) => `p. ${page}`,
        async ({ docId, page }) => {
          const doc = docOrError(docId);
          if (!doc) return fail(`Unknown document ${docId}.`);
          if (doc.pageCount && page > doc.pageCount)
            return fail(`The document has ${doc.pageCount} pages.`);
          const row = library.getLive(docId);
          const img = await renderPageImage(row.filePath, page);
          return {
            content: [
              { type: 'image', data: img.png.toString('base64'), mimeType: 'image/png' },
              {
                type: 'text',
                text: `Page ${page} of "${doc.title}" (${img.width}×${img.height}px).`,
              },
            ],
          };
        },
      ),
    ),

    tool(
      'search_library',
      'Full-text search. scope "doc" searches the open document, "topic"/"subject" its topic or subject, "all" the whole library. Returns document, page and a snippet with «matches».',
      {
        query: z.string().min(1).max(200),
        scope: z.enum(['doc', 'topic', 'subject', 'all']).default('doc'),
        docId: z.string().optional().describe('Document for scope "doc" (default: the open one)'),
      },
      tracked(
        ctx,
        'search_library',
        ({ query }) => `«${query}»`,
        async ({ query, scope, docId }) => {
          const doc = docOrError(docId ?? ctx.docId);
          const id =
            scope === 'doc'
              ? doc?.id
              : scope === 'topic'
                ? doc?.topicId
                : scope === 'subject'
                  ? doc?.subjectId
                  : undefined;
          if (scope !== 'all' && !id) return fail('No document/topic/subject to search in.');
          const hits = search.search({ q: query, scope, id: id ?? undefined, limit: 25 });
          if (!hits.length) return text('No results.');
          return text(
            hits
              .map(
                (h) =>
                  `- "${h.title}" (${h.docId}) p. ${h.page}: ${h.snippet
                    .replaceAll(SEARCH_MARK_START, '«')
                    .replaceAll(SEARCH_MARK_END, '»')}`,
              )
              .join('\n'),
          );
        },
      ),
    ),

    tool(
      'list_library',
      'The library tree: subjects, topics and documents with their ids and page counts.',
      {},
      tracked(
        ctx,
        'list_library',
        () => '',
        async () => {
          const tree = library.tree();
          const lines: string[] = [];
          for (const s of tree.subjects) {
            lines.push(`Subject: ${s.name}`);
            for (const tp of s.topics) {
              lines.push(`  Topic: ${tp.name}`);
              for (const d of tp.documents) {
                lines.push(`    - "${d.title}" (${d.id}, ${d.pageCount ?? '?'} pages)`);
              }
            }
          }
          return text(lines.join('\n') || 'The library is empty.');
        },
      ),
    ),
  ];
}

/** Builds the per-turn in-process MCP server and the matching tool allow-list. */
export function buildStudyServer(deps: ToolDeps, ctx: ToolContext) {
  const tools = [...readingTools(deps, ctx)];
  return {
    server: createSdkMcpServer({ name: MCP_SERVER_NAME, version: '1.0.0', tools }),
    allowedTools: tools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`),
  };
}
