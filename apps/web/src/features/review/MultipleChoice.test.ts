import { describe, expect, it } from 'vitest';
import { fastLimitMs, ratingFor, shuffled } from './MultipleChoice';

describe('multiple-choice cards', () => {
  it('rates a wrong answer "again" and a right one "good", or "easy" when fast', () => {
    expect(ratingFor(false, 500, 5000)).toBe(1);
    expect(ratingFor(true, 4000, 5000)).toBe(4);
    expect(ratingFor(true, 6000, 5000)).toBe(3);
  });

  it('gives longer cards more time to count as fast', () => {
    const short = fastLimitMs({ front: '¿2+2?', back: '4', distractors: ['3', '5', '6'] });
    const long = fastLimitMs({
      front: '¿Qué establece el segundo principio de la termodinámica?',
      back: 'Que la entropía de un sistema aislado nunca disminuye.',
      distractors: [
        'Que la energía se conserva.',
        'Que la entropía es cero a 0 K.',
        'Que el calor fluye del frío al caliente.',
      ],
    });
    expect(short).toBeGreaterThanOrEqual(3000);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThanOrEqual(12_000);
  });

  it('shuffles the options the same way for the same card', () => {
    const items = ['a', 'b', 'c', 'd'];
    expect(shuffled(items, 'card-1')).toEqual(shuffled(items, 'card-1'));
    expect([...shuffled(items, 'card-1')].sort()).toEqual(items);
    // Different cards put the right answer in different places.
    const places = new Set(
      ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8'].map((id) =>
        shuffled(items, id).indexOf('a'),
      ),
    );
    expect(places.size).toBeGreaterThan(1);
  });
});
