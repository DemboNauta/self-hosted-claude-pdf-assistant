import { useEffect, useRef, useState } from 'react';

/** Minimal typing for the Web Speech API (not in the TypeScript DOM lib). */
export interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
export interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
}
export type RecognitionCtor = new () => Recognition;

export function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const dictationSupported = () => recognitionCtor() !== null;

/**
 * Voice dictation for the chat input (F-CHAT-06) with the browser's Web Speech API
 * (open decision #5, provisional choice: no server-side transcription). Final phrases
 * are appended through `onText`; `interim` shows what is being heard.
 */
export function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const cb = useRef(onText);
  useEffect(() => {
    cb.current = onText;
  }, [onText]);

  useEffect(() => () => rec.current?.stop(), []);

  const start = () => {
    const Ctor = recognitionCtor();
    if (!Ctor || rec.current) return;
    const r = new Ctor();
    r.lang = navigator.language?.toLowerCase().startsWith('es') ? navigator.language : 'es-ES';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let partial = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) cb.current(res[0].transcript.trim());
        else partial += res[0].transcript;
      }
      setInterim(partial);
    };
    r.onerror = (e) => setError(e.error);
    r.onend = () => {
      rec.current = null;
      setListening(false);
      setInterim('');
    };
    rec.current = r;
    setError(null);
    setListening(true);
    r.start();
  };

  const stop = () => rec.current?.stop();

  return { listening, interim, error, start, stop, toggle: () => (listening ? stop() : start()) };
}
