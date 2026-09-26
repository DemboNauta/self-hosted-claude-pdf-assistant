import {
  VOICE_IDS,
  type AppSettings,
  type VoiceId,
  type VoiceSettings,
} from '@pdfclaudeassistant/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Volume2 } from 'lucide-react';
import { useId, useState } from 'react';
import { t } from '../../i18n';
import { api } from '../../lib/api';
import { settingsKey, useSettings } from '../annotations/api';
import { previewVoice, setVoiceSettings } from '../voice/store';

/** Claude's voice and speed for voice mode (F-CHAT-09). */
export function VoiceSettingsSection() {
  const settings = useSettings();
  return settings.data ? <VoiceForm initial={settings.data.voice} /> : null;
}

function VoiceForm({ initial }: { initial: VoiceSettings }) {
  const qc = useQueryClient();
  const [voice, setVoice] = useState<VoiceSettings>(initial);
  const [saved, setSaved] = useState(false);
  const ids = { voice: useId(), rate: useId() };

  const save = async (next: VoiceSettings) => {
    setVoice(next);
    setVoiceSettings(next);
    const res = await api<AppSettings>('/settings', { method: 'PATCH', json: { voice: next } });
    qc.setQueryData(settingsKey, res);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <section aria-labelledby="voice" className="space-y-4">
      <h2 id="voice" className="text-lg font-medium">
        {t.voice.settings.title}
      </h2>
      <p className="text-text-muted text-sm">{t.voice.settings.help}</p>
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <label htmlFor={ids.voice} className="block text-sm">
            {t.voice.settings.voice}
          </label>
          <select
            id={ids.voice}
            value={voice.voice}
            onChange={(e) => void save({ ...voice, voice: e.target.value as VoiceId })}
            className="border-border bg-surface rounded-lg border px-3 py-1.5 text-sm"
          >
            {VOICE_IDS.map((v) => (
              <option key={v} value={v}>
                {t.voice.settings.voices[v]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor={ids.rate} className="block text-sm">
            {t.voice.settings.rate} · {voice.rate.toFixed(1)}×
          </label>
          <input
            id={ids.rate}
            type="range"
            min={0.7}
            max={1.6}
            step={0.1}
            value={voice.rate}
            onChange={(e) => setVoice({ ...voice, rate: Number(e.target.value) })}
            onPointerUp={() => void save(voice)}
            onKeyUp={() => void save(voice)}
            className="w-40"
          />
        </div>
        <button
          type="button"
          onClick={() => void previewVoice(voice)}
          className="border-border flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm"
        >
          <Volume2 size={14} aria-hidden />
          {t.voice.settings.preview}
        </button>
        {saved && (
          <p role="status" className="text-text-muted text-sm">
            {t.settings.saved}
          </p>
        )}
      </div>
    </section>
  );
}
