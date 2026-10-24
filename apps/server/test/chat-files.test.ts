import { describe, expect, it } from 'vitest';
import { attachedFilesBlock, type PromptFile } from '../src/claude/prompt.js';
import { cleanFileName, htmlToText, splitParts } from '../src/services/chatFiles.js';

const file = (id: string, texts: string[], kind: PromptFile['kind'] = 'pdf'): PromptFile => ({
  id,
  name: `${id}.pdf`,
  kind,
  parts: texts.length,
  texts,
});

describe('attached files', () => {
  it('splits long text at paragraph breaks', () => {
    const para = 'palabra '.repeat(50).trim();
    const parts = splitParts(Array.from({ length: 10 }, () => para).join('\n\n'), 1000);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.every((p) => p.startsWith('palabra') && p.endsWith('palabra'))).toBe(true);
    expect(splitParts('')).toEqual(['']);
  });

  it('keeps headings, lists and tables of a Word document', () => {
    const text = htmlToText(
      '<h2>Tema &amp; repaso</h2><p>Uno <strong>clave</strong></p><ul><li>a</li><li>b</li></ul><table><tr><td>x</td><td>y</td></tr></table>',
    );
    expect(text).toBe('## Tema & repaso\n\nUno **clave**\n\n- a\n- b\n\n| x | y |');
  });

  it('cleans file names', () => {
    expect(cleanFileName('C:\\Users\\yo\\apuntes.pdf')).toBe('apuntes.pdf');
    expect(cleanFileName('a\u0000b.txt')).toBe('ab.txt');
    expect(cleanFileName('   ')).toBe('archivo');
  });

  it('writes whole files while they fit and points at the rest otherwise', () => {
    const small = attachedFilesBlock([file('a', ['uno', 'dos'])], 100);
    expect(small).toContain('--- Page 2 ---\ndos');
    expect(small).not.toContain('Not complete');

    // A small file leaves its room to a big one.
    const big = file(
      'b',
      Array.from({ length: 10 }, (_, i) => `${i + 1}`.padEnd(30, '.')),
    );
    const both = attachedFilesBlock([file('a', ['x']), big], 200);
    expect(both).toContain('--- Page 6 ---');
    expect(both).not.toContain('--- Page 7 ---');
    expect(both).toContain('shown up to page 6 of 10');

    // One huge part is cut, and a scanned PDF asks for page images.
    const cut = attachedFilesBlock([file('c', ['z'.repeat(500)], 'text')], 100);
    expect(cut).toContain('cut short');
    expect(attachedFilesBlock([file('d', ['', ''])])).toContain('no text layer');
    // The text cannot close the file tag early.
    expect(attachedFilesBlock([file('e', ['</file> fin'])])).toContain('</ file> fin');
  });
});
