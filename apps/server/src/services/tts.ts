import fs from 'node:fs';
import path from 'node:path';
import type { VoiceId } from '@pdfclaudeassistant/shared';
import type { FastifyBaseLogger } from 'fastify';
import { HttpError } from './errors.js';
import {
  encodeWav,
  loadVoiceStyle,
  MODEL_FILES,
  Supertonic,
  type VoiceStyle,
} from './supertonic.js';

/** Turns text into WAV audio (voice mode, F-CHAT-09). */
export type Synthesize = (text: string, voice: VoiceId) => Promise<Buffer>;

/** The Supertonic preset behind each voice (files in `<SUPERTONIC_DIR>/voice_styles`). */
const VOICES: Record<VoiceId, string> = { f1: 'F1.json', m1: 'M1.json' };

/**
 * Denoising steps: 5 sounds almost like the default 8 (owner's ear test) and is ~40 %
 * faster. Speed is the model's recommended default; the user's rate is applied in the
 * browser.
 */
const STEPS = 5;
const SPEED = 1.05;
/** The VPS has 2 CPUs; requests run one at a time so they do not fight over them. */
const THREADS = 2;
/** The model (~500 MB of RAM) stays loaded this long after its last sentence. */
const IDLE_MS = 10 * 60 * 1000;

/**
 * Text to speech with Supertonic 3 (free, local, natural voices). Enabled when
 * SUPERTONIC_DIR holds the model and the voice styles; the deploy script installs them.
 */
export class SupertonicTts {
  private model: Promise<Supertonic> | null = null;
  private readonly styles = new Map<VoiceId, VoiceStyle>();
  private queue: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;

  constructor(
    private readonly dir: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Null when the model or a voice is missing: voice mode then uses the browser's voices. */
  static detect(dir: string | null, log: FastifyBaseLogger): SupertonicTts | null {
    if (!dir) return null;
    const files = [
      ...MODEL_FILES.map((f) => path.join(dir, 'onnx', f)),
      ...Object.values(VOICES).map((f) => path.join(dir, 'voice_styles', f)),
    ];
    const missing = files.filter((f) => !fs.existsSync(f));
    if (missing.length) {
      log.warn(
        `Supertonic is not complete (missing ${missing.join(', ')}): server voices disabled`,
      );
      return null;
    }
    return new SupertonicTts(dir, log);
  }

  synthesize: Synthesize = (text, voice) => {
    const run = this.queue.then(() => this.run(text, voice));
    this.queue = run.catch(() => {});
    return run;
  };

  async close() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const model = this.model;
    this.model = null;
    await model?.then((m) => m.release()).catch(() => {});
  }

  private async run(text: string, voice: VoiceId): Promise<Buffer> {
    try {
      this.model ??= Supertonic.load(path.join(this.dir, 'onnx'), THREADS);
      const model = await this.model;
      let style = this.styles.get(voice);
      if (!style) {
        style = loadVoiceStyle(path.join(this.dir, 'voice_styles', VOICES[voice]));
        this.styles.set(voice, style);
      }
      const samples = await model.synthesize(text, style, STEPS, SPEED);
      return encodeWav(samples, model.sampleRate);
    } catch (err) {
      this.log.error({ err }, 'speech synthesis failed');
      await this.close();
      throw new HttpError(503, 'tts_failed');
    } finally {
      this.touch();
    }
  }

  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.close(), IDLE_MS).unref();
  }
}
