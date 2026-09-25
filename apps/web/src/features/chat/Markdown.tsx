import { CITATION_RE, parseCitation, type Citation } from '@pdfclaudeassistant/shared';
import 'katex/dist/katex.min.css';
import { memo } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { CitationChip } from './CitationChip';

const CITE_PREFIX = 'cite:';

/** Encodes a citation as a Markdown link so it survives parsing and reaches `a`. */
function citationLink(c: Citation): string {
  // Parentheses would end the Markdown link destination early.
  const q = c.quote
    ? `?q=${encodeURIComponent(c.quote).replace(/\(/g, '%28').replace(/\)/g, '%29')}`
    : '';
  return `[p. ${c.page}](${CITE_PREFIX}${c.docId}/${c.page}${q})`;
}

/**
 * Replaces `[[cite:…]]` markup with links. While streaming, an unfinished citation at
 * the end is hidden instead of flashing as raw markup.
 */
export function prepareMarkdown(text: string, streaming = false): string {
  let out = text.replace(CITATION_RE, (...m) =>
    citationLink(parseCitation(m as unknown as RegExpMatchArray)),
  );
  if (streaming) out = out.replace(/\[\[?(c(i(t(e(:[^\]]*)?)?)?)?)?$/, '');
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
    const cite = href ? parseCiteHref(href) : null;
    if (cite) return <CitationChip citation={cite} />;
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className="underline">
        {children}
      </a>
    );
  },
};

/** Chat message body: GFM Markdown, KaTeX maths and citation chips (F-CHAT-04/05). */
export const Markdown = memo(function Markdown({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components}
        urlTransform={(url) => (url.startsWith(CITE_PREFIX) ? url : defaultUrlTransform(url))}
      >
        {prepareMarkdown(text, streaming)}
      </ReactMarkdown>
    </div>
  );
});
