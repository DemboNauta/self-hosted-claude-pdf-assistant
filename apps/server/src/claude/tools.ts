import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  anchorSchema,
  BOARD_WIDTH,
  boardElementSchema,
  HIGHLIGHT_KEYS,
  MEMORY_CATEGORIES,
  POINTER_SHAPES,
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  type Anchor,
  type BoardStep,
  type OutlineEntry,
  type PointerGroup,
  type PointerShape,
  type ResolvedBoardElement,
  type ServerChatEvent,
  type ThreadScope,
  type ToolEvent,
} from '@pdfclaudeassistant/shared';
import { and, asc, between, eq } from 'drizzle-orm';
import { z } from 'zod';
import { pages } from '../db/schema.js';
import { renderPageImage } from '../ingest/extract.js';
import {
  buildLayout,
  findLayoutBox,
  formatLayout,
  pageGraphics,
  type PageLayout,
} from '../ingest/layout.js';
import { pageItems } from '../services/anchoring.js';
import { newId } from '../services/ids.js';
import { checkDiagramSource, MAX_DIAGRAM_SOURCE } from '../services/diagrams.js';
import type { UserServices } from '../services/scope.js';

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
  /** Collects the marks Claude draws so they are stored with the assistant message. */
  recordPointer?: (group: PointerGroup) => void;
}

/** Page layouts by file and page: `point_at` resolves block ids against the same one. */
const layoutCache = new Map<string, PageLayout>();
const LAYOUT_CACHE_SIZE = 40;

async function cachedLayout(db: ToolDeps['db'], filePath: string, docId: string, page: number) {
  const key = `${filePath}#${page}`;
  const hit = layoutCache.get(key);
  if (hit) {
    layoutCache.delete(key);
    layoutCache.set(key, hit);
    return hit;
  }
  const layout = buildLayout(page, pageItems(db, docId, page), await pageGraphics(filePath, page));
  layoutCache.set(key, layout);
  if (layoutCache.size > LAYOUT_CACHE_SIZE) layoutCache.delete(layoutCache.keys().next().value!);
  return layout;
}

/** A `point_at` anchor: the shared ones plus a block of `get_page_layout`. */
const toolAnchorSchema = z.union([
  anchorSchema,
  z.object({
    kind: z.literal('block'),
    id: z
      .string()
      .regex(/^[bf]\d{1,3}(\.\d{1,2})?$/)
      .describe('Id from get_page_layout: "b3" (text block), "f1" (figure), "f1.2" (label)'),
  }),
]);
type ToolAnchor = z.infer<typeof toolAnchorSchema>;

/** The services of the user whose turn this is: tools only see that user's data. */
export type ToolDeps = Pick<
  UserServices,
  | 'db'
  | 'library'
  | 'search'
  | 'annotations'
  | 'settings'
  | 'memory'
  | 'review'
  | 'diagrams'
  | 'whiteboards'
