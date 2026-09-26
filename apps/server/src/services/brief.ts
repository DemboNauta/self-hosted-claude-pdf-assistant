import type { query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { DailyBrief } from '@pdfclaudeassistant/shared';
import { and, desc, isNotNull, isNull, sql } from 'drizzle-orm';
import { baseAgentOptions } from '../claude/options.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { documents, settings as settingsTable } from '../db/schema.js';
import type { LibraryService } from './library.js';
import type { MemoryService } from './memory.js';
import type { ReviewService } from './review.js';
import type { SettingsService } from './settings.js';
import { HttpError } from './errors.js';

type QueryFn = typeof query;

const BRIEF_PROMPT = `You prepare the student's daily review card in a study app. Write in Spanish, in Markdown, at most about 180 words, warm but concise. No preamble, no headings bigger than ###.
Structure:
1. For each difficult concept listed (at most 3): one line with the concept in bold followed by either a one-sentence reminder or a short question to self-test (alternate).
2. A final line starting with "**Hoy te propongo:**" suggesting what to read or review next, based on the reading progress and pending notes.
Do not invent facts about documents you have not seen; stay general when unsure.`;

interface Stored {
  day: string;
  text: string;
  generatedAt: string;
}

/** "Repaso de hoy" (F-REV-03): due cards, weak concepts and a short note by Claude. */
export class BriefService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly review: ReviewService,
    private readonly memory: MemoryService,
    private readonly library: LibraryService,
    private readonly settings: SettingsService,
    private readonly runQuery: QueryFn,
  ) {}

  today(day: string): DailyBrief {
    const stored = this.stored();
    const concepts = this.memory
      .concepts({ limit: 50 })
      .filter((c) => c.mastery < 0.7)
      .slice(0, 3)
      .map((c) => ({
        id: c.id,
        name: c.name,
        mastery: c.mastery,
        documentId: c.documentId,
        page: c.page,
      }));
    return {
      day,
      dueCount: this.review.dueCount(),
      concepts,
      text: stored?.day === day ? stored.text : null,
      generatedAt: stored?.day === day ? stored.generatedAt : null,
      continueReading: this.continueReading(),
    };
  }

  /** Asks Claude for today's note (one short request per day, cached). */
  async generate(day: string): Promise<DailyBrief> {
    const brief = this.today(day);
    const memory = brief.continueReading
      ? this.memory.contextFor(brief.continueReading.id)
      : undefined;
    const facts = [
      `Cards due today: ${brief.dueCount}.`,
      brief.concepts.length
        ? `Difficult concepts: ${brief.concepts.map((c) => `${c.name} (mastery ${c.mastery.toFixed(2)})`).join(', ')}.`
        : 'No difficult concepts recorded yet.',
      brief.continueReading
        ? `Last document read: "${brief.continueReading.title}", page ${brief.continueReading.lastPage}, ${brief.continueReading.progressPct}% read.`
        : 'Nothing read yet.',
      memory ? `What you know about the student:\n${memory}` : '',
    ].join('\n');

    let text = '';
    const q = this.runQuery({
      prompt: facts,
      options: {
        ...baseAgentOptions(this.config),
        ...(this.settings.claudeModel() ? { model: this.settings.claudeModel()! } : {}),
        systemPrompt: BRIEF_PROMPT,
        maxTurns: 1,
        persistSession: false,
      },
    });
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'result') {
        if (msg.subtype !== 'success' || msg.is_error) throw new HttpError(502, 'claude_failed');
        text = msg.result.trim();
      }
    }
    if (!text) throw new HttpError(502, 'claude_failed');
    const stored: Stored = { day, text, generatedAt: new Date().toISOString() };
    this.db
      .insert(settingsTable)
      .values({ key: 'daily_brief', value: JSON.stringify(stored) })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: JSON.stringify(stored) } })
      .run();
    return this.today(day);
  }

  private stored(): Stored | null {
    const row = this.db
      .select()
      .from(settingsTable)
      .where(sql`${settingsTable.key} = 'daily_brief'`)
      .get();
    return row ? (JSON.parse(row.value) as Stored) : null;
  }

  private continueReading(): DailyBrief['continueReading'] {
    const row = this.db
      .select({ id: documents.id })
      .from(documents)
      .where(and(isNull(documents.deletedAt), isNotNull(documents.lastOpenedAt)))
      .orderBy(desc(documents.lastOpenedAt))
      .limit(1)
      .get();
    if (!row) return null;
    const d = this.library.summary(row.id);
    return { id: d.id, title: d.title, lastPage: d.lastPage, progressPct: d.progressPct };
  }
}
