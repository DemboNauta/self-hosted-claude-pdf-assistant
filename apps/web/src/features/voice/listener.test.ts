import { describe, expect, it } from 'vitest';
import { LevelGate } from './listener';

describe('LevelGate', () => {
  const feed = (gate: LevelGate, levels: number[], from = 0) =>
    levels.forEach((v, i) => gate.add(v, from + i * 50));

  it('hears a voice above the room noise, not the noise itself', () => {
    const gate = new LevelGate();
    feed(gate, Array(80).fill(0.01));
    expect(gate.speaking(80 * 50)).toBe(false);
    feed(gate, [0.08, 0.09, 0.1, 0.07], 80 * 50);
    expect(gate.speaking(84 * 50)).toBe(true);
  });

  it('ignores a single click and forgets old speech', () => {
    const gate = new LevelGate();
    feed(gate, Array(40).fill(0.005));
    feed(gate, [0.2], 40 * 50);
    expect(gate.speaking(41 * 50)).toBe(false);
    feed(gate, [0.1, 0.1, 0.1], 41 * 50);
    expect(gate.speaking(44 * 50)).toBe(true);
    expect(gate.speaking(44 * 50 + 2000)).toBe(false);
  });
});
