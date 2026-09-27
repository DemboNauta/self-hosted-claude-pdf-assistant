import type { BoardStep, ResolvedBoardElement } from '@pdfclaudeassistant/shared';
import { describe, expect, it } from 'vitest';
import { boardElements, findProblems, place, renderPreview, wrap } from '../src/claude/board.js';

const step = (id: string, elements: ResolvedBoardElement[], extra: Partial<BoardStep> = {}) =>
  ({ id, messageId: 'm', elements, createdAt: '', ...extra }) as BoardStep;

describe('whiteboard geometry', () => {
  it('wraps text to a width with the real font and grows boxes to fit', () => {
    const lines = wrap('Queremos saber CÓMO llegar al estado objetivo', 16, 150);
    expect(lines.length).toBeGreaterThan(1);
    const [box] = place([
      {
        type: 'rect',
        id: 'a',
        x: 0,
        y: 0,
        w: 200,
        h: 40,
        label: 'Tipo 1: interesa el CAMINO',
        text: 'Queremos saber CÓMO llegar al estado objetivo → la solución es la secuencia de acciones',
      },
    ]);
    expect(box!.lines![0]).toBe('Tipo 1: interesa el');
    expect(box!.box!.h).toBeGreaterThan(80);
  });

  it('finds the overlaps of the first real board (text over a titled box, text in a gap)', () => {
    const problems = findProblems(
      place([
        {
          type: 'rect',
          id: 'csp',
          x: 75,
          y: 260,
          w: 240,
          h: 110,
          label: 'Satisfacción de restricciones (CSP)',
        },
        {
          type: 'text',
          id: 'csp_body',
          x: 85,
          y: 290,
          text: '• Estado = asignación de valores',
          size: 's',
        },
        { type: 'rect', id: 'plan', x: 330, y: 260, w: 210, h: 110, label: 'Planificación' },
        {
          type: 'text',
          id: 'mid',
          x: 262,
          y: 300,
          text: 'dos formas distintas de formalizar',
          size: 's',
        },
        {
          type: 'text',
          id: 'title',
          x: 200,
          y: 40,
          text: 'Pág. 15 — Resolución de problemas y búsqueda',
          size: 'xl',
        },
      ]),
    );
    expect(problems.some((p) => p.includes('"csp_body"') && p.includes('already has text'))).toBe(
      true,
    );
    expect(problems.some((p) => p.includes('"mid"') && p.includes('overlap'))).toBe(true);
    expect(problems.some((p) => p.includes('"title"') && p.includes('right edge'))).toBe(true);
  });

  it('keeps what is on the board: replaced ids, removals and clears', () => {
    const board = boardElements([
      step('w1', [
        { type: 'rect', id: 'a', x: 0, y: 0, w: 10, h: 10 },
        { type: 'rect', id: 'b', x: 0, y: 0, w: 10, h: 10 },
      ]),
      step('w2', [{ type: 'rect', id: 'a', x: 50, y: 0, w: 10, h: 10 }], { remove: ['b'] }),
    ]);
    expect(board.elements).toEqual([{ type: 'rect', id: 'a', x: 50, y: 0, w: 10, h: 10 }]);
    expect(
      boardElements([...[step('w1', board.elements)], step('w2', [], { clear: true })]).elements,
    ).toEqual([]);
  });

  it('renders a preview image', async () => {
    const { png, bounds } = await renderPreview(
      place([
        { type: 'rect', id: 'a', x: 20, y: 20, w: 200, h: 60, label: 'Luz' },
        { type: 'arrow', from: 'a', to: 'b', label: 'va' },
        { type: 'ellipse', id: 'b', x: 400, y: 20, w: 200, h: 60, label: 'Azúcar' },
      ]),
      {},
      1,
    );
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(bounds.w).toBeGreaterThanOrEqual(1000);
  });
});
