/**
 * Turns Claude's Markdown into speakable text and cuts the stream into sentences, so the
 * voice can start with the first sentence while the rest is still being written
 * (voice mode, F-CHAT-09).
 */

/** Markdown, citations and LaTeX removed; what the voice should say. */
export function cleanForSpeech(md: string): string {
  return (
    md
      // Citations and diagrams are shown in the chat, not read.
      .replace(/\[\[(?:cite|diagram):[^\]]*\]\]/g, '')
      .replace(/\[\[voice-end\]\]/g, '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // LaTeX: keep the words, drop the markup.
      .replace(/\$\$?([^$]*)\$\$?/g, (_, tex: string) =>
        tex
          .replace(/\\(?:frac|dfrac)\{([^}]*)\}\{([^}]*)\}/g, '$1 entre $2')
          .replace(/\\[a-zA-Z]+/g, ' ')
          .replace(/[{}_^]/g, ' '),
      )
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
      .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, '')
      .replace(/\|/g, ', ')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
      .replace(/[ \t]+/g, ' ')
      .replace(/ ([.,;:!?])/g, '$1')
      .replace(/\s*\n\s*/g, '\n')
      .trim()
  );
}

/** Abbreviations whose dot does not end a sentence ("p. 12", "fig. 3", "etc."). */
const ABBREVIATIONS = new Set([
  'p',
  'pp',
  'pág',
  'págs',
  'fig',
  'figs',
  'ej',
  'sr',
  'sra',
  'dr',
  'dra',
  'núm',
  'vol',
  'cap',
  'aprox',
  'vs',
  'e.g',
  'i.e',
]);

/** A position is safe to cut when no citation, code block or formula is left open. */
function balanced(text: string) {
  const open = (text.match(/\[\[/g) ?? []).length;
  const close = (text.match(/\]\]/g) ?? []).length;
  const fences = (text.match(/```/g) ?? []).length;
  const dollars = (text.replace(/```[\s\S]*?```/g, '').match(/\$/g) ?? []).length;
  return open === close && fences % 2 === 0 && dollars % 2 === 0;
}

/** Shortest speakable chunk: a lone "Vale." sounds choppy on its own. */
const MIN_CHARS = 25;
/** Without punctuation for this long, cut at a comma or space anyway. */
const MAX_CHARS = 280;

/** Collects streamed Markdown and hands out speakable sentences as they complete. */
export class SentenceSplitter {
  private buffer = '';

  /** Adds streamed text; returns the sentences it completed (already cleaned). */
  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    for (;;) {
      const cut = this.nextCut();
      if (cut < 0) break;
      const spoken = cleanForSpeech(this.buffer.slice(0, cut));
      this.buffer = this.buffer.slice(cut);
      if (spoken) out.push(spoken);
    }
    return out;
  }

  /** The rest, once the answer is complete. */
  flush(): string[] {
    const spoken = cleanForSpeech(this.buffer);
    this.buffer = '';
    return spoken ? [spoken] : [];
  }

  private nextCut(): number {
    const b = this.buffer;
    const re = /[.!?…:;](?=\s)|\n/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b))) {
      const end = m.index + 1;
      if (m[0] === '.') {
        const word = /([\p{L}.]+)$/u.exec(b.slice(0, m.index))?.[1]?.toLowerCase();
        if (word && ABBREVIATIONS.has(word)) continue;
      }
      if (!balanced(b.slice(0, end))) continue;
      if (cleanForSpeech(b.slice(0, end)).length < MIN_CHARS) continue;
      return end;
    }
    if (b.length > MAX_CHARS && balanced(b)) {
      const at = Math.max(b.lastIndexOf(', ', MAX_CHARS), b.lastIndexOf(' ', MAX_CHARS));
      if (at > 0) return at + 1;
    }
    return -1;
  }
}

/** A whole (finished) answer as sentences. */
export function splitSentences(md: string): string[] {
  const s = new SentenceSplitter();
  return [...s.push(md), ...s.flush()];
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/**
 * True when what the microphone heard is mostly Claude's own voice (the words of the
 * sentence being spoken), so it must not count as the student interrupting.
 */
export function isEcho(heard: string, speaking: string): boolean {
  const words = normalize(heard);
  if (!words.length) return true;
  const said = new Set(normalize(speaking));
  const echoed = words.filter((w) => said.has(w)).length;
  return echoed / words.length >= 0.6;
}

/** Spoken commands that control the voice instead of asking Claude something. */
export type VoiceCommand = 'resume' | 'pause' | null;

export function voiceCommand(utterance: string): VoiceCommand {
  const text = normalize(utterance).join(' ');
  if (/^(sigue|continua|adelante|vale sigue|sigue por favor|continua por favor)$/.test(text))
    return 'resume';
  if (/^(para|espera|calla|callate|silencio|stop|pausa|un momento)$/.test(text)) return 'pause';
  return null;
}
