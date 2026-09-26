import {
  DEFAULT_VOICE,
  VOICE_END,
  type AppSettings,
  type ChatMessage,
  type TtsStatus,
  type VoiceSettings,
} from '@pdfclaudeassistant/shared';
import { create } from 'zustand';
import { t } from '../../i18n';
import { api } from '../../lib/api';
import { chatSocket, useChat } from '../chat/store';
import { useReader } from '../reader/store';
import { Listener } from './listener';
import { VoicePlayer, type Chunk } from './player';
import { isEcho, SentenceSplitter, splitSentences, voiceCommand } from './speech';

export type VoicePhase = 'off' | 'listening' | 'thinking' | 'speaking' | 'paused';

interface VoiceState {
  /** Voice mode is on: the microphone stays open and answers are spoken. */
  active: boolean;
  phase: VoicePhase;
  /** What the microphone is hearing right now. */
  heard: string;
  error: string | null;
  /** An answer read aloud with its speaker button (outside voice mode). */
  readingId: string | null;
  /** There is an explanation to go back to after an interruption. */
  canResume: boolean;
  /** Diagnostics (`?vozdebug=1`). */
  debugLines: string[];
  debug: boolean;
  start: () => Promise<void>;
  stop: () => void;
  /** Pause button: stop talking (keeping the place) or carry on from there. */
  togglePause: () => void;
  read: (message: ChatMessage) => Promise<void>;
  stopReading: () => void;
}

// ---- conversation state (outside React: it changes on every audio event) ----

/** Sentences of each answer so far, in order (to resume from any of them). */
const chunks = new Map<string, string[]>();
const splitters = new Map<string, SentenceSplitter>();
/** Answers whose streaming finished. */
const finished = new Set<string>();
/** Answers that keep streaming but must not be spoken now (the student cut in). */
const muted = new Set<string>();
/** Answers to an interruption: after them, the interrupted explanation resumes. */
const interruptionAnswers = new Set<string>();
/** The answer being voiced. */
let speaking: string | null = null;
/** Where the interrupted explanation continues. */
let resumePoint: { messageId: string; from: number } | null = null;
/** Last sentence the student heard before cutting in (context for Claude). */
let lastHeard: string | null = null;
let expectInterruptionAnswer = false;
/** A question asked while the previous answer was still streaming. */
let pending: { text: string; interruptedAfter?: string } | null = null;
let utterance = '';
let silenceTimer: ReturnType<typeof setTimeout> | undefined;
let listener: Listener | null = null;
let settingsLoaded = false;
/** Page the explanation is about: where it started, then wherever Claude points. */
let focusPage: number | null = null;
/** Results right after a question is sent are its own tail, not a new interruption. */
let quietUntil = 0;
/** The sentence before the one playing, whose echo can still be heard. */
let previousHeard = '';
const QUIET_MS = 1500;
/** Single words that are enough to cut Claude off. */
const BARGE_WORDS = /^(espera|para|oye|perdona|perdon|stop|calla)$/;

/**
 * Diagnostics shown in the voice bar: open the app once with `?vozdebug=1` (`=0`
 * turns it off). Phones have no console, so the lines go on screen.
 */
function debugEnabled() {
  try {
    const flag = new URLSearchParams(location.search).get('vozdebug');
    if (flag === '1') localStorage.setItem('pca.voice.debug', '1');
    if (flag === '0') localStorage.removeItem('pca.voice.debug');
    return localStorage.getItem('pca.voice.debug') === '1';
  } catch {
    return false;
  }
}
let debug = false;
let debugTimer: ReturnType<typeof setInterval> | undefined;

function debugLine(line: string) {
  if (!debug) return;
  console.debug('[voice]', line);
  const at = new Date().toLocaleTimeString('es', { hour12: false });
  set({ debugLines: [...get().debugLines, `${at} ${line}`].slice(-8) });
}

const BRIDGE = 'Sigo con lo que te estaba contando.';

const set = (patch: Partial<VoiceState>) => useVoice.setState(patch);
const get = () => useVoice.getState();

