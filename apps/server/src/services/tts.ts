import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { VoiceId } from '@pdfclaudeassistant/shared';
import type { FastifyBaseLogger } from 'fastify';
import { HttpError } from './errors.js';
import { newId } from './ids.js';

/** Turns text into WAV audio (voice mode, F-CHAT-09). */
export type Synthesize = (text: string, voice: VoiceId) => Promise<Buffer>;

/** The Piper models behind each voice (files in `<PIPER_DIR>/voices`). */
const VOICES: Record<VoiceId, { model: string; speaker?: number }> = {
  'sharvard-f': { model: 'es_ES-sharvard-medium.onnx', speaker: 1 },
  davefx: { model: 'es_ES-davefx-medium.onnx' },
};

/** A model stays loaded this long after its last sentence. */
const IDLE_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const BIN = process.platform === 'win32' ? 'piper.exe' : 'piper';

interface Pending {
  file: string;
  resolve: (file: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One long-lived Piper process per model (`--json-input`): each stdin line is a
 * sentence with its output file, and Piper prints the file's path when it is written.
 * Keeping the model loaded makes a sentence take ~0.1–0.3 s on the VPS.
 */
class PiperProcess {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private queue: Pending[] = [];
  private idle: NodeJS.Timeout | null = null;

  constructor(
    private readonly bin: string,
    private readonly model: string,
    private readonly outDir: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  synth(text: string, speaker: number | undefined): Promise<string> {
    const proc = this.ensure();
    const file = path.join(this.outDir, `${newId()}.wav`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queue = this.queue.filter((p) => p.file !== file);
        reject(new Error('piper timeout'));
        this.kill();
      }, REQUEST_TIMEOUT_MS);
      this.queue.push({ file, resolve, reject, timer });
      // One line per sentence: Piper reads JSON lines, so newlines must not break it.
      const line = JSON.stringify({
        text: text.replace(/\s+/g, ' '),
        output_file: file,
        ...(speaker !== undefined ? { speaker_id: speaker } : {}),
      });
      proc.stdin.write(`${line}\n`);
      this.touch();
    });
  }

  kill() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.proc?.kill();
    this.proc = null;
  }

  private ensure() {
    if (this.proc) return this.proc;
    const proc = spawn(this.bin, ['--model', this.model, '--json-input'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      const i = this.queue.findIndex((p) => p.file === line.trim());
      if (i < 0) return;
      const [done] = this.queue.splice(i, 1);
      clearTimeout(done!.timer);
      done!.resolve(done!.file);
    });
    proc.stderr.on('data', () => {});
    const fail = (err: Error) => {
      if (this.proc === proc) this.proc = null;
      for (const p of this.queue.splice(0)) {
        clearTimeout(p.timer);
        p.reject(err);
      }
    };
    proc.on('error', (err) => {
      this.log.error({ err }, 'piper failed to start');
      fail(err);
    });
    proc.on('exit', (code) => fail(new Error(`piper exited (${code})`)));
    return proc;
  }

  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.kill(), IDLE_MS).unref();
  }
}

/**
 * Text to speech with Piper (free, local neural voices). Enabled when PIPER_DIR holds
 * the `piper` binary and the voice models; the deploy script installs them.
 */
export class PiperTts {
  private readonly procs = new Map<string, PiperProcess>();
  private readonly outDir: string;

  constructor(
    private readonly dir: string,
    private readonly log: FastifyBaseLogger,
  ) {
    this.outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-tts-'));
  }

  /** Null when Piper or a voice is missing: voice mode then uses the browser's voices. */
  static detect(dir: string | null, log: FastifyBaseLogger): PiperTts | null {
    if (!dir) return null;
    const files = [
      path.join(dir, BIN),
      ...Object.values(VOICES).map((v) => path.join(dir, 'voices', v.model)),
    ];
    const missing = files.filter((f) => !fs.existsSync(f));
    if (missing.length) {
      log.warn(`Piper is not complete (missing ${missing.join(', ')}): server voices disabled`);
      return null;
    }
    return new PiperTts(dir, log);
  }

  synthesize: Synthesize = async (text, voice) => {
    const v = VOICES[voice];
    let proc = this.procs.get(v.model);
    if (!proc) {
      proc = new PiperProcess(
        path.join(this.dir, BIN),
        path.join(this.dir, 'voices', v.model),
        this.outDir,
        this.log,
      );
      this.procs.set(v.model, proc);
    }
    let file: string;
    try {
      file = await proc.synth(text, v.speaker);
    } catch (err) {
      this.log.error({ err }, 'speech synthesis failed');
      throw new HttpError(503, 'tts_failed');
    }
    try {
      return await fs.promises.readFile(file);
    } catch (err) {
      this.log.error({ err }, 'speech synthesis produced no audio');
      throw new HttpError(503, 'tts_failed');
    } finally {
      fs.rmSync(file, { force: true });
    }
  };

  close() {
    for (const p of this.procs.values()) p.kill();
    fs.rmSync(this.outDir, { recursive: true, force: true });
  }
}
