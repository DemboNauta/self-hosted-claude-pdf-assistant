import type { VoiceSettings } from '@pdfclaudeassistant/shared';

/** A sentence of an answer, with where it comes from (to resume after an interruption). */
export interface Chunk {
  text: string;
  messageId: string;
  index: number;
}

interface Queued extends Chunk {
  audio: Promise<string | null> | null;
  abort: AbortController;
}

/** Sentences fetched ahead of the one playing, so there is no gap between them. */
const PREFETCH = 3;

/**
 * Plays Claude's sentences one after another (voice mode, F-CHAT-09). Audio comes from
 * the server's Piper voices and plays inside the page, so the microphone's echo
 * cancellation removes it and Claude does not interrupt itself. Without server voices
 * (or if a sentence fails) it falls back to the browser's speech synthesis.
 */
export class VoicePlayer {
  private readonly el = new Audio();
  private queue: Queued[] = [];
  private current: Chunk | null = null;
  private generation = 0;
  serverVoices = true;
  settings: VoiceSettings = { voice: 'sharvard-f', rate: 1 };

  constructor(private readonly events: { onStart: (c: Chunk) => void; onIdle: () => void }) {
    this.el.preload = 'auto';
  }

  /** Must run inside a user gesture once, so mobile browsers allow playback later. */
  unlock() {
    this.el.src =
      'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
    void this.el.play().catch(() => {});
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  /** Loads the voice model on the server ahead of the first sentence. */
  warm() {
    if (!this.serverVoices) return;
    void fetch('/api/tts', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hola.', voice: this.settings.voice }),
    }).catch(() => {});
  }

  get playing(): Chunk | null {
    return this.current;
  }

  get busy() {
    return this.current !== null || this.queue.length > 0;
  }

  enqueue(chunk: Chunk) {
    this.queue.push({ ...chunk, audio: null, abort: new AbortController() });
    this.prefetch();
    if (!this.current) void this.next();
  }

  /** Stops at once and drops what was queued; returns the sentence that was playing. */
  stop(): Chunk | null {
    const was = this.current;
    this.generation++;
    for (const q of this.queue) q.abort.abort();
    this.queue = [];
    this.current = null;
    this.el.pause();
    this.el.removeAttribute('src');
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    return was;
  }

  private prefetch() {
    for (const q of this.queue.slice(0, PREFETCH)) {
      if (!q.audio && this.serverVoices) q.audio = this.fetchAudio(q);
    }
  }

  private async fetchAudio(q: Queued): Promise<string | null> {
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: q.text, voice: this.settings.voice }),
        signal: q.abort.signal,
      });
      if (res.status === 503) this.serverVoices = false;
      if (!res.ok) return null;
      return URL.createObjectURL(await res.blob());
    } catch {
      return null;
    }
  }

  private async next() {
    const q = this.queue.shift();
    if (!q) {
      this.current = null;
      this.events.onIdle();
      return;
    }
    const gen = this.generation;
    this.current = q;
    this.prefetch();
    const url = this.serverVoices ? await (q.audio ?? this.fetchAudio(q)) : null;
    if (gen !== this.generation) {
      if (url) URL.revokeObjectURL(url);
      return;
    }
    this.events.onStart(q);
    if (url) await this.playUrl(url);
    else await this.speakWithBrowser(q.text);
    if (url) URL.revokeObjectURL(url);
    if (gen === this.generation) void this.next();
  }

  private playUrl(url: string) {
    return new Promise<void>((resolve) => {
      const el = this.el;
      const done = () => {
        el.onended = el.onerror = el.onpause = null;
        resolve();
      };
      el.onended = done;
      el.onerror = done;
      el.onpause = done;
      el.src = url;
      el.playbackRate = this.settings.rate;
      el.preservesPitch = true;
      el.play().catch(done);
    });
  }

  private speakWithBrowser(text: string) {
    return new Promise<void>((resolve) => {
      if (!('speechSynthesis' in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'es-ES';
      u.rate = this.settings.rate;
      u.voice = bestBrowserVoice();
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }
}

/** The most natural Spanish voice the browser has (Edge "Natural", Google, iOS enhanced). */
function bestBrowserVoice(): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('es'));
  const score = (v: SpeechSynthesisVoice) =>
    (/natural|neural|online/i.test(v.name) ? 4 : 0) +
    (/premium|enhanced|mejorada/i.test(v.name) ? 3 : 0) +
    (/google/i.test(v.name) ? 2 : 0) +
    (v.lang.toLowerCase() === 'es-es' ? 1 : 0);
  return voices.sort((a, b) => score(b) - score(a))[0] ?? null;
}