const player = new VoicePlayer({
  onStart: (c) => {
    previousHeard = lastHeard ?? '';
    lastHeard = c.text;
    if (get().active) set({ phase: 'speaking' });
  },
  onIdle: () => {
    if (!get().active) {
      set({ readingId: null });
      return;
    }
    if (get().phase === 'paused') return;
    if (speaking && !finished.has(speaking)) {
      set({ phase: 'thinking' });
      return;
    }
    afterAnswer(speaking);
  },
});

/**
 * Keeps the screen on while voice mode runs: if the phone locked itself, the browser
 * would cut the microphone and the voice. Taken again when the page comes back.
 */
let wakeLock: WakeLockSentinel | null = null;
async function keepAwake() {
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
    wakeLock?.addEventListener('release', () => (wakeLock = null));
  } catch {
    wakeLock = null;
  }
}
function letSleep() {
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && get().active && !wakeLock) void keepAwake();
});

/** Answers that closed the explanation (`VOICE_END`): the podcast stops there. */
const ended = new Set<string>();
let continueTimer: ReturnType<typeof setTimeout> | undefined;
/** A breath between answers, so the student can jump in before Claude carries on. */
const CONTINUE_DELAY_MS = 700;

/**
 * An answer has been spoken: go back to the explanation it interrupted, or (podcast
 * style) ask Claude to carry on, until it says it is done or the student talks.
 */
function afterAnswer(id: string | null) {
  if (resumePoint && resumePoint.messageId !== id) return resume(true);
  set({ phase: 'listening', canResume: resumePoint !== null });
  if (id && ended.has(id)) return;
  clearTimeout(continueTimer);
  continueTimer = setTimeout(() => {
    const busy =
      !get().active ||
      get().phase !== 'listening' ||
      utterance !== '' ||
      player.busy ||
      pending !== null ||
      useChat.getState().running;
    if (!busy) carryOn();
  }, CONTINUE_DELAY_MS);
}

function carryOn() {
  set({ phase: 'thinking' });
  useChat.getState().send(t.voice.continued, {
    continueExplaining: true,
    ...(focusPage ? { page: focusPage } : {}),
  });
}

function reset() {
  chunks.clear();
  splitters.clear();
  finished.clear();
  muted.clear();
  interruptionAnswers.clear();
  speaking = null;
  resumePoint = null;
  lastHeard = null;
  expectInterruptionAnswer = false;
  pending = null;
  utterance = '';
  ended.clear();
  clearTimeout(continueTimer);
  focusPage = null;
  quietUntil = 0;
  previousHeard = '';
  clearTimeout(silenceTimer);
}

async function loadSettings() {
  if (settingsLoaded) return;
  const [status, settings] = await Promise.all([
    api<TtsStatus>('/tts').catch(() => ({ available: false })),
    api<AppSettings>('/settings').catch(() => null),
  ]);
  player.serverVoices = status.available;
  player.settings = settings?.voice ?? DEFAULT_VOICE;
  settingsLoaded = true;
}

/** Settings → "Voz de Claude" changed. */
export function setVoiceSettings(settings: VoiceSettings) {
  player.settings = settings;
}

/** Speaks a sample with the chosen voice (Settings). */
export async function previewVoice(settings: VoiceSettings) {
  await loadSettings();
  player.settings = settings;
  player.stop();
  player.enqueue({ text: t.voice.sample, messageId: 'preview', index: 0 });
}

function feed(messageId: string, sentences: string[]) {
  const list = chunks.get(messageId) ?? [];
  chunks.set(messageId, list);
  for (const text of sentences) {
    const index = list.push(text) - 1;
    if (!muted.has(messageId) && speaking === messageId && get().phase !== 'paused') {
      player.enqueue({ text, messageId, index });
    }
  }
}

