import { z } from 'zod';

/**
 * Voices Claude can speak with in voice mode (F-CHAT-09). Supertonic 3 presets F1
 * (female) and M1 (male), picked by the owner, synthesised on the server (see
 * apps/server/src/services/tts.ts).
 */
export const VOICE_IDS = ['f1', 'm1'] as const;
export type VoiceId = (typeof VOICE_IDS)[number];

export interface VoiceSettings {
  voice: VoiceId;
  /** Playback speed, applied in the browser (pitch is preserved). */
  rate: number;
}

export const DEFAULT_VOICE: VoiceSettings = { voice: 'f1', rate: 1 };

/** Piper voices saved before the switch to Supertonic, mapped to their replacement. */
export const LEGACY_VOICES: Record<string, VoiceId> = { 'sharvard-f': 'f1', davefx: 'm1' };

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

/** Whether the server can synthesise speech (Supertonic installed). */
export interface TtsStatus {
  available: boolean;
}
