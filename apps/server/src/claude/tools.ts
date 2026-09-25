import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  pointerShapeSchema,
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
import type { AnnotationService } from '../services/annotations.js';
import type { LibraryService } from '../services/library.js';
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
  annotations: AnnotationService;
  settings: SettingsService;
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

/** Builds the per-turn in-process MCP server and the matching tool allow-list. */
export function buildStudyServer(deps: ToolDeps, ctx: ToolContext) {
  const tools = [
    ...readingTools(deps, ctx),
    ...pointerTools(deps, ctx),
    ...annotationTools(deps, ctx),
  ];
  return {
    server: createSdkMcpServer({ name: MCP_SERVER_NAME, version: '1.0.0', tools }),
    allowedTools: tools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`),
  };
}
