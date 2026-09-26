import { recognitionCtor, type Recognition } from '../chat/dictation';

/** Android Chrome repeats results in continuous mode: there each phrase is its own session. */
const isAndroid = () => /android/i.test(navigator.userAgent);

/**
 * An always-open microphone for voice mode (F-CHAT-09), with the browser's speech
 * recognition (resolved with the owner: Web Speech API). Browsers end a recognition
 * session after a pause or a minute, so it starts again by itself until `stop()`.
 */
export class Listener {
  private rec: Recognition | null = null;
  private running = false;
  private failures = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly handlers: {
      /** Text heard so far in the current phrase (`final` once the phrase is complete). */
      onResult: (text: string, final: boolean) => void;
      onError: (code: string) => void;
    },
  ) {}

  static supported() {
    return recognitionCtor() !== null;
  }

  start() {
    this.running = true;
    this.failures = 0;
    this.open();
  }

  stop() {
    this.running = false;
    clearTimeout(this.restartTimer);
    const rec = this.rec;
    this.rec = null;
    rec?.stop();
  }

  private open() {
    const Ctor = recognitionCtor();
    if (!Ctor || !this.running || this.rec) return;
    const rec = new Ctor();
    rec.lang = navigator.language?.toLowerCase().startsWith('es') ? navigator.language : 'es-ES';
    rec.continuous = !isAndroid();
    rec.interimResults = true;
    rec.onresult = (e) => {
      this.failures = 0;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        const text = r[0].transcript.trim();
        if (text) this.handlers.onResult(text, r.isFinal);
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      this.failures++;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.running = false;
      }
      this.handlers.onError(e.error);
    };
    rec.onend = () => {
      if (this.rec === rec) this.rec = null;
      if (!this.running) return;
      // Straight back to listening; slower after repeated failures (e.g. no network).
      const delay = this.failures ? Math.min(5000, 300 * 2 ** this.failures) : 100;
      this.restartTimer = setTimeout(() => this.open(), delay);
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      this.rec = null;
      this.restartTimer = setTimeout(() => this.open(), 500);
    }
  }
}
