import { describe, expect, it } from 'vitest';
import { relativeTime } from './DocumentCard';

describe('relativeTime', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  it('describes recent and old accesses in Spanish', () => {
    expect(relativeTime('2026-09-26T11:59:30Z', now)).toBe('este minuto');
    expect(relativeTime('2026-09-26T09:00:00Z', now)).toBe('hace 3 horas');
    expect(relativeTime('2026-09-25T12:00:00Z', now)).toBe('ayer');
    expect(relativeTime('2026-09-12T12:00:00Z', now)).toBe('hace 2 semanas');
  });
});
