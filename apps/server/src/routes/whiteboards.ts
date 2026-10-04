import { replaceBoardSchema, saveBoardSchema } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RequestServices } from '../services/scope.js';
import { parse } from './validate.js';

const idParams = z.object({ id: z.string().min(1).max(64) });

/** Scenes carry PDF crops and pasted images, so they get more room than other bodies. */
const SCENE_BODY_LIMIT = 25 * 1024 * 1024;

/** The whiteboard of a chat thread: read it, and save the browser's scene. */
export async function registerWhiteboardRoutes(app: FastifyInstance, svc: RequestServices) {
  app.get('/api/threads/:id/whiteboard', async (req) =>
    svc(req).whiteboards.get(parse(idParams, req.params).id),
  );
  app.put('/api/threads/:id/whiteboard', { bodyLimit: SCENE_BODY_LIMIT }, async (req) =>
    svc(req).whiteboards.save(parse(idParams, req.params).id, parse(saveBoardSchema, req.body)),
  );
  // A note's board onto the conversation's board (or a blank board), and back off it.
  app.post('/api/threads/:id/whiteboard/replace', async (req) =>
    svc(req).whiteboards.replace(
      parse(idParams, req.params).id,
      parse(replaceBoardSchema, req.body).boardId,
    ),
  );
  app.post('/api/threads/:id/whiteboard/unlink', async (req) =>
    svc(req).whiteboards.unlink(parse(idParams, req.params).id),
  );
}
