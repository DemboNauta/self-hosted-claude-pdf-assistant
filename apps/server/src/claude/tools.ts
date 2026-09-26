import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  MEMORY_CATEGORIES,
  pointerShapeSchema,
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  type OutlineEntry,
  type ServerChatEvent,
  type ThreadScope,
  type ToolEvent,
} from '@pdfclaudeassistant/shared';
import { and, asc, between, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { pages } from '../db/schema.js';
import { renderPageImage } from '../ingest/extract.js';
import { newId } from '../services/ids.js';
import type { AnnotationService } from '../services/annotations.js';
import {
  checkDiagramSource,
  MAX_DIAGRAM_SOURCE,
  type DiagramService,
} from '../services/diagrams.js';
import type { LibraryService } from '../services/library.js';
import type { MemoryService } from '../services/memory.js';
import type { ReviewService } from '../services/review.js';
import type { SearchService } from '../services/search.js';
import type { SettingsService } from '../services/settings.js';

export const MCP_SERVER_NAME = 'pca';
/** Max pages returned by one `get_pages` call (SPEC §7). */
export const MAX_PAGES_PER_CALL = 10;

type CallToolResult = Awaited<ReturnType<Parameters<typeof tool>[3]>>;

/** Everything a tool call needs to know about the turn it runs in. */
export interface ToolContext {
  threadId: string;
  messageId: string;
  /** Document open in the reader; absent in topic/subject chats (F-CHAT-08). */
  docId?: string;
  /** What the conversation is about (default search scope). */
  scope: ThreadScope;
  emit: (event: ServerChatEvent) => void;
  /** Collects tool events so they are stored with the assistant message. */
  record: (event: ToolEvent) => void;
}

export interface ToolDeps {
  db: Db;
  library: LibraryService;
  search: SearchService;
  annotations: AnnotationService;
  settings: SettingsService;
  memory: MemoryService;
  review: ReviewService;
  diagrams: DiagramService;
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
        docId: z
          .string()
          .optional()
          .describe(
            'Document for scope "doc" (default: the open one; required in topic/subject chats)',
          ),
      },
      tracked(
        ctx,
        'search_library',
        ({ query }) => `«${query}»`,
        async ({ query, scope, docId }) => {
          const doc = (docId ?? ctx.docId) ? docOrError((docId ?? ctx.docId)!) : null;
          const id =
            scope === 'doc'
              ? doc?.id
              : scope === 'topic'
                ? (doc?.topicId ?? (ctx.scope.kind === 'topic' ? ctx.scope.id : undefined))
                : scope === 'subject'
                  ? (doc?.subjectId ?? (ctx.scope.kind === 'subject' ? ctx.scope.id : undefined))
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

/** Ephemeral "teacher's pointer" marks on the page (F-POINT-01..05). */
export function pointerTools(deps: ToolDeps, ctx: ToolContext) {
  return [
    tool(
      'point_at',
      [
        'Draw temporary marks on a page of the PDF while you explain: arrow, circle, rect (box), highlight or label.',
        'Each shape has an anchor: {"kind":"text","quote":"exact words from the page"} (preferred; 2 to 12 consecutive words copied verbatim, add "occurrence" when the words repeat on the page) or {"kind":"rect","x":0.1,"y":0.2,"w":0.3,"h":0.1} in page fractions (origin top-left) for figures.',
        'Use "label" for a short note shown next to the mark. The viewer jumps to the page. Marks disappear when the student sends the next message.',
      ].join(' '),
      {
        docId: z.string().optional().describe('Default: the open document'),
        page: z.number().int().min(1),
        shapes: z.array(pointerShapeSchema).min(1).max(12),
      },
      tracked(
        ctx,
        'point_at',
        ({ page }) => `p. ${page}`,
        async ({ docId, page, shapes }) => {
          const id = docId ?? ctx.docId;
          if (!id) return fail('docId is required here (no document is open).');
          let doc;
          try {
            doc = deps.library.detail(id);
          } catch {
            return fail(`Unknown document ${id}.`);
          }
          if (doc.pageCount && page > doc.pageCount)
            return fail(`The document has ${doc.pageCount} pages.`);
          ctx.emit({
            type: 'pointer',
            threadId: ctx.threadId,
            group: { messageId: ctx.messageId, docId: id, page, shapes },
          });
          return text(
            `Shown on page ${page} (${shapes.length} mark${shapes.length > 1 ? 's' : ''}).`,
          );
        },
      ),
    ),
    tool(
      'clear_pointers',
      'Remove every temporary mark you drew on the PDF.',
      {},
      tracked(
        ctx,
        'clear_pointers',
        () => '',
        async () => {
          ctx.emit({ type: 'clear_pointers', threadId: ctx.threadId });
          return text('Cleared.');
        },
      ),
    ),
  ];
}

/** Annotations: read the student's marks, propose key-idea highlights, add notes (F-ANN-04). */
export function annotationTools(deps: ToolDeps, ctx: ToolContext) {
  const changed = () =>
    ctx.emit({ type: 'data_changed', threadId: ctx.threadId, scope: 'annotations' });
  return [
    tool(
      'get_annotations',
      "The student's highlights (with the meaning of each colour) and notes on a document, plus your saved marks. Red highlights usually mean the student does not understand that passage.",
      {
        docId: z.string().optional(),
        fromPage: z.number().int().min(1).optional(),
        toPage: z.number().int().min(1).optional(),
      },
      tracked(
        ctx,
        'get_annotations',
        () => '',
        async ({ docId, fromPage, toPage }) => {
          const id = docId ?? ctx.docId;
          if (!id) return fail('docId is required here (no document is open).');
          const meanings = new Map<string, string>(
            deps.settings.palette().map((p) => [p.key, p.meaning]),
          );
          meanings.set('claude', 'Claude');
          const items = deps.annotations
            .list(id)
            .filter((a) => (!fromPage || a.page >= fromPage) && (!toPage || a.page <= toPage))
            .filter((a) => a.type === 'highlight' || a.type === 'note');
          if (!items.length) return text('No highlights or notes.');
          return text(
            items
              .slice(0, 300)
              .map((a) => {
                const quote = (a.anchor as { quote?: string }).quote;
                const who =
                  a.author === 'claude'
                    ? `Claude${a.status === 'proposed' ? ' (proposed)' : ''}`
                    : 'student';
                const kind =
                  a.type === 'note' ? 'note' : `highlight "${meanings.get(a.color) ?? a.color}"`;
                const q = quote ? `: "${quote.slice(0, 300)}"` : '';
                const c = a.content ? ` — ${a.content.slice(0, 500)}` : '';
                return `- p. ${a.page} ${kind} by ${who}${q}${c}`;
              })
              .join('\n'),
          );
        },
      ),
    ),
    tool(
      'highlight_key_ideas',
      'Propose highlights of the key ideas (of a page, chapter or the document). They appear in your colour as proposals the student accepts or discards. Quote each idea verbatim (3 to 40 consecutive words from the page) and give a short reason.',
      {
        docId: z.string().optional(),
        highlights: z
          .array(
            z.object({
              page: z.number().int().min(1),
              quote: z.string().min(3).max(1000),
              reason: z.string().max(300).optional(),
            }),
          )
          .min(1)
          .max(60),
      },
      tracked(
        ctx,
        'highlight_key_ideas',
        ({ highlights }) => `(${highlights.length})`,
        async ({ docId, highlights }) => {
          const id = docId ?? ctx.docId;
          if (!id) return fail('docId is required here (no document is open).');
          deps.library.getLive(id);
          const created = deps.annotations.create(
            id,
            highlights.map((h) => ({
              type: 'highlight' as const,
              page: h.page,
              color: 'claude',
              content: h.reason ?? null,
              anchor: { quote: h.quote },
            })),
            { author: 'claude', status: 'proposed' },
          );
          changed();
          const missing = created.filter((a) => !(a.anchor as { rects?: unknown[] }).rects?.length);
          const warn = missing.length
            ? ` ${missing.length} quote(s) were not found verbatim on their page (pages ${missing
                .map((m) => m.page)
                .join(', ')}): check the exact wording and propose them again.`
            : '';
          return text(
            `Proposed ${created.length} highlight(s); the student can accept or discard them.${warn}`,
          );
        },
      ),
    ),
    tool(
      'add_note',
      'Add a sticky note on a page, anchored to a point (x, y page fractions) or to an exact quote.',
      {
        docId: z.string().optional(),
        page: z.number().int().min(1),
        text: z.string().min(1).max(4000),
        quote: z.string().max(1000).optional(),
        x: z.number().min(0).max(1).optional(),
        y: z.number().min(0).max(1).optional(),
      },
      tracked(
        ctx,
        'add_note',
        ({ page }) => `p. ${page}`,
        async ({ docId, page, text: body, quote, x, y }) => {
          const id = docId ?? ctx.docId;
          if (!id) return fail('docId is required here (no document is open).');
          deps.library.getLive(id);
          deps.annotations.create(
            id,
            [
              {
                type: 'note',
                page,
                color: 'claude',
                content: body,
                anchor: quote
                  ? { kind: 'text', quote }
                  : { kind: 'point', x: x ?? 0.92, y: y ?? 0.08 },
              },
            ],
            { author: 'claude' },
          );
          changed();
          return text('Note added.');
        },
      ),
    ),
  ];
}

/**
 * Memory tools (SPEC §7 "Memoria"): Claude writes short, de-duplicated notes about
 * the student and records difficult concepts and exam results.
 */
export function memoryTools(deps: ToolDeps, ctx: ToolContext) {
  const changed = () => ctx.emit({ type: 'data_changed', threadId: ctx.threadId, scope: 'memory' });
  const { memory } = deps;
  return [
    tool(
      'remember',
      [
        'Save something worth remembering about the student, concisely (one sentence, in Spanish).',
        'scope "global": preferences and way of studying (e.g. prefers practical examples); scope "document": what they read, understood, doubts solved, pending points.',
        'Do not save whole conversations or trivia. Pass replaceId (the [id] shown in your memory) to update an item instead of adding a new one.',
      ].join(' '),
      {
        scope: z.enum(['global', 'document']),
        docId: z.string().optional(),
        category: z.enum(MEMORY_CATEGORIES),
        content: z.string().min(3).max(500),
        replaceId: z.string().optional(),
      },
      tracked(
        ctx,
        'remember',
        () => '',
        async ({ scope, docId, category, content, replaceId }) => {
          const r = memory.remember({
            scope,
            documentId: scope === 'document' ? (docId ?? ctx.docId ?? null) : null,
            category,
            content,
            replaceId,
          });
          changed();
          return text(r.action === 'updated' ? `Updated memory ${r.id}.` : `Saved as ${r.id}.`);
        },
      ),
    ),
    tool(
      'mark_concept_difficult',
      'Record that the student struggles with a concept (a failed answer, a repeated question, a passage marked in red). Use a short, canonical concept name.',
      {
        concept: z.string().min(2).max(120),
        docId: z.string().optional(),
        page: z.number().int().min(1).optional(),
        evidence: z.string().min(3).max(500),
      },
      tracked(
        ctx,
        'mark_concept_difficult',
        ({ concept }) => `«${concept}»`,
        async (a) => {
          const id = memory.markDifficult({
            concept: a.concept,
            documentId: a.docId ?? ctx.docId ?? null,
            page: a.page ?? null,
            evidence: a.evidence,
          });
          changed();
          return text(`Concept recorded (${id}).`);
        },
      ),
    ),
    tool(
      'update_concept_mastery',
      'Raise or lower the mastery (0–1) of a difficult concept by delta (e.g. +0.15 after a good explanation back, -0.1 after confusion).',
      {
        conceptId: z.string(),
        delta: z.number().min(-1).max(1),
        evidence: z.string().min(3).max(500),
      },
      tracked(
        ctx,
        'update_concept_mastery',
        () => '',
        async ({ conceptId, delta, evidence }) => {
          try {
            const m = memory.updateMastery(conceptId, delta, evidence);
            changed();
            return text(`Mastery now ${m.toFixed(2)}.`);
          } catch {
            return fail(`Unknown concept ${conceptId}.`);
          }
        },
      ),
    ),
    tool(
      'update_progress',
      'Note what the student has covered in a document (pages, sections, what is left).',
      { docId: z.string().optional(), note: z.string().min(3).max(500) },
      tracked(
        ctx,
        'update_progress',
        () => '',
        async ({ docId, note }) => {
          memory.remember({
            scope: 'document',
            documentId: docId ?? ctx.docId ?? null,
            category: 'progress',
            content: note,
          });
          changed();
          return text('Progress noted.');
        },
      ),
    ),
    tool(
      'record_exam_result',
      'Record the evaluation of one exam answer (exam mode). Failed concepts become difficult concepts; correct answers raise their mastery.',
      {
        docId: z.string().optional(),
        question: z.string().min(3).max(2000),
        userAnswer: z.string().max(4000),
        correct: z.boolean(),
        concepts: z.array(z.string().min(2).max(120)).max(10),
        page: z.number().int().min(1).optional(),
      },
      tracked(
        ctx,
        'record_exam_result',
        ({ correct }) => (correct ? '✓' : '✗'),
        async (a) => {
          memory.recordExam({
            documentId: a.docId ?? ctx.docId ?? null,
            question: a.question,
            userAnswer: a.userAnswer,
            correct: a.correct,
            concepts: a.concepts,
            page: a.page ?? null,
          });
          changed();
          return text('Result recorded.');
        },
      ),
    ),
  ];
}

/** Flashcards proposed by Claude (F-REV-01), accepted by the student in Repaso. */
export function reviewTools(deps: ToolDeps, ctx: ToolContext) {
  return [
    tool(
      'create_flashcards',
      'Propose flashcards (question on the front, concise answer on the back, in the language of the document or the student) linked to the page they come from. They are shown as proposals the student accepts in the review screen.',
      {
        cards: z
          .array(
            z.object({
              front: z.string().min(3).max(1000),
              back: z.string().min(1).max(2000),
              page: z.number().int().min(1).optional(),
              docId: z.string().optional(),
            }),
          )
          .min(1)
          .max(40),
      },
      tracked(
        ctx,
        'create_flashcards',
        ({ cards }) => `(${cards.length})`,
        async ({ cards }) => {
          const created = deps.review.create(
            cards.map((c) => ({
              front: c.front,
              back: c.back,
              page: c.page ?? null,
              documentId: c.docId ?? ctx.docId ?? null,
            })),
            'claude',
            'proposed',
          );
          ctx.emit({ type: 'data_changed', threadId: ctx.threadId, scope: 'flashcards' });
          return text(`Proposed ${created.length} flashcard(s).`);
        },
      ),
    ),
  ];
}

/** Visual schemas (diagrams) of a document or part of it, stored as Mermaid. */
export function diagramTools(deps: ToolDeps, ctx: ToolContext) {
  const changed = () =>
    ctx.emit({ type: 'data_changed', threadId: ctx.threadId, scope: 'diagrams' });
  const mermaid = z
    .string()
    .min(10)
    .max(MAX_DIAGRAM_SOURCE)
    .describe('Mermaid source: "mindmap", "flowchart TD" or "flowchart LR" on the first line');
  const placeHint = (id: string) =>
    `Write [[diagram:${id}]] on its own line in your answer where the diagram should appear.`;

  return [
    tool(
      'create_diagram',
      'Save a visual schema (Mermaid mind map, tree or flowchart) of a document, a page range or a passage. It is shown in the chat where you write [[diagram:ID]] and kept in the student\'s "Esquemas". Use update_diagram instead to change an existing one.',
      {
        title: z.string().min(1).max(200),
        mermaid,
        fromPage: z.number().int().min(1).optional(),
        toPage: z.number().int().min(1).optional(),
        docId: z.string().optional().describe('Default: the open document'),
      },
      tracked(
        ctx,
        'create_diagram',
        ({ title }) => title,
        async ({ title, mermaid: source, fromPage, toPage, docId }) => {
          const problem = checkDiagramSource(source);
          if (problem) return fail(problem);
          const documentId = docId ?? ctx.docId ?? null;
          if (documentId) deps.library.getLive(documentId);
          const d = deps.diagrams.create({
            documentId,
            title,
            source,
            fromPage: fromPage ?? null,
            toPage: toPage ?? fromPage ?? null,
          });
          changed();
          return text(`Saved diagram ${d.id}. ${placeHint(d.id)}`);
        },
      ),
    ),
    tool(
      'update_diagram',
      'Replace an existing diagram (by id) when the student asks for changes: expand a branch, simplify, fix something. It keeps its place in "Esquemas".',
      { id: z.string().min(1).max(64), mermaid, title: z.string().min(1).max(200).optional() },
      tracked(
        ctx,
        'update_diagram',
        ({ title }) => title ?? '',
        async ({ id, mermaid: source, title }) => {
          const problem = checkDiagramSource(source);
          if (problem) return fail(problem);
          try {
            deps.diagrams.update(id, { source, ...(title ? { title } : {}) });
          } catch {
            return fail(`Unknown diagram ${id}.`);
          }
          changed();
          return text(`Updated diagram ${id}. ${placeHint(id)}`);
        },
      ),
    ),
  ];
}

/** Builds the per-turn in-process MCP server and the matching tool allow-list. */
export function buildStudyServer(deps: ToolDeps, ctx: ToolContext) {
  const tools = [
    ...readingTools(deps, ctx),
    ...pointerTools(deps, ctx),
    ...annotationTools(deps, ctx),
    ...memoryTools(deps, ctx),
    ...reviewTools(deps, ctx),
    ...diagramTools(deps, ctx),
  ];
  return {
    server: createSdkMcpServer({ name: MCP_SERVER_NAME, version: '1.0.0', tools }),
    allowedTools: tools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`),
  };
}
