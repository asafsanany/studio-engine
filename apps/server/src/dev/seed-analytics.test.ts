import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AnalyticsResponse,
  analyticsResponseSchema,
  computeCredits,
  computePlan,
  USAGE_GROUPS,
  USAGE_TAG_INFO,
} from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { NoteRepository, StepRunRepository } from '../db/index.js';
import { memoryDb } from '../db/test-utils.js';
import { buildAnalyticsSeed, writeAnalyticsSeed } from './seed-analytics.js';
import { CANVAS_NOW, startCanvasServer } from './seed-canvas.js';

const DAY = 86_400_000;
const CANVAS_NOW_MS = Date.parse(CANVAS_NOW);

// Moments of different days of the week, to see the seed holds whenever it is run.
const MOMENTS = [
  CANVAS_NOW_MS, // a Tuesday
  Date.parse('2026-10-18T06:30:00.000Z'), // a Sunday morning: nothing of this week is over yet
  Date.parse('2026-10-24T20:00:00.000Z'), // a Saturday night
  Date.parse('2026-10-22T09:00:00.000Z'), // a Thursday
];

describe('buildAnalyticsSeed', () => {
  const seed = buildAnalyticsSeed(CANVAS_NOW_MS);

  it('fills the two budgets: the app’s last day and a half is API credits, the open window is the plan’s week', () => {
    // After the app moved to the API key (23 Oct 2026); the canvas clock is a few days before it.
    const now = Date.parse('2026-10-24T09:00:00.000Z');
    const later = buildAnalyticsSeed(now);
    const input = {
      now,
      timeZone: 'UTC',
      jobs: [],
      stepRuns: [],
      sentNotes: [],
      deliveries: [],
      usage: later.usage,
      limits: later.limits,
      noteTopics: {},
    };
    const credits = computeCredits(input);
    expect(credits.spentUsd).toBeGreaterThan(30);
    expect(credits.tags.rows[0]?.label).toBe('revise');
    expect(credits.jobs.rows.length).toBeGreaterThanOrEqual(3);
    const plan = computePlan(input);
    expect(plan.week).not.toBeNull();
    expect(plan.coveredUsd).toBeGreaterThan(0);
    expect(plan.tags.rows.length).toBeGreaterThanOrEqual(3);
  });

  it('has 30 to 45 finished jobs, 2 to 5 a week and more of them lately, of six clients', () => {
    expect(seed.jobs.length).toBeGreaterThanOrEqual(30);
    expect(seed.jobs.length).toBeLessThanOrEqual(45);
    expect(new Set(seed.jobs.map((job) => job.client)).size).toBe(6);
    const early = seed.jobs.filter((job) => job.weeksAgo >= 9).length;
    const late = seed.jobs.filter((job) => job.weeksAgo <= 3).length;
    expect(late).toBeGreaterThan(early);
    // Every job has its own id and its own place in the inbox.
    expect(new Set(seed.jobs.map((job) => job.id)).size).toBe(seed.jobs.length);
    expect(new Set(seed.jobs.map((job) => `${job.client}/${job.name}`)).size).toBe(
      seed.jobs.length,
    );
  });

  it('times every step of every job, all of them ended, in the order the review round is read from', () => {
    for (const job of seed.jobs) {
      const steps = job.runs.map((run) => run.step);
      // The edit run: Brief to Check; a revise run (Plan to Check) per round; the render.
      expect(steps.slice(0, 7), job.name).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(
        steps.filter((step) => step === 8),
        job.name,
      ).toHaveLength(1);
      expect(job.runs.filter((run) => run.runKind === 'revise')).toHaveLength(job.round * 4);
      for (const run of job.runs) expect(run.endedAt, job.name).toBeGreaterThan(run.startedAt);
      const ordered = [...job.runs].sort((a, b) => a.startedAt - b.startedAt);
      expect(ordered.map((run) => run.step)).toEqual(steps);
      expect(job.addedAt).toBeLessThan(job.startedAt);
      expect(job.approvedAt).toBeLessThan(job.finishedAt);
    }
  });

  it('has the notes of the rounds, a topic for all but the newest three, all in English', () => {
    const notes = seed.jobs.flatMap((job) => job.notes);
    expect(notes.length).toBeGreaterThanOrEqual(30);
    expect(Object.keys(seed.topics)).toHaveLength(notes.length - 3);
    expect(new Set(Object.values(seed.topics)).size).toBeGreaterThanOrEqual(10);
    expect(notes.some((note) => /[֐-׿]/.test(note.text))).toBe(false);
    for (const job of seed.jobs) {
      // A round of notes is sent before its revise run, and as many rounds as the job has.
      expect(new Set(job.notes.map((note) => note.round)).size).toBe(job.round);
    }
  });

  it('has usage lines in all four groups and a limit log with one week that hit the limit', () => {
    const groups = new Set(seed.usage.map((entry) => USAGE_TAG_INFO[entry.tag].group));
    expect([...groups].sort()).toEqual([...USAGE_GROUPS].sort());
    expect(seed.usage.some((entry) => entry.source === 'app' && entry.job !== undefined)).toBe(
      true,
    );
    expect(seed.limits.some((reading) => reading.status === 'rejected')).toBe(true);
    expect(seed.limits.filter((reading) => reading.status !== 'allowed')).toHaveLength(1);
  });

  it.each(MOMENTS)('puts nothing in the future when it is run at %d', (now) => {
    const built = buildAnalyticsSeed(now);
    const times: number[] = [];
    for (const job of built.jobs) {
      times.push(job.finishedAt, job.approvedAt);
      for (const run of job.runs) times.push(run.endedAt);
      for (const note of job.notes) times.push(note.sentAt);
      if (job.delivery !== null) times.push(job.delivery.deliveredAt);
    }
    for (const entry of built.usage) times.push(Date.parse(entry.at));
    for (const reading of built.limits) times.push(Date.parse(reading.at));
    expect(Math.max(...times)).toBeLessThanOrEqual(now);
    // And the work begins in the first of the 13 weeks of the calendar.
    expect(Math.min(...built.jobs.map((job) => job.addedAt))).toBeLessThan(now - 11 * 7 * DAY);
  });

  it('is the same data for the same moment (apart from the notes’ ids)', () => {
    const again = buildAnalyticsSeed(CANVAS_NOW_MS);
    const strip = (built: typeof seed) =>
      JSON.stringify({
        ...built,
        jobs: built.jobs.map((job) => ({
          ...job,
          notes: job.notes.map((n) => ({ ...n, id: '' })),
        })),
        topics: Object.values(built.topics).sort(),
      });
    expect(strip(again)).toBe(strip(seed));
  });
});

