import type { query } from '@anthropic-ai/claude-agent-sdk';
import type { FastifyRequest } from 'fastify';
import type { ClaudeCredentials } from '../claude/credentials.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { AnnotationService } from './annotations.js';
import { BriefService } from './brief.js';
import { DiagramService } from './diagrams.js';
import { FocusService } from './focus.js';
import { LibraryService } from './library.js';
import { MemoryService } from './memory.js';
import { ReviewService } from './review.js';
import { SearchService } from './search.js';
import { SettingsService } from './settings.js';
import { StatsService } from './stats.js';
import { ThreadService } from './threads.js';

/**
 * The services of one user. Every service is bound to the user's id and only reads or
 * writes that user's rows, so a route or a Claude tool cannot reach another user's
 * data by passing a foreign id: it simply is not found.
 */
export interface UserServices {
  userId: string;
  db: Db;
  library: LibraryService;
  search: SearchService;
  threads: ThreadService;
  annotations: AnnotationService;
  settings: SettingsService;
  memory: MemoryService;
  review: ReviewService;
  diagrams: DiagramService;
  focus: FocusService;
  stats: StatsService;
  brief: BriefService;
}

export type ServicesFor = (userId: string) => UserServices;

/** Services are plain objects over the shared connection, so building them is cheap. */
export function servicesFactory(
  db: Db,
  config: AppConfig,
  credentials: ClaudeCredentials,
  runQuery: typeof query,
): ServicesFor {
  return (userId) => {
    const library = new LibraryService(db, config, userId);
    const settings = new SettingsService(db, userId);
    const memory = new MemoryService(db, userId);
    const review = new ReviewService(db, userId);
    return {
      userId,
      db,
      library,
      search: new SearchService(db, userId),
      threads: new ThreadService(db, userId),
      annotations: new AnnotationService(db, userId),
      settings,
      memory,
      review,
      diagrams: new DiagramService(db, userId),
      focus: new FocusService(db, userId),
      stats: new StatsService(db, library, userId),
      brief: new BriefService(
        db,
        config,
        review,
        memory,
        library,
        settings,
        runQuery,
        credentials,
        userId,
      ),
    };
  };
}

/** The logged-in user's services for a request (routes are behind the auth guard). */
export type RequestServices = (req: FastifyRequest) => UserServices;
