import { z } from 'zod';

/**
 * Voices Claude can speak with in voice mode (F-CHAT-09). Piper neural voices from
 * Spain, synthesised on the server (see apps/server/src/services/tts.ts).
 */
export const VOICE_IDS = ['sharvard-f', 'davefx'] as const;
export type VoiceId = (typeof VOICE_IDS)[number];

export interface VoiceSettings {
  voice: VoiceId;
  /** Playback speed, applied in the browser (pitch is preserved). */
  rate: number;
}

export const DEFAULT_VOICE: VoiceSettings = { voice: 'sharvard-f', rate: 1 };

export const voiceSettingsSchema = z.object({
  voice: z.enum(VOICE_IDS),
  rate: z.number().min(0.7).max(1.6),
});

/** One sentence (or a short group of them) to synthesise. */
export const ttsRequestSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  voice: z.enum(VOICE_IDS),
});
export type TtsRequest = z.infer<typeof ttsRequestSchema>;

/**
 * Claude ends a spoken explanation with this when the scope is covered, so voice mode
 * stops asking it to carry on (podcast style). Hidden in the chat and not spoken.
 */
export const VOICE_END = '[[voice-end]]';

/** Whether the server can synthesise speech (Piper installed). */
export interface TtsStatus {
  available: boolean;
}
