import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReviewNote } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeJob } from '../events/test-utils.js';
import { buildRoutePrompt, type RoutePromptVars } from './fix-route-prompt.js';
import { ClaudeNoteRouter, type RouteRunner, type RouteRunRequest } from './fix-router.js';

// The quick-fix router's prompt for a generated video (GN6): one more section tells Haiku that a
// note about what a shot shows, or about how the voice says a line, needs a new take and is full.
// Any other job's prompt is what it was, byte for byte.

const GOLDEN_DIR = fileURLToPath(new URL('../pipeline/testdata/prompts/', import.meta.url));

const GOLDEN_VARS: Omit<RoutePromptVars, 'editAdded'> = {
  atSec: 72.34,
  text: 'תעשה את הכתוביות צהובות, "Heebo Bold" {{client}}\nואחר כך גם הכותרת',
};

describe('the router prompt', () => {
  it('is the golden snapshot for a job that is not generated, with the flag false or left out', async () => {
    const golden = readFileSync(`${GOLDEN_DIR}fix-route-without-project.txt`, 'utf8');
    expect(await buildRoutePrompt({ ...GOLDEN_VARS, editAdded: null })).toBe(golden);
    expect(await buildRoutePrompt({ ...GOLDEN_VARS, editAdded: null, generated: false })).toBe(
      golden,
    );
    expect(golden).not.toContain('generated video');
  });

  it('has one more section for a generated video, after the note and before the answer', async () => {
    const plain = await buildRoutePrompt({ ...GOLDEN_VARS, editAdded: null });
    const prompt = await buildRoutePrompt({ ...GOLDEN_VARS, editAdded: null, generated: true });
    expect(prompt.split('## About this video')).toHaveLength(2);
    expect(prompt).toContain('This is a generated video');
    expect(prompt).toContain('sort it as full, never quick and never revise');
    expect(prompt).toContain('a hand, a face, the logo, the water');
    expect(prompt).toContain('how the voice says a line');
    expect(prompt.indexOf('Note, as a JSON string:')).toBeLessThan(
      prompt.indexOf('## About this video'),
    );
    expect(prompt.indexOf('## About this video')).toBeLessThan(prompt.indexOf('# Your answer'));
    // Nothing else moves: take the section out and it is the plain prompt.
    const section = readFileSync(
      fileURLToPath(new URL('../../prompts/fix-generated.md', import.meta.url)),
      'utf8',
    ).trimEnd();
    expect(prompt.replace(`\n${section}\n`, '')).toBe(plain);
  });

  it('comes after "What the edit added" and "About the cut" when they are there', async () => {
    const prompt = await buildRoutePrompt({
      atSec: 12.5,
      text: 'cut on the beat',
      editAdded: '## Composition\nCaptions at the bottom.',
      aboutCut: '- The cut is beat-synced at 120 BPM.',
      generated: true,
    });
    expect(prompt.indexOf('## What the edit added')).toBeLessThan(
      prompt.indexOf('## About the cut'),
    );
    expect(prompt.indexOf('## About the cut')).toBeLessThan(prompt.indexOf('## About this video'));
    expect(prompt.indexOf('## About this video')).toBeLessThan(prompt.indexOf('# Your answer'));
  });
});

describe('the Haiku router', () => {
  let inboxPath: string;

  beforeEach(() => {
    inboxPath = mkdtempSync(join(tmpdir(), 'studio-fix-router-generated-'));
  });

  afterEach(() => {
    rmSync(inboxPath, { recursive: true, force: true });
  });

  const job = makeJob({ relPath: 'Acme/Demo', state: 'review' });
  const note: ReviewNote = {
    id: 'n1',
    jobId: job.id,
    round: null,
    atSec: 4,
    kind: 'text',
    text: 'The caption is too small',
    audioFile: null,
    audioSec: null,
    transcriptStatus: null,
    addToStyle: false,
    addToSeries: false,
    createdAt: '2026-10-25T14:00:00.000Z',
    sentAt: null,
    routeStatus: 'pending',
    route: null,
    format: null,
    fixId: null,
    fixedAt: null,
  };

  function promptSentFor(brief: unknown): Promise<string> {
    const editDir = join(inboxPath, 'Acme', 'Demo', 'edit');
    mkdirSync(editDir, { recursive: true });
    if (brief !== undefined) writeFileSync(join(editDir, 'brief.json'), JSON.stringify(brief));
    const prompts: string[] = [];
    const runner: RouteRunner = {
      async run(request: RouteRunRequest) {
        prompts.push(request.prompt);
        return {
          ok: true,
          text: '{"tier":"quick","kind":"Changing the caption size","why":""}',
        };
      },
    };
    const router = new ClaudeNoteRouter({
      config: {
        logsDir: join(inboxPath, 'logs'),
        dataDir: inboxPath,
        claudeBin: 'claude',
        inboxPath,
      },
      runner,
    });
    return router.route(job, note).then(() => prompts[0] as string);
  }

  it('says so in the prompt of a generated video', async () => {
    const prompt = await promptSentFor({ production: 'generate', budgetUsd: null });
    expect(prompt).toContain('## About this video');
  });

  it('leaves it out of the prompt of a footage job, or of a job with no brief', async () => {
    expect(await promptSentFor({ production: 'footage' })).not.toContain('About this video');
    expect(await promptSentFor(undefined)).not.toContain('About this video');
  });
});
