import {
  DEFAULT_STUDY_TIMER,
  STUDY_METHODS,
  timerDurations,
  type AppSettings,
  type StudyMethod,
  type StudyTimerSettings,
  type TimerDurations,
} from '@pdfclaudeassistant/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { t } from '../../i18n';
import { api } from '../../lib/api';
import { settingsKey, useSettings } from '../annotations/api';
import { useTimer } from './store';

const FIELDS: { key: keyof TimerDurations; min: number; max: number }[] = [
  { key: 'focusMin', min: 1, max: 240 },
  { key: 'shortBreakMin', min: 1, max: 120 },
  { key: 'longBreakMin', min: 1, max: 120 },
  { key: 'cyclesBeforeLongBreak', min: 0, max: 12 },
];

/** Method and options of the study timer, saved on the server with the other settings. */
export function TimerOptions() {
  const qc = useQueryClient();
  const current = useSettings().data?.studyTimer ?? DEFAULT_STUDY_TIMER;
  const running = useTimer((s) => s.timer.status !== 'idle');
  const [draft, setDraft] = useState<Partial<Record<keyof TimerDurations, string>>>({});

  const save = async (patch: Partial<StudyTimerSettings>) => {
    const studyTimer = { ...current, ...patch };
    useTimer.getState().syncSettings(studyTimer);
    const next = await api<AppSettings>('/settings', { method: 'PATCH', json: { studyTimer } });
    qc.setQueryData(settingsKey, next);
  };

  const saveField = (key: keyof TimerDurations, min: number, max: number) => {
    const raw = draft[key];
    setDraft((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
    if (raw === undefined) return;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) return;
    void save({ custom: { ...current.custom, [key]: value } });
  };

  const durations = timerDurations(current);

  return (
    <details className="border-border border-t pt-3 text-sm">
      <summary className="text-text-muted hover:text-text cursor-pointer">
        {t.timer.options}
      </summary>
      <div className="mt-3 space-y-3">
        <label className="block space-y-1">
          <span className="text-text-muted text-xs">{t.timer.method}</span>
          <select
            value={current.method}
            onChange={(e) => {
              const method = e.target.value as StudyMethod;
              // Starting a custom method from the preset in use.
              void save(
                method === 'custom' && current.method !== 'custom'
                  ? { method, custom: durations }
                  : { method },
              );
            }}
            className="border-border bg-surface w-full rounded-lg border px-2 py-1.5"
          >
            {STUDY_METHODS.map((m) => (
              <option key={m} value={m}>
                {t.timer.methods[m]}
              </option>
            ))}
          </select>
        </label>
        {current.method === 'custom' && (
          <div className="grid grid-cols-2 gap-2">
            {FIELDS.map(({ key, min, max }) => (
              <label key={key} className="space-y-1">
                <span className="text-text-muted block text-xs leading-tight">
                  {t.timer.custom[key]}
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={min}
                  max={max}
                  value={draft[key] ?? String(current.custom[key])}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                  onBlur={() => saveField(key, min, max)}
                  onKeyDown={(e) => e.key === 'Enter' && saveField(key, min, max)}
                  className="border-border bg-surface w-full rounded-lg border px-2 py-1"
                />
              </label>
            ))}
          </div>
        )}
        {(
          [
            ['sound', t.timer.sound],
            ['breakScreen', t.timer.breakScreen],
            ['autoStartFocus', t.timer.autoStartFocus],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={current[key]}
              onChange={(e) => void save({ [key]: e.target.checked })}
              className="mt-0.5 size-4 shrink-0"
            />
            {label}
          </label>
        ))}
        {running && <p className="text-text-muted text-xs">{t.timer.appliesNext}</p>}
      </div>
    </details>
  );
}
