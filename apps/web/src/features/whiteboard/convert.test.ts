import type { BoardStep } from '@pdfclaudeassistant/shared';
import { describe, expect, it } from 'vitest';
import { sceneId, stepSkeletons, STROKE } from './convert';

const step = (elements: BoardStep['elements']): BoardStep => ({
  id: 'w1',
  messageId: 'm',
  elements,
  createdAt: '',
});

describe('whiteboard steps → Excalidraw skeletons', () => {
  it('maps shapes, text and bound arrows, keeping Claude’s ids', () => {
    const out = stepSkeletons(
      step([
        { type: 'rect', id: 'a', x: 0, y: 0, w: 100, h: 50, label: 'A', color: 'blue', fill: true },
        { type: 'ellipse', id: 'b', x: 300, y: 0, w: 100, h: 50 },
        { type: 'arrow', from: 'a', to: 'b', label: 'va a' },
        { type: 'text', x: 0, y: 100, text: 'x² + 1', size: 'l' },
      ]),
      new Map(),
    );
    expect(out[0]).toMatchObject({
      type: 'rectangle',
      id: sceneId('a'),
      strokeColor: STROKE.blue,
      label: { text: 'A' },
      fillStyle: 'hachure',
    });
    expect(out[1]).toMatchObject({ type: 'ellipse', id: sceneId('b') });
    // From the right edge of A to the left edge of B, bound to both.
    expect(out[2]).toMatchObject({
      type: 'arrow',
      x: 100,
      y: 25,
      points: [
        [0, 0],
        [200, 0],
      ],
      start: { id: sceneId('a') },
      end: { id: sceneId('b') },
      label: { text: 'va a' },
    });
    expect(out[3]).toMatchObject({ type: 'text', text: 'x² + 1', fontSize: 28 });
  });

  it('connects to elements from earlier steps without binding, and keeps crops as images', () => {
    const existing = new Map([[sceneId('a'), { x: 0, y: 0, width: 100, height: 100 }]]);
    const out = stepSkeletons(
      step([
        { type: 'pdf', id: 'fig', page: 1, x: 0, y: 300, w: 100, h: 60, fileId: 'f1' },
        { type: 'arrow', from: 'a', to: 'fig', dashed: true },
        {
          type: 'line',
          points: [
            [10, 10],
            [60, 40],
          ],
        },
      ]),
      existing,
    );
    expect(out[0]).toMatchObject({ type: 'image', fileId: 'f1', width: 100, height: 60 });
    expect(out[1]).toMatchObject({ type: 'arrow', strokeStyle: 'dashed', x: 50, y: 100 });
    expect(out[1]).not.toHaveProperty('start');
    expect(out[2]).toMatchObject({ type: 'line', x: 10, y: 10, endArrowhead: null });
  });
});
