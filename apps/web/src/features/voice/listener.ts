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
 * How the recognition gets its audio, from best to most compatible:
 * - `track`: it listens to the echo-cancelled track (newer desktop Chrome/Edge);
 * - `meter`: it uses the default microphone; the cleaned one only measures the level;
 * - `plain`: no second microphone at all (phones that cannot share it).
 * Any sign that the current way does not work moves to the next one.
 */
export type MicMode = 'track' | 'meter' | 'plain';

/** Talking this long (by the level) without any recognition result means it is deaf. */
const DEAF_AFTER_MS = 2500;

/**
 * An always-open microphone for voice mode (F-CHAT-09), with the browser's speech
 * recognition (resolved with the owner: Web Speech API). Browsers end a recognition
 * session after a pause or a minute, so it starts again by itself until `stop()`.
 *
 * Echo: the microphone is also opened with the browser's echo cancellation, noise
 * suppression and gain control (as in video calls), so its level tells whether the
 * student is really talking (`userSpeaking`) and Claude's voice from the speakers does
 * not count as an interruption. Some phones cannot share the microphone between that
 * and the recognition: then it falls back step by step (`MicMode`).
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
  private voiceWithoutResult = 0;
  mode: MicMode = 'track';
  /** A recognition session is running (diagnostics). */
  get listening() {
    return this.rec !== null;
  }
  /** Level measured last (diagnostics). */
  level = 0;

  constructor(
    private readonly handlers: {
      /** Text heard so far in the current phrase (`final` once the phrase is complete). */
      onResult: (text: string, final: boolean) => void;
      onError: (code: string) => void;
      /** Diagnostics for `?vozdebug=1`. */
      onDebug?: (line: string) => void;
    },
  ) {}

  static supported() {
    return recognitionCtor() !== null;
  }

  /** Listens at once; moves to the echo-cancelled microphone once the browser grants it. */
  start() {
    this.running = true;
    this.failures = 0;
    this.mode = 'track';
    // Created inside the tap: on phones an audio context made later stays suspended.
    try {
      this.ctx = new AudioContext();
    } catch {
      this.ctx = null;
    }
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
    if (!this.stream || this.ctx?.state !== 'running') return null;
    return this.gate.speaking();
  }

  private debug(line: string) {
    this.handlers.onDebug?.(line);
  }

  /** The current way of listening does not work here: try the next one. */
  private degrade(reason: string) {
    if (this.mode === 'plain') return;
    this.mode = this.mode === 'track' ? 'meter' : 'plain';
    if (this.mode === 'plain') this.closeMicrophone();
    this.voiceWithoutResult = 0;
    this.debug(`${reason} → micro: ${this.mode}`);
    this.rec?.stop();
  }

  private async openMicrophone() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      // Voice mode ended (or gave up on it) while the browser was asking for permission.
      if (!this.running || this.mode === 'plain') {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const ctx = this.ctx ?? new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
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
        // Someone is talking and the recognition hears nothing: it has no audio.
        if (this.gate.speaking()) this.voiceWithoutResult += 50;
        if (this.voiceWithoutResult > DEAF_AFTER_MS) this.degrade('no oye nada');
      }, 50);
      this.stream = stream;
      this.ctx = ctx;
      this.debug(`micro limpio abierto (audio ${ctx.state})`);
    } catch (err) {
      this.debug(`sin micro limpio (${(err as Error).name})`);
      this.mode = 'plain';
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
      this.voiceWithoutResult = 0;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        const text = r[0].transcript.trim();
        if (text) this.handlers.onResult(text, r.isFinal);
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      this.debug(`error ${e.error} (micro: ${this.mode})`);
      // With a second microphone open, "not allowed" or "no audio" usually means the
      // phone cannot share it, not that the student said no.
      if (this.mode !== 'plain' && e.error !== 'network') {
        this.degrade(e.error);
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
    const track = this.mode === 'track' ? this.stream?.getAudioTracks()[0] : undefined;
    try {
      // Newer Chrome/Edge listen to the given (echo-cancelled) track; older ones
      // ignore the argument and use the default microphone.
      if (track) rec.start(track);
      else rec.start();
    } catch (err) {
      this.debug(`start falla (${(err as Error).name}, micro: ${this.mode})`);
      this.rec = null;
      if (track) this.degrade('start con pista');
      this.restartTimer = setTimeout(() => this.open(), 300);
    }
  }
}