/** Continues the interrupted explanation from the sentence the student cut. */
function resume(withBridge: boolean) {
  const point = resumePoint;
  if (!point) {
    // "Sigue" / the play button with nothing cut short: carry on explaining.
    set({ phase: 'listening', canResume: false });
    afterAnswer(null);
    return;
  }
  resumePoint = null;
  muted.delete(point.messageId);
  speaking = point.messageId;
  const list = chunks.get(point.messageId) ?? [];
  set({ phase: 'speaking', canResume: false });
  if (withBridge && point.from < list.length)
    player.enqueue({ text: BRIDGE, messageId: 'bridge', index: 0 });
  list
    .slice(point.from)
    .forEach((text, i) =>
      player.enqueue({ text, messageId: point.messageId, index: point.from + i }),
    );
  if (!player.busy) set({ phase: 'listening' });
}

/** The student started talking over Claude: stop and remember where it was. */
function interrupt() {
  const playing: Chunk | null = player.stop();
  const cut = playing ?? (speaking ? { messageId: speaking, index: 0, text: '' } : null);
  // Cutting in on an answer to an earlier interruption keeps the original place.
  if (cut && cut.messageId !== 'bridge' && !interruptionAnswers.has(cut.messageId)) {
    resumePoint = { messageId: cut.messageId, from: cut.index };
  }
  if (speaking) muted.add(speaking);
  set({ phase: 'listening', canResume: resumePoint !== null });
}

const normalizeWord = (w: string) =>
  w
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');

/** Real speech from the student: not Claude's voice, noise or the tail of a question. */
function isBargeIn(text: string) {
  if (performance.now() < quietUntil) return false;
  if (isEcho(text, `${previousHeard} ${player.playing?.text ?? lastHeard ?? ''}`)) return false;
  // The echo-cancelled microphone must hear a voice (null: not available here).
  if (listener?.userSpeaking() === false) return false;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length >= 2 || BARGE_WORDS.test(normalizeWord(words[0] ?? ''));
}

function onHeard(text: string, final: boolean) {
  if (!get().active) return;
  if (debug) {
    debugLine(
      `${final ? 'final' : 'parcial'} «${text}» · nivel ${listener?.level.toFixed(3)} · voz ${String(listener?.userSpeaking())} · micro ${listener?.mode}`,
    );
  }
  const talking =
    player.playing !== null || (get().phase === 'thinking' && speaking && !muted.has(speaking));
  // The student is talking: Claude does not carry on by itself meanwhile.
  if (talking ? isBargeIn(text) : performance.now() >= quietUntil) clearTimeout(continueTimer);
  if (talking) {
    if (!isBargeIn(text)) return;
    interrupt();
  } else if (performance.now() < quietUntil) {
    return;
  }
  if (final) utterance = `${utterance} ${text}`.trim();
  set({ heard: final ? utterance : `${utterance} ${text}`.trim() });
  clearTimeout(silenceTimer);
  const interim = final ? '' : text;
  // End of the question: a short pause after a complete phrase.
  silenceTimer = setTimeout(
    () => {
      const said = `${utterance} ${interim}`.trim();
      utterance = '';
      set({ heard: '' });
      if (said) submit(said);
    },
    final ? 900 : 2000,
  );
}

function submit(text: string) {
  const command = voiceCommand(text);
  if (command === 'resume') return resume(false);
  if (command === 'pause') {
    set({ phase: 'paused', canResume: resumePoint !== null });
    return;
  }
  const interruptedAfter = resumePoint ? (lastHeard ?? undefined) : undefined;
  expectInterruptionAnswer = resumePoint !== null;
  if (useChat.getState().running) {
    pending = { text, interruptedAfter };
    set({ phase: 'thinking' });
    return;
  }
  ask(text, interruptedAfter);
}

function ask(text: string, interruptedAfter?: string) {
  set({ phase: 'thinking' });
  quietUntil = performance.now() + QUIET_MS;
  // Scrolling while listening must not change the subject: an interruption is about
  // the page being explained; a new question is about the page on screen.
  const page = interruptedAfter && focusPage ? focusPage : useReader.getState().currentPage;
  focusPage = page;
  useChat.getState().send(text, { interruptedAfter, page });
}

// A question waiting for the previous answer to finish streaming.
useChat.subscribe((s, prev) => {
  // Another conversation (document, thread): this one is over.
  if (s.threadId !== prev.threadId && get().active) {
    get().stop();
    return;
  }
  if (prev.running && !s.running && pending && get().active) {
    const q = pending;
    pending = null;
    ask(q.text, q.interruptedAfter);
  }
});

