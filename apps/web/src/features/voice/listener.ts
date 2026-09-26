import { recognitionCtor, type Recognition } from '../chat/dictation';

/** Android Chrome repeats results in continuous mode: there each phrase is its own session. */
const isAndroid = () => /android/i.test(navigator.userAgent);

/** How recent the voice must be to count as "the student is talking now". */
const VOICE_WINDOW_MS = 700;
/** The noise floor is measured over this much recent audio. */
const FLOOR_WINDOW_MS = 6000;
/** Quietest level that can be a voice, whatever the noise floor. */
const MIN_VOICE_LEVEL = 0.012;

/**
 * Decides from the microphone level whether someone is talking. The level comes from
 * the echo-cancelled microphone, where Claude's own voice has been subtracted, so a
 * loud level means the student, not the speakers. The threshold follows the room's
 * noise floor (a low percentile of recent levels).
 */
export class LevelGate {
  private samples: { t: number; v: number }[] = [];

  add(level: number, now = performance.now()) {
    this.samples.push({ t: now, v: level });
    while (this.samples.length && now - this.samples[0]!.t > FLOOR_WINDOW_MS) this.samples.shift();
  }

  threshold() {
    const sorted = this.samples.map((s) => s.v).sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
    return Math.max(MIN_VOICE_LEVEL, floor * 3);
  }

  speaking(now = performance.now()) {
    const limit = this.threshold();
    let loud = 0;
    for (const s of this.samples) if (now - s.t <= VOICE_WINDOW_MS && s.v > limit) loud++;
    // A few loud frames (50 ms each), not a single click.
    return loud >= 3;
  }
}

/**
 * An always-open microphone for voice mode (F-CHAT-09), with the browser's speech
 * recognition (resolved with the owner: Web Speech API). Browsers end a recognition
 * session after a pause or a minute, so it starts again by itself until `stop()`.
 *
 * Echo: the microphone is also opened with the browser's echo cancellation, noise
 * suppression and gain control (as in video calls). Where the browser allows it the
 * recognition listens to that cleaned track, and its level tells whether the student
 * is really talking (`userSpeaking`), so Claude's voice from the speakers does not
 * count as an interruption.
 */
export class Listener {
  private rec: Recognition | null = null;
  private running = false;
  private failures = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private meter: ReturnType<typeof setInterval> | undefined;
  private readonly gate = new LevelGate();
  /** Level measured last (for the debug log). */
  level = 0;

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

  /** Listens at once; switches to the echo-cancelled track once the browser grants it. */
  start() {
    this.running = true;
    this.failures = 0;
    this.open();
    void this.openMicrophone().then(() => {
      // Restart the session on the cleaned track (onend opens it again).
      if (this.running && this.stream) this.rec?.stop();
    });
  }

  stop() {
    this.running = false;
    clearTimeout(this.restartTimer);
    const rec = this.rec;
    this.rec = null;
    rec?.stop();
    this.closeMicrophone();
  }

  /**
   * Whether the echo-cancelled microphone hears a voice right now; null when there is
   * no such microphone (then only the text echo filter protects from self-interruption).
   */
  userSpeaking(): boolean | null {
    return this.stream ? this.gate.speaking() : null;
  }

  private async openMicrophone() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      // Voice mode ended while the browser was asking for permission.
      if (!this.running) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      this.meter = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const x of buf) sum += x * x;
        this.level = Math.sqrt(sum / buf.length);
        this.gate.add(this.level);
      }, 50);
      this.stream = stream;
      this.ctx = ctx;
    } catch {
      this.closeMicrophone();
    }
  }

  private closeMicrophone() {
    clearInterval(this.meter);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.ctx?.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
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
      // Some phones cannot share the microphone: give it back to the recognition.
      if (e.error === 'audio-capture' && this.stream) {
        this.closeMicrophone();
        return;
      }
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
      // Newer Chrome/Edge listen to the given (echo-cancelled) track; older ones
      // ignore the argument and use the default microphone.
      const track = this.stream?.getAudioTracks()[0];
      if (track) rec.start(track);
      else rec.start();
    } catch {
      try {
        rec.start();
      } catch {
        this.rec = null;
        this.restartTimer = setTimeout(() => this.open(), 500);
      }
    }
  }
}
