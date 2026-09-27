/**
 * Supertonic 3 text to speech on ONNX Runtime (CPU).
 *
 * Adapted from the Node.js example of https://github.com/supertone-inc/supertonic
 * (sample code under the MIT License, Copyright (c) Supertone Inc.). The model
 * weights are under the OpenRAIL-M License and are downloaded by the deploy script,
 * never committed.
 *
 * Differences from the example: one speaker per call, typed arrays instead of
 * nested ones, Spanish-only preprocessing and a caller-provided session config.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';

interface ModelConfig {
  ae: { sample_rate: number; base_chunk_size: number };
  ttl: { chunk_compress_factor: number; latent_dim: number };
}

interface StyleFile {
  style_ttl: { dims: number[]; data: unknown[] };
  style_dp: { dims: number[]; data: unknown[] };
}

export interface VoiceStyle {
  ttl: ort.Tensor;
  dp: ort.Tensor;
}

/** Files the model needs inside `<dir>/onnx`. */
export const MODEL_FILES = [
  'duration_predictor.onnx',
  'text_encoder.onnx',
  'vector_estimator.onnx',
  'vocoder.onnx',
  'tts.json',
  'unicode_indexer.json',
];

/** Longest text sent to the model at once; longer input is split at sentence ends. */
const MAX_CHUNK = 300;
/** Silence between the chunks of a long text, in seconds. */
const CHUNK_GAP = 0.3;

const REPLACEMENTS: [string, string][] = [
  ['–', '-'],
  ['‑', '-'],
  ['—', '-'],
  ['_', ' '],
  ['“', '"'],
  ['”', '"'],
  ['‘', "'"],
  ['’', "'"],
  ['´', "'"],
  ['`', "'"],
  ['[', ' '],
  [']', ' '],
  ['|', ' '],
  ['/', ' '],
  ['#', ' '],
  ['→', ' '],
  ['←', ' '],
];
const EMOJI =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;