chatSocket.subscribe((event) => {
  if (!get().active) return;
  if ('threadId' in event && event.threadId !== useChat.getState().threadId) return;
  switch (event.type) {
    case 'assistant_start': {
      const id = event.message.id;
      speaking = id;
      chunks.set(id, []);
      splitters.set(id, new SentenceSplitter());
      if (expectInterruptionAnswer) interruptionAnswers.add(id);
      expectInterruptionAnswer = false;
      set({ phase: 'thinking' });
      break;
    }
    case 'assistant_delta': {
      const splitter = splitters.get(event.messageId);
      if (splitter) feed(event.messageId, splitter.push(event.text));
      break;
    }
    case 'assistant_done': {
      const id = event.message.id;
      const splitter = splitters.get(id);
      if (splitter) feed(id, splitter.flush());
      finished.add(id);
      if (event.message.content.includes(VOICE_END)) ended.add(id);
      if (!player.busy && speaking === id && get().phase !== 'paused') afterAnswer(id);
      break;
    }
    case 'pointer':
      // Claude points where it is explaining: that is the page of the conversation.
      if (event.group.docId === useReader.getState().docId) focusPage = event.group.page;
      break;
    case 'error':
      if (!player.busy) set({ phase: 'listening' });
      break;
    default:
      break;
  }
});

export const useVoice = create<VoiceState>(() => ({
  active: false,
  phase: 'off',
  heard: '',
  error: null,
  readingId: null,
  canResume: false,
  debugLines: [],
  debug: false,

  start: async () => {
    if (get().active) return;
    if (!Listener.supported()) {
      set({ error: t.voice.unsupported });
      return;
    }
    player.stop();
    player.unlock();
    reset();
    debug = debugEnabled();
    set({
      active: true,
      phase: 'listening',
      heard: '',
      error: null,
      readingId: null,
      debug,
      debugLines: [],
    });
    useChat.getState().setVoice(true);
    void keepAwake();
    // Start listening inside the tap: phones refuse the microphone outside a gesture.
    listener = new Listener({
      onResult: onHeard,
      onError: (code) => {
        debugLine(`error visible: ${code}`);
        set({
          error:
            code === 'not-allowed' || code === 'service-not-allowed'
              ? t.voice.denied
              : code === 'network'
                ? t.voice.network
                : t.voice.error,
        });
      },
      onDebug: debugLine,
    });
    listener.start();
    debugLine(`inicio · ${navigator.userAgent.includes('Android') ? 'Android' : 'escritorio'}`);
    await loadSettings();
    debugLine(`voz del servidor: ${player.serverVoices ? 'sí' : 'no'}`);
    clearInterval(debugTimer);
    if (debug) {
      debugTimer = setInterval(() => {
        if (!listener) return;
        debugLine(
          `estado ${get().phase} · micro ${listener.mode} · nivel ${listener.level.toFixed(3)} · voz ${String(listener.userSpeaking())} · escuchando ${listener.listening ? 'sí' : 'no'}`,
        );
      }, 3000);
    }
    player.warm();
  },

  stop: () => {
    clearInterval(debugTimer);
    letSleep();
    listener?.stop();
    listener = null;
    player.stop();
    reset();
    useChat.getState().setVoice(false);
    set({ active: false, phase: 'off', heard: '', canResume: false });
  },

  togglePause: () => {
    const { phase } = get();
    if (phase === 'paused') resume(false);
    else if (phase === 'speaking' || phase === 'thinking') {
      interrupt();
      set({ phase: 'paused' });
    } else if (resumePoint) resume(false);
  },

  read: async (message) => {
    if (get().active) return;
    player.stop();
    player.unlock();
    await loadSettings();
    set({ readingId: message.id });
    splitSentences(message.content).forEach((text, index) =>
      player.enqueue({ text, messageId: message.id, index }),
    );
    if (!player.busy) set({ readingId: null });
  },

  stopReading: () => {
    player.stop();
    set({ readingId: null });
  },
}));
