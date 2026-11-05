import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBriefStep } from './create-runner.js';

// The Songs switch reaches the Brief step (SG5): with it on a picture attached to the note makes
// the brief run, with it off the folder is not looked at.

let inbox: string;

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'studio-create-brief-songs-'));
  const jobDir = join(inbox, 'Acme', 'Teaser');
  mkdirSync(join(jobDir, 'edit', 'brief', 'from-you'), { recursive: true });
  writeFileSync(join(jobDir, 'clip.mp4'), 'x');
  writeFileSync(join(jobDir, 'edit', 'brief', 'from-you', 'reel.png'), 'png');
});

afterEach(() => {
  rmSync(inbox, { recursive: true, force: true });
});

const job = {
  id: 'b4b4b4b4b4b4',
  client: 'Acme',
  name: 'Teaser',
  relPath: 'Acme/Teaser',
  note: null,
  seriesId: null,
  episode: null,
} as unknown as Job;

const context = { signal: new AbortController().signal, progress: () => {} };

function config(songs?: boolean) {
  return {
    runner: 'fake' as const,
    inboxPath: inbox,
    exportsDir: join(inbox, '_Exports'),
    logsDir: join(inbox, 'logs'),
    dataDir: inbox,
    claudeBin: 'claude',
    ...(songs === undefined ? {} : { songs }),
  };
}

describe('createBriefStep and the Songs switch', () => {
  const env = { STUDIO_FAKE_SPEED: '1000' };

  it('reads the pictures attached to the note when songs is on', async () => {
    const step = createBriefStep(config(true), { env });
    expect(await step.prepare(job, context)).toMatchObject({ ok: true, source: 'ran' });
  });

  it.each([false, undefined])('does not when songs is %s', async (songs) => {
    const step = createBriefStep(config(songs), { env });
    expect(await step.prepare(job, context)).toMatchObject({ ok: true, source: 'skipped' });
  });
});
