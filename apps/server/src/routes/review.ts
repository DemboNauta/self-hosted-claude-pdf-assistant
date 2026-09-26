import {
  createFlashcardsSchema,
  reviewQuerySchema,
  reviewSchema,
  updateFlashcardSchema,
} from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RequestServices } from '../services/scope.js';
import { parse } from './validate.js';

const idParams = z.object({ id: z.string().min(1).max(64) });
const dayQuery = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** Flashcards, review queue, daily brief and statistics (F-REV-01..05). */
export async function registerReviewRoutes(app: FastifyInstance, svc: RequestServices) {
  const id = (params: unknown) => parse(idParams, params).id;

  app.get('/api/flashcards', async (req) =>
    svc(req).review.list(parse(reviewQuerySchema, req.query)),
  );
  app.post('/api/flashcards', async (req, reply) =>
    reply
      .code(201)
      .send(svc(req).review.create(parse(createFlashcardsSchema, req.body).cards, 'user')),
  );
  app.patch('/api/flashcards/:id', async (req) =>
    svc(req).review.update(id(req.params), parse(updateFlashcardSchema, req.body)),
  );
  app.delete('/api/flashcards/:id', async (req, reply) => {
    svc(req).review.delete(id(req.params));
    return reply.code(204).send();
  });
  app.post('/api/flashcards/:id/review', async (req) => {
    const { rating, day } = parse(reviewSchema, req.body);
    return svc(req).review.review(id(req.params), rating, day);
  });
  app.get('/api/review/queue', async (req) =>
    svc(req).review.queue(parse(reviewQuerySchema, req.query)),
  );

  app.get('/api/review/today', async (req) => svc(req).brief.today(parse(dayQuery, req.query).day));
  app.post('/api/review/today', async (req) =>
    svc(req).brief.generate(parse(dayQuery, req.query).day),
  );

  app.get('/api/stats', async (req) => svc(req).stats.stats(parse(dayQuery, req.query).day));
}
