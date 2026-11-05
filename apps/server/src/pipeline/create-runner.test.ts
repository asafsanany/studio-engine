import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphicRepository } from '../db/index.js';
import { memoryDb } from '../db/test-utils.js';
import { BriefStep } from './brief-step.js';
import { ClaudeBriefWriter } from './claude-brief.js';
import { ClaudeRunner } from './claude-runner.js';
import { createBriefStep, createRunner, createTranscriber } from './create-runner.js';
import { FakeBriefWriter } from './fake-brief.js';
import { FakeRunner } from './fake-runner.js';

const config = {
  inboxPath: '/inbox',
  logsDir: '/data/logs',
  dataDir: '/data',
  claudeBin: 'claude',
  model: undefined,
  runTimeoutMin: 90,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createRunner', () => {
  it('builds the Claude Code runner for runner "claude"', () => {
    expect(createRunner({ runner: 'claude', ...config })).toBeInstanceOf(ClaudeRunner);
  });

  it('builds the fake runner for runner "fake"', () => {
    expect(createRunner({ runner: 'fake', ...config })).toBeInstanceOf(FakeRunner);
  });

  it('reads the fake runner speed from STUDIO_FAKE_SPEED', () => {
    vi.stubEnv('STUDIO_FAKE_SPEED', '25');
    expect(createRunner({ runner: 'fake', ...config })).toBeInstanceOf(FakeRunner);
  });

  it.each(['0', '-3', 'fast', 'Infinity', '1x'])('rejects STUDIO_FAKE_SPEED=%j', (value) => {
    vi.stubEnv('STUDIO_FAKE_SPEED', value);
    expect(() => createRunner({ runner: 'fake', ...config })).toThrow(/STUDIO_FAKE_SPEED/);
  });

  it('treats an empty STUDIO_FAKE_SPEED as unset', () => {
    vi.stubEnv('STUDIO_FAKE_SPEED', '');
    expect(createRunner({ runner: 'fake', ...config })).toBeInstanceOf(FakeRunner);
  });

  // W2: both runners read the Review switch from the config they are given. It is optional, so a
  // config built without it is still valid, and missing means off. (Read off the instances, since
  // neither exposes it.)
  const reviewOf = (runner: unknown): unknown =>
    runner instanceof ClaudeRunner
      ? (Reflect.get(runner, 'config') as { review?: boolean }).review
      : Reflect.get(runner as object, 'review');

  it('hands the Review switch to the Claude runner and the fake one', () => {
    expect(reviewOf(createRunner({ runner: 'claude', ...config, review: true }))).toBe(true);
    expect(reviewOf(createRunner({ runner: 'fake', ...config, review: true }))).toBe(true);
  });

  it('leaves the Review switch off when the config has none', () => {
    expect(reviewOf(createRunner({ runner: 'claude', ...config }))).toBeUndefined();
    expect(reviewOf(createRunner({ runner: 'fake', ...config }))).toBe(false);
    expect(reviewOf(createRunner({ runner: 'fake', ...config, review: false }))).toBe(false);
  });
});

