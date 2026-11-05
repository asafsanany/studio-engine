import { GENERATE_MESSAGES, generateStateSchema, initialGenerateState } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { GenerateRepository, type StudioDb } from '../db/index.js';
import { memoryDb } from '../db/test-utils.js';
import { createGenerateService, disabledGenerateService } from './generate-service.js';

// Generated videos, GN0: the service only answers what job_generate holds. The disabled one is the
// engine's while the switch is off.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

describe('disabledGenerateService', () => {
  it('is not enabled, and answers every question 404 "Generated videos are off."', async () => {
    expect(disabledGenerateService.enabled).toBe(false);
    expect(await disabledGenerateService.state('any')).toEqual({
      ok: false,
      status: 404,
      error: GENERATE_MESSAGES.off,
    });
    expect(await disabledGenerateService.history('any')).toEqual({
      ok: false,
      status: 404,
      error: GENERATE_MESSAGES.off,
    });
  });
});

describe('createGenerateService', () => {
  function setup() {
    const db = memoryDb();
    opened.push(db);
    const repo = new GenerateRepository(db);
    return { repo, service: createGenerateService(repo) };
  }

  it('is enabled', () => {
    expect(setup().service.enabled).toBe(true);
  });

  it('answers a job’s state from its row', async () => {
    const { repo, service } = setup();
    repo.start('job-a', 3);
    repo.update('job-a', { phase: 'voice', voice: { done: 3, total: 7 } });

    const outcome = await service.state('job-a');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(generateStateSchema.safeParse(outcome.state).success).toBe(true);
    expect(outcome.state.phase).toBe('voice');
    expect(outcome.state.counts.voice).toEqual({ done: 3, total: 7 });
    expect(outcome.state).not.toHaveProperty('elevenlabsChars');
  });

  it('answers a fresh row as the start of a run', async () => {
    const { repo, service } = setup();
    repo.start('job-a', 5);
    expect(await service.state('job-a')).toEqual({ ok: true, state: initialGenerateState(5) });
  });

  it('answers 404 "This job is not a generated video." for a job with no row', async () => {
    const { service } = setup();
    expect(await service.state('job-a')).toEqual({
      ok: false,
      status: 404,
      error: GENERATE_MESSAGES.notGenerated,
    });
  });
});

describe('the History of a job (GN5)', () => {
  it('is what the engine’s reader gives for a job with a row, and 404 for one without', async () => {
    const db = memoryDb();
    opened.push(db);
    const repo = new GenerateRepository(db);
    const event = { kind: 'keyframes', at: '2026-10-25T14:11:00.000Z', clips: 6 } as const;
    const asked: string[] = [];
    const service = createGenerateService(repo, {
      history: async (jobId) => {
        asked.push(jobId);
        return [event];
      },
    });
    repo.start('job-a', 3);

    expect(await service.history('job-a')).toEqual({ ok: true, events: [event] });
    expect(await service.history('job-b')).toEqual({
      ok: false,
      status: 404,
      error: GENERATE_MESSAGES.notGenerated,
    });
    // The file of a job that has no stage is never looked at.
    expect(asked).toEqual(['job-a']);
  });

  it('is empty when no reader is given', async () => {
    const db = memoryDb();
    opened.push(db);
    const repo = new GenerateRepository(db);
    repo.start('job-a', 3);
    expect(await createGenerateService(repo).history('job-a')).toEqual({ ok: true, events: [] });
  });
});
