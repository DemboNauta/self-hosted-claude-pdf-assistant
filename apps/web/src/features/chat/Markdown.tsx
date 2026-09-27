import {
  CITATION_RE,
  MARK_RE,
  parseCitation,
  VOICE_END,
  type Citation,
} from '@pdfclaudeassistant/shared';
import 'katex/dist/katex.min.css';
import { memo } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { DiagramEmbed } from '../diagrams/DiagramView';
import { CitationChip } from './CitationChip';
import { MarkChip, MessageIdContext } from './MarkChip';

const CITE_PREFIX = 'cite:';
const MARK_PREFIX = 'mark:';

/** Encodes a citation as a Markdown link so it survives parsing and reaches `a`. */
function citationLink(c: Citation): string {
  // Parentheses would end the Markdown link destination early.
  const q = c.quote
    ? `?q=${encodeURIComponent(c.quote).replace(/\(/g, '%28').replace(/\)/g, '%29')}`
    : '';
  return `[p. ${c.page}](${CITE_PREFIX}${c.docId}/${c.page}${q})`;
}

/**
 * Replaces `[[cite:…]]` and `[[mark:…]]` markup with links. While streaming, an
 * unfinished one at the end is hidden instead of flashing as raw markup.
 */
export function prepareMarkdown(text: string, streaming = false): string {
  let out = text
    .replace(CITATION_RE, (...m) => citationLink(parseCitation(m as unknown as RegExpMatchArray)))
    .replace(MARK_RE, (_, id: string) => `[→](${MARK_PREFIX}${id})`)
    .replaceAll(VOICE_END, '');
  if (streaming) {
    out = out.replace(/\[\[v[a-z-]*\]?$/, '');
    out = out.replace(/\[\[?(c(i(t(e(:[^\]]*)?)?)?)?)?$/, '');
    out = out.replace(/\[\[d[a-z]*(:[0-9a-z]*)?\]?$/, '');
    out = out.replace(/\[\[m[a-z]*(:[0-9a-z]*)?\]?$/, '');
  }
  return out;
}

export function parseCiteHref(href: string): Citation | null {
  if (!href.startsWith(CITE_PREFIX)) return null;
  const [path, query] = href.slice(CITE_PREFIX.length).split('?');
  const [docId, page] = (path ?? '').split('/');
  if (!docId || !page) return null;
  const quote = query ? (new URLSearchParams(query).get('q') ?? undefined) : undefined;
  return { docId, page: Number(page), ...(quote ? { quote } : {}) };
}

const components: Components = {
  a: ({ href, children }) => {
    if (href?.startsWith(MARK_PREFIX)) return <MarkChip markId={href.slice(MARK_PREFIX.length)} />;
    const cite = href ? parseCiteHref(href) : null;
    if (cite) return <CitationChip citation={cite} />;
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className="underline">
        {children}
      </a>
    );
  },
};

/** `[[diagram:ID]]` split out, so a diagram is a block and never sits inside a paragraph. */
const DIAGRAM_SPLIT = /(\[\[diagram:[0-9a-z]{1,64}\]\])/;
const DIAGRAM_ONE = /^\[\[diagram:([0-9a-z]{1,64})\]\]$/;

/**
 * Chat message body: GFM Markdown, KaTeX maths, citation chips (F-CHAT-04/05), the
 * diagrams Claude made (`[[diagram:ID]]`) and chips for its marks on the PDF
 * (`[[mark:ID]]`, needs `messageId`).
 */
export const Markdown = memo(function Markdown({
  text,
  streaming,
  messageId,
}: {
  text: string;
  streaming?: boolean;
  /** The chat answer this is, so `[[mark:ID]]` chips can show its marks again. */
  messageId?: string;
}) {
  const parts = text.split(DIAGRAM_SPLIT);
  return (
    <MessageIdContext.Provider value={messageId ?? null}>
      <div className="chat-markdown">
        {parts.map((part, i) => {
          const diagram = DIAGRAM_ONE.exec(part);
          if (diagram) return <DiagramEmbed key={i} id={diagram[1]!} />;
          if (!part.trim()) return null;
          return (
            <ReactMarkdown
              key={i}
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={components}
              urlTransform={(url) =>
                url.startsWith(CITE_PREFIX) || url.startsWith(MARK_PREFIX)
                  ? url
                  : defaultUrlTransform(url)
              }
            >
              {prepareMarkdown(part, streaming && i === parts.length - 1)}
            </ReactMarkdown>
          );
        })}
      </div>
    </MessageIdContext.Provider>
  );
});