describe('createBriefStep', () => {
  const briefConfig = { ...config, exportsDir: '/inbox/_Exports' };

  it('gives the claude runner the Claude Brief run', () => {
    const step = createBriefStep({ runner: 'claude', ...briefConfig });
    expect(step).toBeInstanceOf(BriefStep);
    expect(step.writer).toBeInstanceOf(ClaudeBriefWriter);
  });

  it('gives the fake runner the fake Brief run, at STUDIO_FAKE_SPEED', () => {
    expect(createBriefStep({ runner: 'fake', ...briefConfig }).writer).toBeInstanceOf(
      FakeBriefWriter,
    );
    expect(() =>
      createBriefStep({ runner: 'fake', ...briefConfig }, { env: { STUDIO_FAKE_SPEED: 'warp' } }),
    ).toThrow(/STUDIO_FAKE_SPEED/);
  });

  // GR8: the library the engine gives it reaches the step, which then copies it into the job.
  it('hands the Graphics library to the step', async () => {
    const inbox = mkdtempSync(join(tmpdir(), 'studio-create-brief-'));
    try {
      const jobDir = join(inbox, 'Acme', 'Teaser');
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(join(jobDir, 'clip.mp4'), 'x');
      const id = 'a1b2c3d4e5f6';
      const version = join(inbox, '_Graphics', 'Pill', 'versions', 'v1');
      mkdirSync(join(version, 'compositions'), { recursive: true });
      writeFileSync(join(version, 'compositions', `lib-${id}.html`), '<template/>');
      const graphics = new GraphicRepository(memoryDb());
      graphics.create({ id, name: 'Pill' });
      graphics.setVersion(id, { version: 1, kind: 'callout', lengthSec: 2, when: 'Always.' });
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

      const without = createBriefStep({ runner: 'fake', ...briefConfig, inboxPath: inbox });
      expect(await without.prepare(job, context)).toMatchObject({ ok: true, source: 'skipped' });
      expect(existsSync(join(jobDir, 'edit', 'graphics'))).toBe(false);

      const step = createBriefStep(
        { runner: 'fake', ...briefConfig, inboxPath: inbox },
        { graphics },
      );
      expect(await step.prepare(job, context)).toMatchObject({ ok: true, source: 'reused' });
      expect(
        existsSync(join(jobDir, 'edit', 'graphics', id, 'compositions', `lib-${id}.html`)),
      ).toBe(true);
    } finally {
      rmSync(inbox, { recursive: true, force: true });
    }
  });
});

describe('createBriefStep and the Generate switch', () => {
  const briefConfig = { ...config, exportsDir: '/inbox/_Exports' };

  /** A job folder with a script and a zip; what the step does with the zip tells the switch. */
  async function prepare(generate: boolean | undefined) {
    const inbox = mkdtempSync(join(tmpdir(), 'studio-create-brief-gen-'));
    try {
      const jobDir = join(inbox, 'Pinewood', 'Window Ad');
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(join(jobDir, 'refs.zip'), 'not a real zip');
      const job = {
        id: 'b4b4b4b4b4b4',
        client: 'Pinewood',
        name: 'Window Ad',
        relPath: 'Pinewood/Window Ad',
        note: null,
        seriesId: null,
        episode: null,
      } as unknown as Job;
      const step = createBriefStep({
        runner: 'fake',
        ...briefConfig,
        inboxPath: inbox,
        ...(generate === undefined ? {} : { generate }),
      });
      return await step.prepare(job, {
        signal: new AbortController().signal,
        progress: () => {},
      });
    } finally {
      rmSync(inbox, { recursive: true, force: true });
    }
  }

  it('hands the switch to the step: on, the zip is opened (and this one is refused); off or left out, it is a file like any other', async () => {
    expect(await prepare(true)).toEqual({
      ok: false,
      error: 'Brief stopped: the zip “refs.zip” is damaged or isn’t a zip.',
    });
    // Off, a zip is an unknown file: the folder is "only unknown files" and is skipped.
    expect(await prepare(false)).toMatchObject({ ok: true, source: 'skipped' });
    expect(await prepare(undefined)).toMatchObject({ ok: true, source: 'skipped' });
  });
});

describe('createTranscriber', () => {
  it('gives the claude runner the real voice transcriber', () => {
    expect(createTranscriber({ runner: 'claude' }).kind).toBe('real');
  });

  it('gives the fake runner the fake voice transcriber', () => {
    expect(createTranscriber({ runner: 'fake' }).kind).toBe('fake');
    expect(createTranscriber({ runner: 'fake' }, { env: { STUDIO_FAKE_SPEED: '25' } }).kind).toBe(
      'fake',
    );
  });

  it('rejects a bad STUDIO_FAKE_SPEED for the fake one', () => {
    expect(() =>
      createTranscriber({ runner: 'fake' }, { env: { STUDIO_FAKE_SPEED: 'warp' } }),
    ).toThrow(/STUDIO_FAKE_SPEED/);
  });

  it('ignores STUDIO_FAKE_SPEED for the real one', () => {
    expect(
      createTranscriber({ runner: 'claude' }, { env: { STUDIO_FAKE_SPEED: 'warp' } }).kind,
    ).toBe('real');
  });
});
