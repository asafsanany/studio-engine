import { generateStateSchema, initialGenerateState } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { StudioDb } from './database.js';
import { GenerateRepository, toGenerateState } from './generate-repository.js';
import { fakeClock, memoryDb, rawRow, T0 } from './test-utils.js';

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

function setup() {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const repo = new GenerateRepository(db, { clock });
  return { clock, db, repo };
}

describe('GenerateRepository.start', () => {
  it('stores a row at the planning phase with nothing made, nothing spent and the budget', () => {
    const { repo, db } = setup();

    const row = repo.start('job-a', 3);

    expect(row).toEqual({
      jobId: 'job-a',
      ...initialGenerateState(3),
      elevenlabsChars: 0,
      updatedAt: T0,
    });
    expect(rawRow(db, 'job_generate')).toEqual([
      {
        job_id: 'job-a',
        phase: 'plan',
        voice_done: 0,
        voice_total: 0,
        looks_done: 0,
        looks_total: 0,
        keyframes_done: 0,
        keyframes_total: 0,
        clips_done: 0,
        clips_total: 0,
        below_bar: 0,
        spend_usd: 0,
        budget_usd: 3,
        elevenlabs_chars: 0,
        updated_at: Date.parse(T0),
      },
    ]);
  });

  it('keeps the progress of a row that is there, and sets the budget again (a note may have raised it)', () => {
    const { repo, clock } = setup();
    repo.start('job-a', 3);
    repo.update('job-a', { phase: 'clips', clips: { done: 4, total: 6 }, spendUsd: 1.65 });
    clock.tick(5_000);

    const again = repo.start('job-a', 5);

    expect(again.phase).toBe('clips');
    expect(again.counts.clips).toEqual({ done: 4, total: 6 });
    expect(again.spendUsd).toBe(1.65);
    expect(again.budgetUsd).toBe(5);
    expect(again.updatedAt).toBe('2026-10-20T10:00:05.000Z');
    // The same budget again changes nothing, not even the time.
    clock.tick(5_000);
    expect(repo.start('job-a', 5).updatedAt).toBe('2026-10-20T10:00:05.000Z');
  });

  it('refuses a budget of nothing and an empty job id', () => {
    const { repo } = setup();
    expect(() => repo.start('job-a', 0)).toThrow();
    expect(() => repo.start('job-a', -1)).toThrow();
    expect(() => repo.start('', 3)).toThrow();
  });
});

describe('GenerateRepository.get and states', () => {
  it('is null for a job without a row', () => {
    const { repo } = setup();
    expect(repo.get('nobody')).toBeNull();
  });

  it('gives the state the page shows, without the job id, the characters and the time', () => {
    const { repo } = setup();
    const stored = repo.start('job-a', 3);
    const state = toGenerateState(stored);
    expect(state).toEqual(initialGenerateState(3));
    expect(generateStateSchema.safeParse(state).success).toBe(true);
    expect(state).not.toHaveProperty('jobId');
    expect(state).not.toHaveProperty('elevenlabsChars');
  });

  it('reads the states of many jobs at once, leaving out the ones without a row', () => {
    const { repo } = setup();
    repo.start('job-a', 3);
    repo.start('job-b', 5);
    repo.update('job-b', { phase: 'voice' });

    const states = repo.states(['job-a', 'job-b', 'job-c']);

    expect([...states.keys()].sort()).toEqual(['job-a', 'job-b']);
    expect(states.get('job-b')?.phase).toBe('voice');
    expect(states.get('job-b')?.budgetUsd).toBe(5);
    expect(repo.states([])).toEqual(new Map());
  });
});