/** The example's normalisation, wrapped in the language tags the model expects. */
export function preprocess(input: string, lang = 'es'): string {
  let text = input.normalize('NFKD').replace(EMOJI, '');
  for (const [from, to] of REPLACEMENTS) text = text.replaceAll(from, to);
  text = text
    .replace(/[♥☆♡©\\]/g, '')
    .replace(/ ([,.!?;:'])/g, '$1')
    .replace(/"{2,}/g, '"')
    .replace(/'{2,}/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[.!?;:,'")\]}…»]$/.test(text)) text += '.';
  return `<${lang}>${text}</${lang}>`;
}

/** Splits a text at sentence ends into pieces of at most `max` characters. */
export function chunkText(text: string, max = MAX_CHUNK): string[] {
  const chunks: string[] = [];
  for (const paragraph of text.trim().split(/\n\s*\n+/)) {
    let current = '';
    for (const sentence of paragraph.trim().split(/(?<=[.!?])\s+/)) {
      if (!sentence) continue;
      if (current && current.length + sentence.length + 1 > max) {
        chunks.push(current);
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    }
    if (current) chunks.push(current);
  }
  return chunks;
}

function styleTensor(part: StyleFile['style_ttl']): ort.Tensor {
  const data = Float32Array.from((part.data as number[]).flat(Infinity) as number[]);
  return new ort.Tensor('float32', data, part.dims);
}

export function loadVoiceStyle(file: string): VoiceStyle {
  const json = JSON.parse(fs.readFileSync(file, 'utf8')) as StyleFile;
  return { ttl: styleTensor(json.style_ttl), dp: styleTensor(json.style_dp) };
}

/** Standard normal noise (Box-Muller). */
function gaussian(): number {
  const u1 = Math.max(1e-10, Math.random());
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
}

export class Supertonic {
  readonly sampleRate: number;
  private readonly latentChunk: number;
  private readonly latentDim: number;

  private constructor(
    private readonly cfg: ModelConfig,
    private readonly indexer: number[],
    private readonly dp: ort.InferenceSession,
    private readonly textEnc: ort.InferenceSession,
    private readonly vectorEst: ort.InferenceSession,
    private readonly vocoder: ort.InferenceSession,
  ) {
    this.sampleRate = cfg.ae.sample_rate;
    this.latentChunk = cfg.ae.base_chunk_size * cfg.ttl.chunk_compress_factor;
    this.latentDim = cfg.ttl.latent_dim * cfg.ttl.chunk_compress_factor;
  }

  /** Loads the four ONNX sessions from `<onnxDir>`. */
  static async load(onnxDir: string, threads: number): Promise<Supertonic> {
    const opts: ort.InferenceSession.SessionOptions = {
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
    };
    const read = (f: string) => fs.readFileSync(path.join(onnxDir, f), 'utf8');
    const cfg = JSON.parse(read('tts.json')) as ModelConfig;
    const indexer = JSON.parse(read('unicode_indexer.json')) as number[];
    const [dp, textEnc, vectorEst, vocoder] = await Promise.all(
      ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'].map((m) =>
        ort.InferenceSession.create(path.join(onnxDir, `${m}.onnx`), opts),
      ),
    );
    return new Supertonic(cfg, indexer, dp!, textEnc!, vectorEst!, vocoder!);
  }

  /** Mono samples in [-1, 1] at `sampleRate`. */
  async synthesize(
    text: string,
    style: VoiceStyle,
    steps: number,
    speed: number,
  ): Promise<Float32Array> {
    const parts: Float32Array[] = [];
    const gap = new Float32Array(Math.floor(CHUNK_GAP * this.sampleRate));
    for (const chunk of chunkText(text)) {
      if (parts.length) parts.push(gap);
      parts.push(await this.infer(chunk, style, steps, speed));
    }
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  async release() {
    await Promise.all(
      [this.dp, this.textEnc, this.vectorEst, this.vocoder].map((s) => s.release()),
    );
  }

  private async infer(text: string, style: VoiceStyle, steps: number, speed: number) {
    const chars = Array.from(preprocess(text));
    const ids = new BigInt64Array(chars.length);
    chars.forEach((c, i) => {
      ids[i] = BigInt(this.indexer[c.charCodeAt(0)] ?? -1);
    });
    const textIds = new ort.Tensor('int64', ids, [1, ids.length]);
    const textMask = new ort.Tensor('float32', new Float32Array(ids.length).fill(1), [
      1,
      1,
      ids.length,
    ]);

    const { duration } = await this.dp.run({
      text_ids: textIds,
      style_dp: style.dp,
      text_mask: textMask,
    });
    const seconds = (duration!.data as Float32Array)[0]! / speed;
    const { text_emb } = await this.textEnc.run({
      text_ids: textIds,
      style_ttl: style.ttl,
      text_mask: textMask,
    });

    const wavLen = Math.floor(seconds * this.sampleRate);
    const latentLen = Math.floor((wavLen + this.latentChunk - 1) / this.latentChunk);
    const dims = [1, this.latentDim, latentLen];
    let latent = new Float32Array(this.latentDim * latentLen).map(gaussian);
    const latentMask = new ort.Tensor('float32', new Float32Array(latentLen).fill(1), [
      1,
      1,
      latentLen,
    ]);
    const totalStep = new ort.Tensor('float32', Float32Array.of(steps), [1]);

    for (let step = 0; step < steps; step++) {
      const { denoised_latent } = await this.vectorEst.run({
        noisy_latent: new ort.Tensor('float32', latent, dims),
        text_emb: text_emb!,
        style_ttl: style.ttl,
        text_mask: textMask,
        latent_mask: latentMask,
        total_step: totalStep,
        current_step: new ort.Tensor('float32', Float32Array.of(step), [1]),
      });
      latent = Float32Array.from(denoised_latent!.data as Float32Array);
    }

    const { wav_tts } = await this.vocoder.run({
      latent: new ort.Tensor('float32', latent, dims),
    });
    return (wav_tts!.data as Float32Array).slice(0, wavLen);
  }
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) =>
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2),
  );
  return buf;
}