describe('writeAnalyticsSeed', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('writes the jobs, steps, notes and deliveries, and the three files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'seed-analytics-'));
    dirs.push(dir);
    const db = memoryDb();
    const seed = buildAnalyticsSeed(CANVAS_NOW_MS);
    await writeAnalyticsSeed(db, dir, join(dir, 'exports'), seed);

    const runs = new StepRunRepository(db).listAll();
    expect(runs).toHaveLength(seed.jobs.reduce((total, job) => total + job.runs.length, 0));
    expect(runs.every((run) => run.endedAt !== null)).toBe(true);
    // The rounds are read off the order the runs were written in: they match what was planned.
    for (const job of seed.jobs) {
      const own = runs.filter((run) => run.jobId === job.id);
      expect(Math.max(...own.map((run) => run.round)), job.name).toBe(job.round);
    }
    expect(new NoteRepository(db).listAllSent()).toHaveLength(
      seed.jobs.reduce((total, job) => total + job.notes.length, 0),
    );

    const lines = (await readFile(join(dir, 'usage.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(seed.usage.length);
    const limits = (await readFile(join(dir, 'limits.jsonl'), 'utf8')).trim().split('\n');
    expect(limits).toHaveLength(seed.limits.length);
    const topics = JSON.parse(await readFile(join(dir, 'note-topics.json'), 'utf8'));
    expect(topics).toEqual(seed.topics);
    // A placeholder export for each job.
    const first = seed.jobs[0];
    expect(
      (await readFile(join(dir, 'exports', `${first?.client}/${first?.name}.mp4`))).length,
    ).toBe(16_000);
  });
});

describe('the Analytics page of the canvas seed (--analytics)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function start(options: { analytics?: boolean; empty?: boolean }) {
    const webDist = await mkdtemp(join(tmpdir(), 'seed-web-'));
    await writeFile(join(webDist, 'index.html'), '<!doctype html>');
    const server = await startCanvasServer({ now: 'canvas', webDist, ...options });
    cleanups.push(async () => {
      await server.stop();
      await rm(webDist, { recursive: true, force: true });
    });
    return server;
  }

  it('turns the switch on and answers every section with numbers, as the board shows them', async () => {
    const server = await start({ analytics: true });
    expect(await (await fetch(`${server.url}/api/health`)).json()).toMatchObject({
      analytics: true,
    });
    const answer = analyticsResponseSchema.parse(
      await (await fetch(`${server.url}/api/analytics`)).json(),
    ) as AnalyticsResponse;

    // The five tiles all have a number and something to compare with.
    for (const tile of answer.jobs.tiles) {
      expect(tile.value, tile.key).not.toBeNull();
      expect(tile.previous, tile.key).not.toBeNull();
    }
    expect(answer.jobs.tiles.find((tile) => tile.key === 'clients')?.value).toBe(6);
    expect(answer.jobs.deliveredPerDay.some((day) => (day.count ?? 0) > 0)).toBe(true);
    expect(answer.jobs.footage.every((week) => week.hours !== null)).toBe(true);

    // A typical job, with the slowest step.
    expect(answer.typicalJob.jobsCounted).toBeGreaterThanOrEqual(8);
    expect(answer.typicalJob.slowestStepKey).toBe('cut');
    expect(answer.typicalJob.stages.every((stage) => stage.medianSec !== null)).toBe(true);

    // Reviews: a line over 12 weeks, ranked topics, three notes not grouped yet.
    expect(answer.reviews.approvedFirstTime.every((week) => week.share !== null)).toBe(true);
    expect(answer.reviews.noteTopics.length).toBeGreaterThanOrEqual(10);
    expect(answer.reviews.notGroupedYet).toBe(3);

    // Claude use: the limit was hit in one of the 8 weeks, and every week splits four ways.
    expect(answer.claudeUse.busiest.every((week) => week.peak !== null)).toBe(true);
    expect(answer.claudeUse.busiest.filter((week) => week.hitLimit)).toHaveLength(1);
    // The daily readings of the last 14 days (for the Week period) leave the weekly bars alone.
    expect(answer.claudeUse.busiest.map((week) => week.peak)).toEqual([
      0.31, 0.44, 1, 0.52, 0.61, 0.47, 0.58, 0.38,
    ]);
    // API value per finished minute: the first weeks are before the app logged its runs.
    const value = answer.claudeUse.apiValuePerFinishedMinute;
    expect(value.slice(0, 2).every((week) => week.usdPerMinute === null)).toBe(true);
    expect(value.slice(3).every((week) => week.usdPerMinute !== null)).toBe(true);
  });

  it('answers the Week period full too: numbers in every tile and a bar or a point for most days', async () => {
    const server = await start({ analytics: true });
    const answer = analyticsResponseSchema.parse(
      await (await fetch(`${server.url}/api/analytics?period=week`)).json(),
    ) as AnalyticsResponse;

    expect(answer.period).toBe('week');
    // The five tiles compare the last 7 days with the 7 before, and have a value for every day.
    for (const tile of answer.jobs.tiles) {
      expect(tile.value, tile.key).not.toBeNull();
      expect(tile.previous, tile.key).not.toBeNull();
      expect(tile.series, tile.key).toHaveLength(14);
    }
    const jobsFinished = answer.jobs.tiles.find((tile) => tile.key === 'jobs-finished');
    expect(jobsFinished?.value).toBeGreaterThanOrEqual(3);
    expect(jobsFinished?.series.every((count) => count !== null)).toBe(true);
    expect(answer.typicalJob.jobsCounted).toBeGreaterThanOrEqual(2);
    expect(answer.typicalJob.jobsCountedBefore).toBeGreaterThanOrEqual(2);

    // Footage and approvals fall on most of the days; a quiet day is a zero and a null for a day
    // with no approval.
    expect(answer.jobs.footage.every((day) => day.hours !== null)).toBe(true);
    expect(answer.jobs.footage.filter((day) => (day.hours ?? 0) > 0).length).toBeGreaterThanOrEqual(
      7,
    );
    expect(
      answer.reviews.approvedFirstTime.filter((day) => day.approved > 0).length,
    ).toBeGreaterThanOrEqual(6);

    // Busiest day: a bar for every day but Saturdays and the days before the first reading, and
    // one day at 100% of the five hours.
    const busiest = answer.claudeUse.busiest;
    expect(busiest.filter((day) => day.peak !== null).length).toBeGreaterThanOrEqual(10);
    expect(busiest.filter((day) => day.hitLimit)).toHaveLength(1);
    expect(busiest.at(-1)?.current).toBe(true);

    // API cost per finished minute: a point for most days.
    expect(
      answer.claudeUse.apiValuePerFinishedMinute.filter((day) => day.usdPerMinute !== null).length,
    ).toBeGreaterThanOrEqual(6);
  });

  it('serves the jobs of the seed, with their exports', async () => {
    const server = await start({ analytics: true });
    const jobs = (await (await fetch(`${server.url}/api/jobs`)).json()) as { id: string }[];
    expect(jobs.length).toBeGreaterThanOrEqual(30);
    const download = await fetch(`${server.url}/api/jobs/${jobs[0]?.id}/download`);
    expect(download.status).toBe(200);
    await download.arrayBuffer();
  });

  it('is on with nothing recorded when it is empty: the empty page', async () => {
    const server = await start({ analytics: true, empty: true });
    const answer = analyticsResponseSchema.parse(
      await (await fetch(`${server.url}/api/analytics`)).json(),
    );
    expect(answer.jobs.tiles.every((tile) => tile.value === null)).toBe(true);
    expect(answer.typicalJob.jobsCounted).toBe(0);
    expect(answer.reviews.noteTopics).toEqual([]);
  });

  it('leaves the switch off without the option: no page numbers are served', async () => {
    const server = await start({});
    expect(await (await fetch(`${server.url}/api/health`)).json()).toMatchObject({
      analytics: false,
    });
    expect((await fetch(`${server.url}/api/analytics`)).status).toBe(404);
  });

  it('refuses --analytics together with --review or --series', async () => {
    await expect(startCanvasServer({ analytics: true, review: true })).rejects.toThrow(
      '--analytics seeds its own rows',
    );
    await expect(startCanvasServer({ analytics: true, series: true })).rejects.toThrow(
      '--analytics seeds its own rows',
    );
  });
});
