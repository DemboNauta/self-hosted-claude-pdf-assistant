import type { Diagram } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTurnPrompt } from '../src/claude/prompt.js';
import { diagramTools, type ToolContext, type ToolDeps } from '../src/claude/tools.js';
import type { Db } from '../src/db/client.js';
import { AnnotationService } from '../src/services/annotations.js';
import { checkDiagramSource, DiagramService } from '../src/services/diagrams.js';
import { LibraryService } from '../src/services/library.js';
import { MemoryService } from '../src/services/memory.js';
import { ReviewService } from '../src/services/review.js';
import { SearchService } from '../src/services/search.js';
import { SettingsService } from '../src/services/settings.js';
import { authedApp, seedDocument, tempDataDir } from './helpers.js';

let app: FastifyInstance;
let headers: Record<string, string>;
let docId: string;
let events: unknown[];
let tools: ReturnType<typeof diagramTools>;

const MINDMAP = 'mindmap\n  root((Fotosíntesis))\n    Fase luminosa\n    Ciclo de Calvin';

beforeEach(async () => {
  ({ app, headers } = await authedApp(tempDataDir('pca-diag-')));
  ({ docId } = await seedDocument(app, headers, [['La fotosíntesis.'], ['El ciclo de Calvin.']]));
  const db = (app as unknown as { pcaDb: Db }).pcaDb;
  events = [];
  const ctx: ToolContext = {
    threadId: 't',
    messageId: 'm',
    docId,
    scope: { kind: 'document', id: docId },
    emit: (e) => events.push(e),
    record: () => {},
  };
  const deps: ToolDeps = {
    db,
    library: new LibraryService(db, {} as never),
    search: new SearchService(db),
    annotations: new AnnotationService(db),
    settings: new SettingsService(db),
    memory: new MemoryService(db),
    review: new ReviewService(db),
    diagrams: new DiagramService(db),
  };
  tools = diagramTools(deps, ctx);
});
afterEach(() => app.close());

const call = async (name: string, args: unknown) =>
  JSON.stringify(await tools.find((t) => t.name === name)!.handler(args as never, {}));
const get = async <T>(url: string) => (await app.inject({ url, headers })).json<T>();

describe('diagrams', () => {
  it('saves diagrams from Claude, updates them in place and lists them', async () => {
    const created = await call('create_diagram', {
      title: 'Fotosíntesis',
      mermaid: MINDMAP,
      fromPage: 1,
      toPage: 2,
    });
    const id = /Saved diagram ([0-9a-z]+)/.exec(created)![1]!;
    expect(created).toContain(`[[diagram:${id}]]`);
    expect(events).toContainEqual({ type: 'data_changed', threadId: 't', scope: 'diagrams' });

    const flow = 'flowchart TD\n  A["Fotosíntesis"] --> B["Fase luminosa"]';
    expect(await call('update_diagram', { id, mermaid: flow })).toContain('Updated diagram');
    const one = await get<Diagram>(`/api/diagrams/${id}`);
    expect(one).toMatchObject({
      title: 'Fotosíntesis',
      source: flow,
      fromPage: 1,
      toPage: 2,
      documentId: docId,
      documentTitle: expect.any(String),
    });
    expect((await get<Diagram[]>(`/api/documents/${docId}/diagrams`)).map((d) => d.id)).toEqual([
      id,
    ]);

    await app.inject({
      method: 'PATCH',
      url: `/api/diagrams/${id}`,
      headers,
      payload: { title: 'Esquema' },
    });
    expect((await get<Diagram[]>('/api/diagrams'))[0]!.title).toBe('Esquema');

    // A PDF in the trash hides its diagrams; deleting a diagram removes it.
    await app.inject({ method: 'DELETE', url: `/api/documents/${docId}`, headers });
    expect(await get<Diagram[]>('/api/diagrams')).toEqual([]);
    const del = await app.inject({ method: 'DELETE', url: `/api/diagrams/${id}`, headers });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ url: `/api/diagrams/${id}`, headers })).statusCode).toBe(404);
  });

  it('rejects diagram sources it cannot safely render', async () => {
    expect(checkDiagramSource(MINDMAP)).toBeNull();
    expect(checkDiagramSource('sequenceDiagram\n A->>B: hi')).toMatch(/Start with/);
    expect(checkDiagramSource('flowchart TD\n A-->B\n click A call alert()')).toMatch(/click/);
    expect(checkDiagramSource('%%{init: {"theme":"dark"}}%%\nmindmap\n root')).toMatch(/Start/);
    const result = await call('create_diagram', {
      title: 'x',
      mermaid: 'graph TD\n style A fill:red',
    });
    expect(result).toContain('isError');
    expect(await get<Diagram[]>('/api/diagrams')).toEqual([]);
    expect(await call('update_diagram', { id: 'nope', mermaid: MINDMAP })).toContain('Unknown');
  });

  it('asks Claude for a diagram of a page range', () => {
    const prompt = buildTurnPrompt({
      text: '',
      mode: 'diagram',
      context: { docId, pageRange: { from: 14, to: 20 } },
      scope: [],
    });
    expect(prompt).toContain('Scope: pages 14 to 20.');
    expect(prompt).toContain('Mode "Diagram"');
    expect(prompt).toContain('create_diagram');
  });
});
