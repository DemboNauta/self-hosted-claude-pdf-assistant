import { describe, expect, it } from 'vitest';
import { parseCiteHref, prepareMarkdown } from './Markdown';

describe('citations in chat messages', () => {
  it('turns citation markup into links that round-trip', () => {
    const md = prepareMarkdown(
      'Ocurre en los cloroplastos [[cite:ab12:3|"los cloroplastos (plastos)"]].',
    );
    const href = /\]\((cite:[^)]+)\)/.exec(md)![1]!;
    expect(md).toContain('[p. 3](cite:');
    expect(parseCiteHref(href)).toEqual({
      docId: 'ab12',
      page: 3,
      quote: 'los cloroplastos (plastos)',
    });
    expect(parseCiteHref(prepareMarkdown('[[cite:x9:12]]').slice(8, -1))).toEqual({
      docId: 'x9',
      page: 12,
    });
  });

  it('hides an unfinished citation while streaming', () => {
    expect(prepareMarkdown('Texto [[cite:ab12:3|"los clo', true)).toBe('Texto ');
    expect(prepareMarkdown('Texto [[ci', true)).toBe('Texto ');
    expect(prepareMarkdown('Texto [[cite:ab12:3|"los clo', false)).toContain('[[cite');
  });
});