describe('GenerateRepository.update', () => {
  it('changes only the fields it is given, and the time', () => {
    const { repo, clock } = setup();
    repo.start('job-a', 3);
    clock.tick(1_000);

    const row = repo.update('job-a', {
      phase: 'voice',
      voice: { done: 3, total: 7 },
      clips: { done: 0, total: 6 },
    });

    expect(row).toMatchObject({
      phase: 'voice',
      counts: {
        voice: { done: 3, total: 7 },
        looks: { done: 0, total: 0 },
        keyframes: { done: 0, total: 0 },
        clips: { done: 0, total: 6 },
        belowBar: 0,
      },
      spendUsd: 0,
      budgetUsd: 3,
      updatedAt: '2026-10-20T10:00:01.000Z',
    });
  });

  it('stores every part, the dollars and the clips below the bar', () => {
    const { repo } = setup();
    repo.start('job-a', 3);

    const row = repo.update('job-a', {
      phase: 'done',
      voice: { done: 7, total: 7 },
      looks: { done: 3, total: 3 },
      keyframes: { done: 7, total: 7 },
      clips: { done: 6, total: 6 },
      belowBar: 1,
      spendUsd: 3,
      budgetUsd: 4,
    });

    expect(row?.counts).toEqual({
      voice: { done: 7, total: 7 },
      looks: { done: 3, total: 3 },
      keyframes: { done: 7, total: 7 },
      clips: { done: 6, total: 6 },
      belowBar: 1,
    });
    expect(row).toMatchObject({ phase: 'done', spendUsd: 3, budgetUsd: 4 });
  });

  it('is null for a job without a row, and writes nothing', () => {
    const { repo, db } = setup();
    expect(repo.update('nobody', { phase: 'voice' })).toBeNull();
    expect(rawRow(db, 'job_generate')).toEqual([]);
  });

  it('refuses values the contract does not have', () => {
    const { repo } = setup();
    repo.start('job-a', 3);
    expect(() => repo.update('job-a', { phase: 'dreaming' as never })).toThrow();
    expect(() => repo.update('job-a', { spendUsd: -1 })).toThrow();
    expect(() => repo.update('job-a', { budgetUsd: 0 })).toThrow();
    expect(() => repo.update('job-a', { voice: { done: 1.5, total: 2 } })).toThrow();
    expect(() => repo.update('job-a', { belowBar: -1 })).toThrow();
    expect(repo.get('job-a')?.phase).toBe('plan');
  });
});

describe('GenerateRepository.addSpend and addVoiceChars', () => {
  it('adds dollars without float noise, and moves the time', () => {
    const { repo, clock } = setup();
    repo.start('job-a', 3);
    clock.tick(2_000);
    repo.addSpend('job-a', 0.1);
    const row = repo.addSpend('job-a', 0.2);
    expect(row?.spendUsd).toBe(0.3);
    expect(row?.updatedAt).toBe('2026-10-20T10:00:02.000Z');
    repo.addSpend('job-a', 0.004);
    expect(repo.get('job-a')?.spendUsd).toBe(0.304);
  });

  it('adds ElevenLabs characters', () => {
    const { repo } = setup();
    repo.start('job-a', 3);
    repo.addVoiceChars('job-a', 58);
    expect(repo.addVoiceChars('job-a', 42)?.elevenlabsChars).toBe(100);
  });

  it('are null for a job without a row, and refuse a negative amount', () => {
    const { repo } = setup();
    expect(repo.addSpend('nobody', 1)).toBeNull();
    expect(repo.addVoiceChars('nobody', 1)).toBeNull();
    repo.start('job-a', 3);
    expect(() => repo.addSpend('job-a', -1)).toThrow();
    expect(() => repo.addVoiceChars('job-a', -1)).toThrow();
    expect(() => repo.addVoiceChars('job-a', 1.5)).toThrow();
  });
});

describe('GenerateRepository.remove', () => {
  it('deletes the row and says whether there was one', () => {
    const { repo } = setup();
    repo.start('job-a', 3);
    expect(repo.remove('job-a')).toBe(true);
    expect(repo.get('job-a')).toBeNull();
    expect(repo.remove('job-a')).toBe(false);
  });
});
