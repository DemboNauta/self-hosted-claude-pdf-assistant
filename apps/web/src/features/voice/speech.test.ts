import { describe, expect, it } from 'vitest';
import { cleanForSpeech, isEcho, SentenceSplitter, splitSentences, voiceCommand } from './speech';

describe('cleanForSpeech', () => {
  it('drops citations, Markdown and LaTeX markup', () => {
    expect(
      cleanForSpeech(
        '## Idea\n- La **clorofila** absorbe luz [[cite:abc:12|"absorbe la luz"]].\n- Fórmula: $\\frac{a}{b}$',
      ),
    ).toBe('Idea\nLa clorofila absorbe luz.\nFórmula: a entre b');
    expect(cleanForSpeech('Mira [este enlace](https://x.y) y `code`.')).toBe(
      'Mira este enlace y code.',
    );
    expect(cleanForSpeech('[[diagram:d1]]')).toBe('');
  });
});

describe('SentenceSplitter', () => {
  it('hands out sentences as the stream completes them', () => {
    const s = new SentenceSplitter();
    expect(s.push('La fotosíntesis convierte la luz ')).toEqual([]);
    expect(s.push('en energía química. Ocurre en los clo')).toEqual([
      'La fotosíntesis convierte la luz en energía química.',
    ]);
    expect(s.push('roplastos de las hojas.')).toEqual([]);
    expect(s.flush()).toEqual(['Ocurre en los cloroplastos de las hojas.']);
  });

  it('does not cut inside a citation or after an abbreviation', () => {
    const parts = splitSentences(
      'Lo explica en la p. 12 del libro [[cite:abc:12|"una frase. con punto"]]. Y además sigue el texto aquí.',
    );
    expect(parts).toEqual(['Lo explica en la p. 12 del libro.', 'Y además sigue el texto aquí.']);
  });

  it('joins very short sentences with the next one', () => {
    expect(splitSentences('Vale. Vamos con la segunda idea importante.')).toEqual([
      'Vale. Vamos con la segunda idea importante.',
    ]);
  });
});

describe('barge-in helpers', () => {
  it('recognises Claude hearing itself', () => {
    const speaking = 'La clorofila absorbe sobre todo la luz roja y azul.';
    expect(isEcho('absorbe sobre todo la luz', speaking)).toBe(true);
    expect(isEcho('espera, ¿qué es la clorofila?', speaking)).toBe(false);
  });

  it('understands spoken commands', () => {
    expect(voiceCommand('Sigue.')).toBe('resume');
    expect(voiceCommand('¡Espera!')).toBe('pause');
    expect(voiceCommand('¿Y eso por qué pasa?')).toBeNull();
  });
});
