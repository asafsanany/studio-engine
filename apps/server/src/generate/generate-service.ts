// The Generate stage of a generated job (Generated videos, GN0). Only the contract is here: the
// service answers what the table `job_generate` holds. The run itself, the spend and the errors
// are GN5's; it extends this interface (and says "CONTRACT CHANGE:").
//
//   state(jobId)    the job's GenerateState (`GET /api/jobs/:id/generate`), or 404 for a job that
//                   has no Generate stage
//   history(jobId)  what the stage did, oldest first (`GET /api/jobs/:id/generate/history`, GN5):
//                   the events the engine wrote to the job's edit/generate/history.jsonl; 404 as above
//
// While the Generate switch is off the engine uses `disabledGenerateService` and mounts no route:
// nothing of Generated videos exists, and the table is never read (JobRepository gets the same
// switch). When it is on, `createGenerateService` reads the repository.

import { GENERATE_MESSAGES, type GenerateHistoryEvent, type GenerateState } from '@studio/shared';
import { type GenerateRepository, toGenerateState } from '../db/generate-repository.js';

/** What a question about a job's Generate stage came to. */
export type GenerateOutcome =
  | { ok: true; state: GenerateState }
  | { ok: false; status: 404; error: string };

/** What a question about a job's Generate History came to. */
export type GenerateHistoryOutcome =
  | { ok: true; events: GenerateHistoryEvent[] }
  | { ok: false; status: 404; error: string };

export interface GenerateService {
  /** Whether Generated videos are on: false for {@link disabledGenerateService}. */
  readonly enabled: boolean;
  /** The job's Generate state, or 404 {@link GENERATE_MESSAGES}.notGenerated (off: `.off`). */
  state(jobId: string): Promise<GenerateOutcome>;
  /** The job's Generate History, oldest first, or the same 404s as `state`. */
  history(jobId: string): Promise<GenerateHistoryOutcome>;
}

const OFF: GenerateOutcome = { ok: false, status: 404, error: GENERATE_MESSAGES.off };

/** The service while the Generate switch is off: nothing to read, every question refused 404. */
export const disabledGenerateService: GenerateService = {
  enabled: false,
  state: async () => OFF,
  history: async () => OFF,
};

export interface GenerateServiceOptions {
  /**
   * Reads a job's History (`readGenerateHistory` of its edit/ folder). The engine passes it; left
   * out, every History is empty.
   */
  history?: (jobId: string) => Promise<GenerateHistoryEvent[]>;
}

export function createGenerateService(
  repo: Pick<GenerateRepository, 'get'>,
  { history }: GenerateServiceOptions = {},
): GenerateService {
  const notGenerated = { ok: false, status: 404, error: GENERATE_MESSAGES.notGenerated } as const;
  return {
    enabled: true,
    state: async (jobId) => {
      const row = repo.get(jobId);
      return row === null ? notGenerated : { ok: true, state: toGenerateState(row) };
    },
    history: async (jobId) => {
      if (repo.get(jobId) === null) return notGenerated;
      return { ok: true, events: history === undefined ? [] : await history(jobId) };
    },
  };
}