>;

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
  run: (args: A, extra: Pick<ToolEvent, 'annotationIds'>) => Promise<CallToolResult>,
) {
  return async (args: A): Promise<CallToolResult> => {
    const event: ToolEvent = { id: newId(), name, summary: summarize(args), status: 'running' };
    ctx.emit({ type: 'tool_event', threadId: ctx.threadId, messageId: ctx.messageId, event });
    let result: CallToolResult;
    const extra: Pick<ToolEvent, 'annotationIds'> = {};
    try {
      result = await run(args, extra);
    } catch (err) {
      result = fail(err instanceof Error ? err.message : String(err));
    }
    const done: ToolEvent = { ...event, ...extra, status: result.isError ? 'error' : 'done' };
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
      [
        'Rendered image of one page, for figures, diagrams, tables and formulas.',
        'Pass "region" (page fractions, origin top-left) to zoom into part of the page, and "grid": true to overlay labelled coordinates in page fractions:',
        'use them to place point_at rect anchors precisely on parts of a figure (zoom into the figure with the grid first, then read the coordinates off the image).',
      ].join(' '),
      {
        docId: z.string(),
        page: z.number().int().min(1),
        region: z
          .object({
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            w: z.number().min(0.02).max(1),
            h: z.number().min(0.02).max(1),
          })
          .optional(),
        grid: z.boolean().optional(),
      },
      tracked(
        ctx,
        'get_page_image',
        ({ page }) => `p. ${page}`,
        async ({ docId, page, region, grid }) => {
          const doc = docOrError(docId);
          if (!doc) return fail(`Unknown document ${docId}.`);
          if (doc.pageCount && page > doc.pageCount)
            return fail(`The document has ${doc.pageCount} pages.`);
          const row = library.getLive(docId);
          // Keep the region inside the page.
          const r = region && {
            x: region.x,
            y: region.y,
            w: Math.min(region.w, 1 - region.x),
            h: Math.min(region.h, 1 - region.y),
          };
          const img = await renderPageImage(row.filePath, page, { region: r, grid });
          const f = (n: number) => n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
          const where = r
            ? ` Region x ${f(r.x)}–${f(r.x + r.w)}, y ${f(r.y)}–${f(r.y + r.h)} of the page.`
            : '';
          const coords = grid
            ? ' Grid labels are page fractions (x from the left, y from the top).'
            : '';
          return {
            content: [
              { type: 'image', data: img.png.toString('base64'), mimeType: 'image/png' },
              {
                type: 'text',
                text: `Page ${page} of "${doc.title}" (${img.width}×${img.height}px).${where}${coords}`,
              },
            ],
          };
        },
      ),
    ),

    tool(
      'get_page_layout',
      [
        'Structure of one page: text blocks (headings, paragraphs) and figures (images, vector diagrams, charts, tables) with the text labels inside them, each with an id and its exact box in page fractions.',
        'Use it before pointing at a figure, a formula block or a paragraph: pass the ids to point_at as {"kind":"block","id":"f1"} instead of guessing coordinates, and a figure box as get_page_image "region" to look at it.',
      ].join(' '),
      { docId: z.string(), page: z.number().int().min(1) },
      tracked(
        ctx,
        'get_page_layout',
        ({ page }) => `p. ${page}`,
        async ({ docId, page }) => {
          const doc = docOrError(docId);
          if (!doc) return fail(`Unknown document ${docId}.`);
          if (doc.pageCount && page > doc.pageCount)
            return fail(`The document has ${doc.pageCount} pages.`);
          const row = library.getLive(docId);
          return text(formatLayout(await cachedLayout(db, row.filePath, docId, page)));
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
  let marks = 0;
  return [
    tool(
      'point_at',
      [
        'Draw temporary marks on a page of the PDF while you explain: arrow, circle, rect (box), highlight, label, number (a numbered badge: label "1", "2"… to number the steps of a process or the parts of a figure) or callout (a speech bubble with the label, placed beside the passage and linked to it: a short explanation right on the page).',
        'Each shape has an anchor: {"kind":"block","id":"f1"} with an id from get_page_layout (most precise for figures, formulas, labels and paragraphs), {"kind":"text","quote":"exact words from the page"} (2 to 12 consecutive words copied verbatim, add "occurrence" when the words repeat on the page) or {"kind":"rect","x":0.1,"y":0.2,"w":0.3,"h":0.1} in page fractions (origin top-left), e.g. read off get_page_image with "grid".',
        'An arrow with "to" (another anchor) connects two parts, e.g. one state of a diagram to the next.',
        'Use "label" for a short note shown next to the mark (for callout it is the bubble text, one or two short sentences).',
        'The call returns a mark id (m1, m2…). Write [[mark:ID]] in your answer at the start of the sentence that talks about those marks: they appear on the page at that moment of the explanation (also when it is spoken) and the student can click it later to see them again.',
        'To walk through a figure step by step, call point_at once per step first, then explain each step with its [[mark:ID]].',
        'Marks without a reference in the answer appear when it ends. Set "now": true to show them immediately instead. The viewer jumps to the page when they appear.',
      ].join(' '),
      {
        docId: z.string().optional().describe('Default: the open document'),
        page: z.number().int().min(1),
        shapes: z
          .array(
            z.object({
              type: z.enum(POINTER_SHAPES),
              anchor: toolAnchorSchema,
              to: toolAnchorSchema.optional(),
              label: z.string().max(200).optional(),
            }),
          )
          .min(1)
          .max(12),
        now: z.boolean().optional(),
      },
      tracked(
        ctx,
        'point_at',
        ({ page }) => `p. ${page}`,
        async ({ docId, page, shapes, now }) => {
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

          // Block ids become rectangles here, so the client and saved marks need no layout.
          let layout: PageLayout | null = null;
          const resolve = async (a: ToolAnchor): Promise<Anchor | string> => {
            if (a.kind !== 'block') return a;
            layout ??= await cachedLayout(deps.db, deps.library.getLive(id).filePath, id, page);
            const box = findLayoutBox(layout, a.id);
            return box ? { kind: 'rect', ...box } : a.id;
          };
          const resolved: PointerShape[] = [];
          const unknown: string[] = [];
          for (const s of shapes) {
            const anchor = await resolve(s.anchor);
            const to = s.to ? await resolve(s.to) : undefined;
            if (typeof anchor === 'string') unknown.push(anchor);
            if (typeof to === 'string') unknown.push(to);
            if (typeof anchor === 'string' || typeof to === 'string') continue;
            resolved.push({
              type: s.type,
              anchor,
              ...(to && { to }),
              ...(s.label && { label: s.label }),
            });
          }
          if (unknown.length) {
            return fail(
              `Unknown block id(s) on page ${page}: ${unknown.join(', ')}. Call get_page_layout for this page and use its ids.`,
            );
          }

          const group: PointerGroup = {
            id: `m${++marks}`,
            messageId: ctx.messageId,
            docId: id,
            page,
            shapes: resolved,
            ...(now ? {} : { deferred: true }),
          };
          ctx.emit({ type: 'pointer', threadId: ctx.threadId, group });
          ctx.recordPointer?.(group);
          const n = `${resolved.length} mark${resolved.length > 1 ? 's' : ''}`;
          return text(
            now
              ? `Shown on page ${page} (${n}), id ${group.id}: write [[mark:${group.id}]] where you talk about it.`
              : `Mark ${group.id} ready on page ${page} (${n}). Write [[mark:${group.id}]] at the start of the sentence that explains it; it appears on the page there.`,
          );
        },
      ),
    ),
    tool(
      'go_to_page',
      'Take the student to a page (and flash a short quote on it), e.g. to show where something is explained before pointing at it. If the student has "follow Claude" on, the viewer moves; otherwise they get a button to go there. point_at already brings its page into view, so you rarely need this with it.',
      {
        docId: z.string().optional().describe('Default: the open document'),
        page: z.number().int().min(1),
        quote: z.string().max(300).optional().describe('3 to 15 words from that page to flash'),
      },
      tracked(
        ctx,
        'go_to_page',
        ({ page }) => `p. ${page}`,
        async ({ docId, page, quote }) => {
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
            type: 'navigate',
            threadId: ctx.threadId,
            docId: id,
            page,
            ...(quote && { quote }),
          });
          return text(`Showing page ${page} of "${doc.title}".`);
        },
      ),
    ),
    tool(
      'show_side_by_side',
      'Open a page next to the one the student is reading (split view): another document, or another page of the same one, to compare or connect them. You can then point_at on it with its docId and page. On small screens the student gets a button to open it instead.',
      {
        docId: z.string().optional().describe('Default: the open document'),
        page: z.number().int().min(1),
      },
      tracked(
        ctx,
        'show_side_by_side',
        ({ page }) => `p. ${page}`,
        async ({ docId, page }) => {
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
          ctx.emit({ type: 'navigate', threadId: ctx.threadId, docId: id, page, side: true });
          return text(
            `Page ${page} of "${doc.title}" is open next to the reader. point_at with docId ${id} to mark things on it.`,
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
      [
        "Highlight passages of the PDF in the student's own highlighter colours, e.g. when they ask you to highlight the most important parts of some pages or sections. The highlights are saved directly (the student can undo them from the chat).",
        `Colours and what they mean to this student: ${deps.settings
          .palette()
          .map((p) => `${p.key} = "${p.meaning}"`)
          .join(
            ', ',
          )}. Pick the colour whose meaning fits each passage (default ${deps.settings.palette()[0]?.key ?? 'yellow'}); never use a colour that describes the student's own state (not understanding, to review) unless they ask for it.`,
        'Read the pages first. Highlight selectively: the key sentence of a paragraph, a definition, the core of an example — a few per page, not whole paragraphs.',
        'Quote each passage verbatim (3 to 40 consecutive words from that page) and give a short reason.',
      ].join(' '),
      {
        docId: z.string().optional(),
        highlights: z
          .array(
            z.object({
              page: z.number().int().min(1),
              quote: z.string().min(3).max(1000),
              color: z.enum(HIGHLIGHT_KEYS).optional(),
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
        async ({ docId, highlights }, extra) => {
          const id = docId ?? ctx.docId;
          if (!id) return fail('docId is required here (no document is open).');
          deps.library.getLive(id);
          const fallback = deps.settings.palette()[0]?.key ?? 'yellow';
          const created = deps.annotations.create(
            id,
            highlights.map((h) => ({
              type: 'highlight' as const,
              page: h.page,
              color: h.color ?? fallback,
              content: h.reason ?? null,
              anchor: { quote: h.quote },
            })),
            { author: 'claude' },
          );
          // A quote not found on its page has nothing to highlight: drop it.
          const missing = created.filter((a) => !(a.anchor as { rects?: unknown[] }).rects?.length);
          if (missing.length) deps.annotations.delete(missing.map((m) => m.id));
          const kept = created.filter((a) => !missing.includes(a));
          if (kept.length) extra.annotationIds = kept.map((a) => a.id);
          changed();
          const warn = missing.length
            ? ` ${missing.length} quote(s) were not found verbatim on their page (pages ${missing
                .map((m) => m.page)
                .join(', ')}) and were not highlighted: check the exact wording and try again.`
            : '';
          return text(`Highlighted ${kept.length} passage(s).${warn}`);
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
    tool(
      'add_margin_notes',
      [
        'Propose short comments written in the margin next to passages of the PDF, like a teacher annotating a book: a clarification, a link to another idea, a warning about a common mistake, a mini example.',
        'They appear as proposals in your colour that the student accepts (they become notes) or discards.',
        'Quote each passage verbatim (3 to 40 consecutive words from the page); keep each comment brief (one or two sentences) and in the language of the student.',
      ].join(' '),
      {
        docId: z.string().optional(),
        notes: z
          .array(
            z.object({
              page: z.number().int().min(1),
              quote: z.string().min(3).max(1000),
              text: z.string().min(1).max(400),
            }),
          )
          .min(1)
          .max(20),
      },
      tracked(
        ctx,
        'add_margin_notes',
        ({ notes }) => `(${notes.length})`,
        async ({ docId, notes }) => {
          const id = docId ?? ctx.docId;
          if (!id) return fail('docId is required here (no document is open).');
          deps.library.getLive(id);
          const created = deps.annotations.create(
            id,
            notes.map((n) => ({
              type: 'note' as const,
              page: n.page,
              color: 'claude',
              content: n.text,
              anchor: { kind: 'text' as const, quote: n.quote },
            })),
            { author: 'claude', status: 'proposed' },
          );
          // A note whose passage was not found has nowhere to sit in the margin: drop it.
          const missing = created.filter((a) => !(a.anchor as { rects?: unknown[] }).rects?.length);
          if (missing.length) deps.annotations.delete(missing.map((m) => m.id));
          changed();
          const shown = created.length - missing.length;
          const warn = missing.length
            ? ` ${missing.length} quote(s) were not found verbatim on their page (pages ${missing
                .map((m) => m.page)
                .join(', ')}) and were not added: check the exact wording and propose them again.`
            : '';
          return text(
            `Proposed ${shown} margin note(s); the student can accept or discard them.${warn}`,
          );
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
      'Propose flashcards (question on the front, concise answer on the back, in the language of the document or the student) linked to the page they come from. They are shown as proposals the student accepts in the review screen. They are answered as multiple choice: give three plausible wrong answers ("wrong") in the same style and length as the right one. Ask about the subject, never about how the document is organised (what a module covers, what comes first).',
      {
        cards: z
          .array(
            z.object({
              front: z.string().min(3).max(1000),
              back: z.string().min(1).max(2000),
              wrong: z.array(z.string().min(1).max(1000)).length(3).optional(),
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
              distractors: c.wrong ?? null,
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

/** Rough box of a board element in board units, to tell Claude where there is room. */
function boardBox(e: ResolvedBoardElement): { x: number; y: number; w: number; h: number } | null {
  switch (e.type) {
    case 'text': {
      const px = { s: 16, m: 20, l: 28, xl: 36 }[e.size ?? 'm'];
      const lines = e.text.split('\n');
      const longest = Math.max(...lines.map((l) => l.length));
      return { x: e.x, y: e.y, w: longest * px * 0.55, h: lines.length * px * 1.25 };
    }
    case 'rect':
    case 'ellipse':
    case 'diamond':
    case 'pdf':
      return { x: e.x, y: e.y, w: e.w, h: e.h };
    case 'freehand':
    case 'arrow':
    case 'line': {
      const pts = e.points ?? [];
      if (!pts.length) return null;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
      };
    }
  }
}

/** Whiteboard next to the chat (visual interaction, blocks 2 and 3). */
export function whiteboardTools(deps: ToolDeps, ctx: ToolContext) {
  let steps = 0;
  return [
    tool(
      'whiteboard_view',
      'Look at the whiteboard as it is now, with what the student drew or wrote on it (a solved exercise, a sketch, a question) and what you drew. Returns an image and the board area it shows, in board units, so you can place corrections with whiteboard_draw right next to their work.',
      {},
      tracked(
        ctx,
        'whiteboard_view',
        () => '',
        async () => {
          const view = deps.whiteboards.look(ctx.threadId);
          if (!view) return text('The whiteboard is empty.');
          const { x, y, w, h } = view.bounds;
          const r = Math.round;
          return {
            content: [
              { type: 'image', data: view.png.toString('base64'), mimeType: 'image/png' },
              {
                type: 'text',
                text: `The image shows the board from x ${r(x)} to ${r(x + w)} and y ${r(y)} to ${r(y + h)} (board units; the image is scaled). To correct the student's work, draw next to it with whiteboard_draw (e.g. red marks or text), and explain the mistakes with [[mark:ID]].`,
              },
            ],
          };
        },
      ),
    ),
    tool(
      'whiteboard_draw',
      [
        `Draw on the hand-drawn whiteboard next to the chat, like a teacher at the blackboard: diagrams, worked steps, sketches of graphs, comparisons, a figure of the PDF annotated. Coordinates are board units: x from 0 to ${BOARD_WIDTH} (left to right), y from 0 downwards without limit.`,
        'Elements: text {x,y,text,size s|m|l|xl}; rect / ellipse / diamond {id,x,y,w,h,label,fill}; arrow / line {from,to} connecting element ids (or {points:[[x,y],…]}), with label and dashed; freehand {points}; pdf {page,region,x,y,w} pastes a crop of a PDF page (region in page fractions, e.g. a figure box from get_page_layout) to annotate it with arrows and text.',
        'Colours: black, blue, red, green, orange, purple, gray. Give ids to things you will connect or change later; drawing an id again replaces that element. There are no LaTeX formulas: write maths with Unicode (x², √, π, ∑, ∫, →, ≤).',
        'Each call is one step of the explanation and returns a step id (w1, w2…): write [[mark:ID]] at the start of the sentence that explains it, and it is drawn at that moment (also when spoken). Build complex drawings in several steps. "mermaid" draws a flowchart or mind map below the rest; "clear": true wipes the board first (only for a new topic).',
        'The student sees the board and may draw on it too.',
      ].join(' '),
      {
        elements: z.array(boardElementSchema).max(80).default([]),
        mermaid: z.string().max(MAX_DIAGRAM_SOURCE).optional(),
        clear: z.boolean().optional(),
      },
      tracked(
        ctx,
        'whiteboard_draw',
        () => '',
        async ({ elements, mermaid, clear }) => {
          if (!elements.length && !mermaid && !clear) return fail('Nothing to draw.');
          if (mermaid) {
            const problem = checkDiagramSource(mermaid);
            if (problem) return fail(problem);
          }
          const files: Record<string, string> = {};
          const resolved: ResolvedBoardElement[] = [];
          for (const e of elements) {
            if (e.type !== 'pdf') {
              resolved.push(e);
              continue;
            }
            const docId = e.docId ?? ctx.docId;
            if (!docId) return fail('pdf elements need docId here (no document is open).');
            let row;
            try {
              row = deps.library.getLive(docId);
            } catch {
              return fail(`Unknown document ${docId}.`);
            }
            const img = await renderPageImage(row.filePath, e.page, {
              ...(e.region && {
                region: {
                  ...e.region,
                  w: Math.min(e.region.w, 1 - e.region.x),
                  h: Math.min(e.region.h, 1 - e.region.y),
                },
              }),
              maxSide: 900,
            });
            const fileId = newId();
            files[fileId] = `data:image/png;base64,${img.png.toString('base64')}`;
            resolved.push({ ...e, docId, fileId, h: Math.round((e.w * img.height) / img.width) });
          }

          const step: BoardStep = {
            id: `w${++steps}`,
            messageId: ctx.messageId,
            ...(clear && { clear: true }),
            elements: resolved,
            ...(mermaid && { mermaid }),
            ...(Object.keys(files).length && { files }),
            createdAt: new Date().toISOString(),
          };
          deps.whiteboards.addStep(ctx.threadId, step);
          ctx.emit({ type: 'board_step', threadId: ctx.threadId, step });

          // Where the board has room, from what Claude drew since the last clear.
          const all = deps.whiteboards.get(ctx.threadId).steps;
          const since = all.slice(Math.max(0, all.map((s) => !!s.clear).lastIndexOf(true)));
          const boxes = since
            .flatMap((s) => s.elements)
            .map(boardBox)
            .filter((b): b is NonNullable<typeof b> => b !== null);
          const bottom = boxes.length ? Math.max(...boxes.map((b) => b.y + b.h)) : 0;
          const ids = since
            .flatMap((s) => s.elements)
            .map((e) => ('id' in e ? e.id : undefined))
            .filter(Boolean);
          return text(
            [
              `Step ${step.id} ready. Write [[mark:${step.id}]] at the start of the sentence that explains it.`,
              `Your drawings reach y ≈ ${Math.round(bottom)}${mermaid ? ' plus the Mermaid diagram below them' : ''}; put new things below unless they belong next to existing ones.`,
              ids.length ? `Ids on the board: ${[...new Set(ids)].join(', ')}.` : '',
            ]
              .filter(Boolean)
              .join(' '),
          );
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
    ...whiteboardTools(deps, ctx),
  ];
  return {
    server: createSdkMcpServer({ name: MCP_SERVER_NAME, version: '1.0.0', tools }),
    allowedTools: tools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`),
  };
}
