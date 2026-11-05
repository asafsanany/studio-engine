import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiErrorSchema, GENERATE_MESSAGES, generateNotePlanSchema } from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { JobRepository, type StudioDb } from '../db/index.js';
import { makeScan, memoryDb } from '../db/test-utils.js';
import { readReviewPlan } from '../generate/review-plan.js';
import { ROUTE_POLICIES } from '../team/route-policies.js';

// Generated videos, GN8: GET /api/jobs/:id/generate/review-plan answers the clips and voice lines
// the note hints in Review read, from edit/generate/shots.json and voice-words.json. 404 for an
// unknown job and for a job with no hand-off yet; with the switch off the route does not exist.

const opened: StudioDb[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SHOTS = {
  shots: [
    {
      id: 'A',
      file: 'clips/A/take-1.mp4',
      take: 1,
      windows: [
        { startSec: 0, endSec: 3 },
        { startSec: 8, endSec: 10.2 },
      ],
      seconds: 5,
      shows: 'The hero skylight',
      model: 'kling-2-5-turbo',
      usd: 0.36,
      belowBar: false,
    },
    {
      id: 'B',
      file: 'clips/B/take-2.mp4',
      take: 2,
      windows: [{ startSec: 3, endSec: 8 }],
      seconds: 5,
      shows: 'He pours water',
      model: 'wan-3-0',
      usd: 0.51,
      belowBar: true,
    },
  ],
};

const WORDS = {
  words: [
    { line: 'L1', text: 'You', startSec: 3, endSec: 3.4 },
    { line: 'L1', text: 'always', startSec: 3.4, endSec: 3.9 },
    { line: 'L2', text: 'But', startSec: 6.6, endSec: 7 },
    { line: 'L2', text: 'what', startSec: 7, endSec: 7.4 },
  ],
};

function harness({ generate = true }: { generate?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'studio-generate-review-'));
  dirs.push(base);
  const inboxPath = join(base, 'inbox');
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { generate });
  const generated = jobs.upsertFromScan(makeScan('Pinewood', '97 Window Ad')).job;
  const bare = jobs.upsertFromScan(makeScan('Horizon FPV', 'Demo 2')).job;
  const generateDir = join(inboxPath, generated.relPath, 'edit', 'generate');
  mkdirSync(generateDir, { recursive: true });
  const write = (name: string, body: unknown): void =>
    writeFileSync(join(generateDir, name), typeof body === 'string' ? body : JSON.stringify(body));
  const app: Hono = createApp({
    jobs: { jobs, exportsDir: join(base, 'exports') },
    generate,
    generateReviewRoutes: { jobs, inboxPath },
  });
  return { app, generated, bare, write, generateDir, inboxPath };
}

describe('GET /api/jobs/:id/generate/review-plan', () => {
  it('answers the clips and the voice lines', async () => {
    const h = harness();
    h.write('shots.json', SHOTS);
    h.write('voice-words.json', WORDS);

    const res = await h.app.request(`/api/jobs/${h.generated.id}/generate/review-plan`);

    expect(res.status).toBe(200);
    expect(generateNotePlanSchema.parse(await res.json())).toEqual({
      clips: [
        {
          id: 'A',
          usd: 0.36,
          shows: 'The hero skylight',
          belowBar: false,
          windows: [
            { startSec: 0, endSec: 3 },
            { startSec: 8, endSec: 10.2 },
          ],
        },
        {
          id: 'B',
          usd: 0.51,
          shows: 'He pours water',
          belowBar: true,
          windows: [{ startSec: 3, endSec: 8 }],
        },
      ],
      lines: [
        { id: 'L1', startSec: 3, endSec: 3.9 },
        { id: 'L2', startSec: 6.6, endSec: 7.4 },
      ],
    });
  });

  it('has no voice lines when voice-words.json is missing or broken', async () => {
    const h = harness();
    h.write('shots.json', SHOTS);
    expect((await readReviewPlan(join(h.inboxPath, h.generated.relPath)))?.lines).toEqual([]);
    h.write('voice-words.json', '{ nope');
    expect((await readReviewPlan(join(h.inboxPath, h.generated.relPath)))?.lines).toEqual([]);
  });

  it('answers 404 until shots.json is valid, and for an unknown job', async () => {
    const h = harness();
    const none = await h.app.request(`/api/jobs/${h.generated.id}/generate/review-plan`);
    expect(none.status).toBe(404);
    expect(apiErrorSchema.parse(await none.json())).toEqual({
      error: GENERATE_MESSAGES.notGenerated,
    });
    h.write('shots.json', { shots: [{ id: 'A' }] });
    expect((await h.app.request(`/api/jobs/${h.generated.id}/generate/review-plan`)).status).toBe(
      404,
    );
    expect((await h.app.request('/api/jobs/nope/generate/review-plan')).status).toBe(404);
    expect((await h.app.request(`/api/jobs/${h.bare.id}/generate/review-plan`)).status).toBe(404);
  });

  it('does not exist while the Generate switch is off', async () => {
    const h = harness({ generate: false });
    h.write('shots.json', SHOTS);
    const res = await h.app.request(`/api/jobs/${h.generated.id}/generate/review-plan`);
    expect(res.status).toBe(404);
  });

  it('has a route policy', () => {
    expect(
      ROUTE_POLICIES.some(
        (row) => row.method === 'GET' && row.pattern === '/api/jobs/:id/generate/review-plan',
      ),
    ).toBe(true);
  });
});
