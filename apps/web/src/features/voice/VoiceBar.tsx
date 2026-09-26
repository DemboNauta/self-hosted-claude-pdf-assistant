import clsx from 'clsx';
import { AudioLines, Pause, Play, X } from 'lucide-react';
import { useEffect } from 'react';
import { t } from '../../i18n';
import { Listener } from './listener';
import { useVoice } from './store';

export const voiceSupported = () => Listener.supported();

/** Composer button that turns voice mode on and off (F-CHAT-09). */
export function VoiceToggle() {
  const active = useVoice((s) => s.active);
  const { start, stop } = useVoice.getState();
  return (
    <button
      type="button"
      onClick={() => (active ? stop() : void start())}
      aria-label={active ? t.voice.stop : t.voice.start}
      title={active ? t.voice.stop : t.voice.start}
      aria-pressed={active}
      data-testid="voice-toggle"
      className={clsx(
        'rounded-full p-1.5',
        active ? 'bg-accent text-accent-contrast' : 'text-text-muted hover:text-text',
      )}
    >
      <AudioLines size={14} aria-hidden />
    </button>
  );
}

/** Ends voice mode when the page that hosts the chat goes away. */
export function useEndVoiceOnLeave() {
  useEffect(() => () => useVoice.getState().stop(), []);
}

/** Status of the conversation by voice, above the composer while voice mode is on. */
export function VoiceBar() {
  const { active, phase, heard, error, canResume, debug, debugLines } = useVoice();
  const { stop, togglePause } = useVoice.getState();

  if (!active && !error) return null;
  if (!active)
    return (
      <p role="alert" className="text-danger text-xs">
        {error}
      </p>
    );
  const pausable = phase === 'speaking' || phase === 'thinking' || phase === 'paused' || canResume;
  return (
    <div
      className="border-accent/40 bg-surface-muted space-y-1 rounded-lg border px-3 py-2"
      data-testid="voice-bar"
    >
      <div className="flex items-center gap-2 text-xs">
        <span
          aria-hidden
          className={clsx(
            'size-2 shrink-0 rounded-full',
            phase === 'listening' && 'animate-pulse bg-green-600',
            phase === 'thinking' && 'animate-pulse bg-amber-500',
            phase === 'speaking' && 'bg-accent animate-pulse',
            phase === 'paused' && 'bg-text-muted',
          )}
        />
        <p className="min-w-0 flex-1 font-medium" aria-live="polite" data-testid="voice-phase">
          {t.voice.phases[phase]}
        </p>
        {pausable && (
          <button
            type="button"
            onClick={togglePause}
            aria-label={
              phase === 'paused' || phase === 'listening' ? t.voice.resume : t.voice.pause
            }
            title={phase === 'paused' || phase === 'listening' ? t.voice.resume : t.voice.pause}
            className="text-text-muted hover:text-text rounded p-0.5"
          >
            {phase === 'paused' || phase === 'listening' ? (
              <Play size={14} aria-hidden />
            ) : (
              <Pause size={14} aria-hidden />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={stop}
          aria-label={t.voice.stop}
          title={t.voice.stop}
          className="text-text-muted hover:text-text rounded p-0.5"
        >
          <X size={14} aria-hidden />
        </button>
      </div>
      <p className="text-text-muted text-xs italic" data-testid="voice-heard">
        {heard || (phase === 'listening' ? t.voice.hint : '')}
      </p>
      {error && (
        <p role="alert" className="text-danger text-xs">
          {error}
        </p>
      )}
      {debug && (
        <pre
          className="text-text-muted max-h-40 overflow-auto text-[10px] leading-tight whitespace-pre-wrap"
          data-testid="voice-debug"
        >
          {debugLines.join('\n')}
        </pre>
      )}
    </div>
  );
}
