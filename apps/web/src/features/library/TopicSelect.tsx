import type { LibraryTree } from '@pdfclaudeassistant/shared';
import { t } from '../../i18n';

/** Topic picker grouped by subject (move a PDF, restore from the trash). */
export function TopicSelect({
  tree,
  value,
  onChange,
  label,
  exclude,
}: {
  tree: LibraryTree;
  value: string;
  onChange: (topicId: string) => void;
  label: string;
  exclude?: string | null;
}) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-medium">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        className="border-border bg-bg w-full rounded-lg border px-3 py-2 text-base"
      >
        <option value="" disabled>
          {t.library.trash.chooseTopic}
        </option>
        {tree.subjects
          .filter((s) => s.topics.length > 0)
          .map((s) => (
            <optgroup key={s.id} label={s.name}>
              {s.topics
                .filter((tp) => tp.id !== exclude)
                .map((tp) => (
                  <option key={tp.id} value={tp.id}>
                    {tp.name}
                  </option>
                ))}
            </optgroup>
          ))}
      </select>
    </label>
  );
}
