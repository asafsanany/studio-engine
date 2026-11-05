import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { briefSchema, type Job } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBriefStep } from './create-runner.js';

// The music switch reaches the Brief step (U21): with it on, a note that asks for music makes the
// brief say `music.wanted` and brief.md say so; with it off the brief is what it was.

let inbox: string;

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'studio-create-brief-music-'));
  const jobDir = join(inbox, 'Acme', 'Teaser');
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'clip.mp4'), 'x');
});

afterEach(() => {
  rmSync(inbox, { recursive: true, force: true });
});

const jobWith = (note: string | null) =>
  ({
    id: 'b5b5b5b5b5b5',
    client: 'Acme',
    name: 'Teaser',
    relPath: 'Acme/Teaser',
    note,
    seriesId: null,
    episode: null,
  }) as unknown as Job;

const context = { signal: new AbortController().signal, progress: () => {} };

function config(music?: boolean) {
  return {
    runner: 'fake' as const,
    inboxPath: inbox,
    exportsDir: join(inbox, '_Exports'),
    logsDir: join(inbox, 'logs'),
    dataDir: inbox,
    claudeBin: 'claude',
    ...(music === undefined ? {} : { music }),
  };
}

const env = { STUDIO_FAKE_SPEED: '1000' };
const edit = (name: string) => join(inbox, 'Acme', 'Teaser', 'edit', name);

describe('createBriefStep and the music switch', () => {
  it('asks for music in the brief and says so in brief.md when the note asks and music is on', async () => {
    const step = createBriefStep(config(true), { env });
    expect(await step.prepare(jobWith('Add music with drops.'), context)).toMatchObject({
      ok: true,
      source: 'ran',
    });
    const brief = briefSchema.parse(JSON.parse(readFileSync(edit('brief.json'), 'utf8')));
    expect(brief.music).toMatchObject({ wanted: true, file: null });
    expect(readFileSync(edit('brief.md'), 'utf8')).toContain(
      '- Music: asked for, made by the editor',
    );
  });

  it('says “not asked for” when the note asks for nothing and music is on', async () => {
    const step = createBriefStep(config(true), { env });
    await step.prepare(jobWith('Keep the logo at the end.'), context);
    const brief = briefSchema.parse(JSON.parse(readFileSync(edit('brief.json'), 'utf8')));
    expect(brief.music).toBeNull();
    expect(readFileSync(edit('brief.md'), 'utf8')).toContain('- Music: not asked for');
  });

  it.each([false, undefined])('does not touch the brief when music is %s', async (music) => {
    const step = createBriefStep(config(music), { env });
    await step.prepare(jobWith('Add music with drops.'), context);
    const brief = briefSchema.parse(JSON.parse(readFileSync(edit('brief.json'), 'utf8')));
    expect(brief.music).toBeNull();
    expect(readFileSync(edit('brief.md'), 'utf8')).not.toMatch(/- Music/);
  });
});
