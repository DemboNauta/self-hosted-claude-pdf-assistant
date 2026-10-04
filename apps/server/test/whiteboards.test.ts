import type {
  BoardStep,
  ServerChatEvent,
  ThreadSummary,
  Whiteboard,
} from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { whiteboardTools, type ToolContext } from '../src/claude/tools.js';
import { authedApp, seedDocument, servicesOf, tempDataDir } from './helpers.js';

let app: FastifyInstance;
let headers: Record<string, string>;
let docId: string;
let threadId: string;

beforeEach(async () => {
  ({ app, headers } = await authedApp(tempDataDir('pca-board-')));
  ({ docId } = await seedDocument(app, headers, [['La fotosíntesis ocurre en los cloroplastos.']]));
  threadId = (
    await app.inject({ url: `/api/documents/${docId}/threads/active`, headers })
  ).json<ThreadSummary>().id;
});
afterEach(() => app.close());

describe('whiteboard', () => {
  it('lets Claude draw steps, with PDF crops, that the board keeps', async () => {
    const events: ServerChatEvent[] = [];
    const ctx: ToolContext = {
      threadId,
      messageId: 'msg1',
      docId,
      scope: { kind: 'document', id: docId },
      emit: (e) => events.push(e),
      record: () => {},
    };
    const draw = whiteboardTools(servicesOf(app), ctx).find((t) => t.name === 'whiteboard_draw');
    const first = JSON.stringify(
      await draw!.handler(
        {
          elements: [
            { type: 'rect', id: 'luz', x: 100, y: 50, w: 200, h: 80, label: 'Luz' },
            { type: 'rect', id: 'azucar', x: 500, y: 50, w: 200, h: 80, label: 'Azúcar' },
            { type: 'arrow', from: 'luz', to: 'azucar', label: 'fotosíntesis' },
          ],
        } as never,
        {},
      ),
    );
    expect(first).toContain('[[mark:w1]]');
    expect(first).toContain('y ≈ 130');
    expect(first).toContain('Ids on the board: luz, azucar');

    const second = await draw!.handler(
      {
        elements: [
          { type: 'pdf', page: 1, region: { x: 0, y: 0, w: 1, h: 0.2 }, x: 100, y: 200, w: 400 },
        ],
      } as never,
      {},
    );
    expect(JSON.stringify(second)).toContain('[[mark:w2]]');

    const steps = events
      .filter((e): e is Extract<ServerChatEvent, { type: 'board_step' }> => e.type === 'board_step')
      .map((e) => e.step);
    expect(steps.map((s) => s.id)).toEqual(['w1', 'w2']);
    const crop = steps[1]!.elements[0] as Extract<BoardStep['elements'][number], { type: 'pdf' }>;
    expect(crop.docId).toBe(docId);
    expect(crop.h).toBeGreaterThan(0);
    expect(steps[1]!.files![crop.fileId]).toMatch(/^data:image\/png;base64,/);

    const board = (
      await app.inject({ url: `/api/threads/${threadId}/whiteboard`, headers })
    ).json<Whiteboard>();
    expect(board.steps.map((s) => s.id)).toEqual(['w1', 'w2']);
    expect(board.scene).toBeNull();

    // The result shows the board and points out problems; amend fixes the same step.
    const crowded = JSON.stringify(
      await draw!.handler(
        {
          elements: [{ type: 'text', id: 'nota', x: 110, y: 60, text: 'Encima de la caja' }],
        } as never,
        {},
      ),
    );
    expect(crowded).toContain('"type":"image"');
    expect(crowded).toContain('already has text');
    const fixed = JSON.stringify(
      await draw!.handler(
        {
          amend: 'w3',
          elements: [{ type: 'text', id: 'nota', x: 110, y: 400, text: 'Debajo de la caja' }],
        } as never,
        {},
      ),
    );
    expect(fixed).toContain('Step w3 changed');
    expect(fixed).toContain('No overlaps found');

    // Bad Mermaid is refused before anything is stored.
    const bad = await draw!.handler({ mermaid: 'pie\n "a": 1' } as never, {});
    expect(bad.isError).toBe(true);
  });

  it('saves the scene the browser has, only on the user’s own threads', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/threads/${threadId}/whiteboard`,
      headers,
      payload: {
        scene: { elements: [{ id: 'a', type: 'rectangle' }], files: {} },
        applied: ['msg1:w1'],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Whiteboard>()).toMatchObject({
      scene: { elements: [{ id: 'a' }] },
      applied: ['msg1:w1'],
    });
    const missing = await app.inject({ url: '/api/threads/nope/whiteboard', headers });
    expect(missing.statusCode).toBe(404);
  });

  it("shows Claude the student's drawing and tells it when the board changed", async () => {
    const png = 'data:image/png;base64,' + Buffer.from('fake png').toString('base64');
    const save = (studentEdited: boolean) =>
      app.inject({
        method: 'PUT',
        url: `/api/threads/${threadId}/whiteboard`,
        headers,
        payload: {
          scene: { elements: [{ id: 'a' }], files: {} },
          applied: [],
          snapshot: { png, bounds: { x: 10, y: 20, w: 300, h: 200 } },
          studentEdited,
        },
      });
    const svc = servicesOf(app);
    expect(svc.whiteboards.status(threadId)).toEqual({
      hasContent: false,
      studentChanged: false,
      linkedPage: null,
    });
    expect((await save(true)).statusCode).toBe(200);
    expect(svc.whiteboards.status(threadId)).toEqual({
      hasContent: true,
      studentChanged: true,
      linkedPage: null,
    });

    const ctx: ToolContext = {
      threadId,
      messageId: 'm',
      docId,
      scope: { kind: 'document', id: docId },
      emit: () => {},
      record: () => {},
    };
    const view = whiteboardTools(svc, ctx).find((t) => t.name === 'whiteboard_view')!;
    const res = await view.handler({} as never, {});
    expect(res.content[0]).toMatchObject({
      type: 'image',
      data: Buffer.from('fake png').toString('base64'),
    });
    expect(JSON.stringify(res)).toContain('x 10 to 310 and y 20 to 220');
    // Once seen, the board only counts as changed after the student draws again.
    await new Promise((r) => setTimeout(r, 5));
    expect(svc.whiteboards.status(threadId).studentChanged).toBe(false);
    await save(false);
    expect(svc.whiteboards.status(threadId).studentChanged).toBe(false);
    await save(true);
    expect(svc.whiteboards.status(threadId).studentChanged).toBe(true);
  });
});
