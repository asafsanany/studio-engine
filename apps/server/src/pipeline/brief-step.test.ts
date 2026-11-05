import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type BriefDraft,
  briefSchema,
  type Job,
  NO_INSTRUCTIONS_SUMMARY,
  noInstructionsBrief,
  renderBriefMd,
} from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredSeries } from '../clients/test-utils.js';
import { GraphicRepository, type StoredSeries } from '../db/index.js';
import { memoryDb } from '../db/test-utils.js';
import { type JobFile, listJobFiles } from '../inbox/scan.js';
import {
  BRIEF_JSON_PATH,
  BRIEF_MD_PATH,
  BRIEF_TRANSCRIPTS_PATH,
  type BriefContext,
  BriefStep,
  type BriefWrite,
  type BriefWriteOutcome,
  type BriefWriter,
  briefFingerprint,
  briefNamesUnreadSong,
  noteStatesCanvas,
} from './brief-step.js';

// The engine-owned half of the Brief step on real temp folders, with a scripted writer standing
// in for the Claude (or fake) Brief run.

const SHARED_FIXTURES = fileURLToPath(
  new URL('../../../../packages/shared/src/brief/fixtures/', import.meta.url),
);

let inbox: string;
const RELPATH = 'Acme/Teaser';
const jobDir = () => join(inbox, RELPATH);

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'studio-brief-step-'));
  mkdirSync(jobDir(), { recursive: true });
});

afterEach(() => {
  rmSync(inbox, { recursive: true, force: true });
});

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'b4b4b4b4b4b4',
    clientId: 'ed099798f237',
    client: 'Acme',
    name: 'Teaser',
    relPath: RELPATH,
    state: 'editing',
    step: 1,
    subProgress: null,
    etaSec: null,
    placeInLine: null,
    settlesAt: null,
    failedAt: null,
    error: null,
    stoppedAt: null,
    inputs: { video: 1, audio: 0, image: 0, doc: 1 },
    sizeBytes: 1,
    addedAt: '2026-10-21T10:00:00.000Z',
    lastChangeAt: '2026-10-21T10:00:00.000Z',
    settledAt: '2026-10-21T10:01:00.000Z',
    heldSettledAt: null,
    runKind: 'edit',
    round: 0,
    preview: null,
    approvedAt: null,
    delivery: null,
    effort: null,
    reviewEffort: null,
    reviseTier: null,
    fixing: null,
    fixedCount: 0,
    reviseMinutes: null,
    seriesId: null,
    episode: null,
    archivedAt: null,
    updatedAt: '2026-10-21T10:01:00.000Z',
    output: null,
    note: null,
    ...overrides,
  };
}

function put(relPath: string, content = 'x'): string {
  const path = join(jobDir(), relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(join(jobDir(), relPath), 'utf8'));
}

function draft(overrides: Partial<BriefDraft> = {}): BriefDraft {
  return {
    ...noInstructionsBrief(['clip.mp4']),
    summary: 'A 20-second reel. Keep the logo at the end.',
    files: [
      { path: 'brief.txt', role: 'instructions', note: null },
      { path: 'clip.mp4', role: 'footage', note: null },
    ],
    ...overrides,
  };
}

/** A writer that writes `content` (an object as JSON, a string as it is) to edit/brief.json. */
class ScriptedWriter implements BriefWriter {
  readonly calls: { job: Job; run: BriefWrite }[] = [];
  outcome: BriefWriteOutcome = { ok: true };
  content: unknown = draft();
  /** Runs inside `write`, before brief.json is written (to write transcripts, wait, abort...). */
  during: ((run: BriefWrite) => Promise<void>) | null = null;

  async write(job: Job, run: BriefWrite): Promise<BriefWriteOutcome> {
    this.calls.push({ job, run });
    await this.during?.(run);
    if (this.content !== undefined) {
      const path = join(run.jobDir, BRIEF_JSON_PATH);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        typeof this.content === 'string' ? this.content : JSON.stringify(this.content),
      );
    }
    return this.outcome;
  }
}

function context(controller = new AbortController()) {
  const progress = vi.fn<BriefContext['progress']>();
  return { controller, progress, ctx: { signal: controller.signal, progress } };
}

function step(writer: BriefWriter, pollIntervalMs = 10) {
  return new BriefStep({ inboxPath: inbox, writer, pollIntervalMs });
}

describe('briefFingerprint', () => {
  const files = [
    { relPath: 'clip.mp4', size: 10, mtimeMs: 1_000.25 },
    { relPath: 'brief.txt', size: 3, mtimeMs: 2_000 },
  ];

  it('is sha1 over the sorted relPath\\tsize\\tmtimeMs lines, then the note', () => {
    // Whole milliseconds, sorted by path, then a newline and the note.
    const text = 'brief.txt\t3\t2000\nclip.mp4\t10\t1000\nKeep it short.';
    expect(briefFingerprint(files, 'Keep it short.')).toBe(
      createHash('sha1').update(text).digest('hex'),
    );
  });

  it('does not depend on the order of the files', () => {
    expect(briefFingerprint([...files].reverse(), null)).toBe(briefFingerprint(files, null));
  });

  it('changes with the note, a size, a mtime, an added or a removed file', () => {
    const base = briefFingerprint(files, null);
    const changed = [
      briefFingerprint(files, 'A note'),
      briefFingerprint([{ ...files[0], size: 11 } as JobFile, files[1] as JobFile], null),
      briefFingerprint([{ ...files[0], mtimeMs: 5_000 } as JobFile, files[1] as JobFile], null),
      briefFingerprint([...files, { relPath: 'logo.png', size: 1, mtimeMs: 1 }], null),
      briefFingerprint([files[0] as JobFile], null),
    ];
    expect(new Set([base, ...changed]).size).toBe(changed.length + 1);
  });
});

describe('a Brief run', () => {
  it('runs the writer, then adds schema and fingerprint and renders brief.md', async () => {
    put('clip.mp4');
    put('brief.txt', 'Keep the logo at the end.');
    const writer = new ScriptedWriter();
    const { ctx, progress } = context();

    const outcome = await step(writer).prepare(makeJob({ note: 'Second take.' }), ctx);

    expect(outcome).toMatchObject({ ok: true, source: 'ran' });
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]?.run).toMatchObject({ jobDir: jobDir(), note: 'Second take.' });
    expect(writer.calls[0]?.run.files.map((f) => f.relPath)).toEqual(['brief.txt', 'clip.mp4']);
    expect(progress).toHaveBeenCalledWith('reading 1 file');

    const saved = briefSchema.parse(readJson(BRIEF_JSON_PATH));
    expect(Object.keys(readJson(BRIEF_JSON_PATH) as object).slice(0, 3)).toEqual([
      'schema',
      'fingerprint',
      'summary',
    ]);
    expect(saved).toMatchObject({ schema: 1, summary: draft().summary });
    expect(saved.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(jobDir(), BRIEF_MD_PATH), 'utf8')).toBe(
      renderBriefMd(draft(), { client: 'Acme', job: 'Teaser', note: 'Second take.' }),
    );
  });

  it('renders the bakery fixture to the golden brief.md, byte for byte', async () => {
    const fixture = JSON.parse(readFileSync(`${SHARED_FIXTURES}bakery-fixture.json`, 'utf8')) as {
      client: string;
      job: string;
      note: string;
      draft: BriefDraft;
    };
    const relPath = `${fixture.client}/${fixture.job}`;
    mkdirSync(join(inbox, relPath), { recursive: true });
    writeFileSync(join(inbox, relPath, '_chat.txt'), 'chat');
    const writer = new ScriptedWriter();
    writer.content = fixture.draft;
    const job = makeJob({ client: fixture.client, name: fixture.job, relPath, note: fixture.note });

    const outcome = await step(writer).prepare(job, context().ctx);

    expect(outcome.ok).toBe(true);
    expect(readFileSync(join(inbox, relPath, BRIEF_MD_PATH), 'utf8')).toBe(
      readFileSync(`${SHARED_FIXTURES}bakery-brief.md`, 'utf8'),
    );
  });

  it('says "voice notes n" as transcripts appear in edit/brief/transcripts/', async () => {
    put('clip.mp4');
    put('a.opus');
    put('b.m4a');
    const writer = new ScriptedWriter();
    writer.during = async (run) => {
      const dir = join(run.jobDir, BRIEF_TRANSCRIPTS_PATH);
      mkdirSync(dir, { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 60));
      writeFileSync(join(dir, 'a.json'), '{}');
      await new Promise((resolve) => setTimeout(resolve, 60));
      writeFileSync(join(dir, 'b.json'), '{}');
      await new Promise((resolve) => setTimeout(resolve, 60));
    };
    const { ctx, progress } = context();

    await step(writer).prepare(makeJob(), ctx);

    expect(progress.mock.calls.map(([sub]) => sub)).toEqual([
      'reading 2 files',
      'voice notes 1',
      'voice notes 2',
    ]);
  });

  it('shows no total, so a music track that is never transcribed leaves nothing stuck', async () => {
    put('clip.mp4');
    put('a.opus');
    put('b.m4a');
    put('music.mp3');
    const writer = new ScriptedWriter();
    writer.during = async (run) => {
      const dir = join(run.jobDir, BRIEF_TRANSCRIPTS_PATH);
      mkdirSync(dir, { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 60));
      writeFileSync(join(dir, 'a.json'), '{}');
      await new Promise((resolve) => setTimeout(resolve, 60));
      writeFileSync(join(dir, 'b.json'), '{}');
      // The run is over without a transcript for music.mp3.
      await new Promise((resolve) => setTimeout(resolve, 60));
    };
    const { ctx, progress } = context();

    await step(writer).prepare(makeJob(), ctx);

    const shown = progress.mock.calls.map(([sub]) => sub);
    expect(shown).toEqual(['reading 3 files', 'voice notes 1', 'voice notes 2']);
    expect(shown.some((sub) => sub.includes('/'))).toBe(false);
  });

  it('does not count more transcripts than there are audio files', async () => {
    put('brief.txt');
    put('a.opus');
    put(`${BRIEF_TRANSCRIPTS_PATH}/gone-1.json`, '{}');
    put(`${BRIEF_TRANSCRIPTS_PATH}/gone-2.json`, '{}');
    const writer = new ScriptedWriter();
    writer.during = async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    };
    const { ctx, progress } = context();

    await step(writer).prepare(makeJob(), ctx);

    expect(progress.mock.calls.map(([sub]) => sub)).toEqual(['reading 2 files', 'voice notes 1']);
  });

  it('says nothing about voice notes for a job without audio, whatever is in transcripts/', async () => {
    put('brief.txt');
    put(`${BRIEF_TRANSCRIPTS_PATH}/old.json`, '{}');
    const writer = new ScriptedWriter();
    writer.during = async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    };
    const { ctx, progress } = context();

    await step(writer).prepare(makeJob(), ctx);

    expect(progress.mock.calls.map(([sub]) => sub)).toEqual(['reading 1 file']);
  });

  it('removes an older brief first, so a run that writes none fails instead of reusing it', async () => {
    put('brief.txt');
    put(BRIEF_JSON_PATH, JSON.stringify({ schema: 1, fingerprint: 'old', ...draft() }));
    put(BRIEF_MD_PATH, '# old');
    const writer = new ScriptedWriter();
    writer.content = undefined;

    const outcome = await step(writer).prepare(makeJob(), context().ctx);

    expect(outcome).toEqual({
      ok: false,
      error: 'Brief stopped: brief.json didn’t match the schema (no edit/brief.json was written).',
    });
    expect(existsSync(join(jobDir(), BRIEF_MD_PATH))).toBe(false);
  });

  it('keeps the voice-note transcripts of an earlier brief (they cost money to make)', async () => {
    put('brief.txt');
    put(`${BRIEF_TRANSCRIPTS_PATH}/voice.json`, '{}');
    await step(new ScriptedWriter()).prepare(makeJob(), context().ctx);
    expect(existsSync(join(jobDir(), BRIEF_TRANSCRIPTS_PATH, 'voice.json'))).toBe(true);
  });
});

// P18 (CVP-133): a brief written without the words of a voice note that carries instructions is
// accepted, but the engine log says so.
describe('a voice note with instructions and no transcript', () => {
  function warnings() {
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn() };
    return {
      warn,
      step: (writer: BriefWriter) => new BriefStep({ inboxPath: inbox, writer, logger }),
    };
  }

  function voiceDraft(): BriefDraft {
    return draft({
      files: [
        { path: 'clip.mp4', role: 'footage', note: null },
        { path: 'note-1.opus', role: 'instructions', note: 'Voice note, not transcribed' },
        { path: 'note-2.m4a', role: 'instructions', note: 'Voice note, 0:21' },
        { path: 'song.mp3', role: 'music', note: null },
      ],
    });
  }

  it('warns once per such voice note, and still accepts the brief', async () => {
    put('clip.mp4');
    put('note-1.opus');
    put('note-2.m4a');
    put('song.mp3');
    put(`${BRIEF_TRANSCRIPTS_PATH}/note-2.json`, '{}');
    const writer = new ScriptedWriter();
    writer.content = voiceDraft();
    const { warn, step: makeStep } = warnings();

    const outcome = await makeStep(writer).prepare(makeJob(), context().ctx);

    expect(outcome).toMatchObject({ ok: true, source: 'ran' });
    const messages = warn.mock.calls.filter(([, msg]) => /without a transcript/.test(msg));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.[0]).toMatchObject({ jobId: 'b4b4b4b4b4b4', file: 'note-1.opus' });
  });

  it('says nothing when every instructions voice note has its transcript', async () => {
    put('clip.mp4');
    put('note-1.opus');
    put('note-2.m4a');
    put('song.mp3');
    put(`${BRIEF_TRANSCRIPTS_PATH}/note-1.json`, '{}');
    put(`${BRIEF_TRANSCRIPTS_PATH}/note-2.json`, '{}');
    const writer = new ScriptedWriter();
    writer.content = voiceDraft();
    const { warn, step: makeStep } = warnings();

    await makeStep(writer).prepare(makeJob(), context().ctx);

    expect(warn).not.toHaveBeenCalled();
  });
});

// P21 (CVP-136): The owner's note said 1080x1920, the run wrote that canvas and also put `canvas` in
// `assumed`, so brief.md said "Canvas: 1080x1920 (assumed)": an instruction tagged as a guess the
// edit run may overrule. The prompt asks the run not to; this is the guard for the one case the
// engine can check itself, a canvas that is word for word in the note.
describe('a canvas the note states', () => {
  const NOTE = 'תעשה את זה אנכי, 1080x1920 לרילס ולסטורי, לא מרובע כמו שמיכל ביקשה.';

  function assumedDraft(overrides: Partial<BriefDraft> = {}): BriefDraft {
    return draft({
      canvas: '1080x1920',
      platform: ['Instagram Reel'],
      language: 'he',
      assumed: ['canvas', 'platform', 'language', 'files'],
      ...overrides,
    });
  }

  function infoLogger() {
    const info = vi.fn();
    return {
      info,
      step: (writer: BriefWriter) =>
        new BriefStep({
          inboxPath: inbox,
          writer,
          logger: { info, warn: vi.fn(), error: vi.fn() },
        }),
    };
  }

  it('is taken out of assumed, and only canvas: brief.json and brief.md show it as stated', async () => {
    put('brief.txt');
    const writer = new ScriptedWriter();
    writer.content = assumedDraft();
    const { info, step: makeStep } = infoLogger();

    const outcome = await makeStep(writer).prepare(makeJob({ note: NOTE }), context().ctx);

    expect(outcome).toMatchObject({ ok: true, source: 'ran' });
    expect(briefSchema.parse(readJson(BRIEF_JSON_PATH)).assumed).toEqual([
      'platform',
      'language',
      'files',
    ]);
    const md = readFileSync(join(jobDir(), BRIEF_MD_PATH), 'utf8');
    expect(md).toContain('- Canvas: 1080x1920\n');
    expect(md).not.toContain('Canvas: 1080x1920 (assumed)');
    expect(md).toContain('- Platform: Instagram Reel (assumed)');
    expect(
      info.mock.calls.some(([, msg]) =>
        /the note states the canvas, so it is not assumed/.test(msg),
      ),
    ).toBe(true);
  });

  it('stays assumed when the note says another size, or nothing about one', async () => {
    for (const note of ['Make it 1080x1080 for the feed.', 'Keep it short.', null]) {
      rmSync(join(jobDir(), 'edit'), { recursive: true, force: true });
      put('brief.txt');
      const writer = new ScriptedWriter();
      writer.content = assumedDraft();

      await step(writer).prepare(makeJob({ note }), context().ctx);

      expect(briefSchema.parse(readJson(BRIEF_JSON_PATH)).assumed).toContain('canvas');
    }
  });

  it('leaves a draft that did not call the canvas assumed exactly as it is', async () => {
    put('brief.txt');
    const writer = new ScriptedWriter();
    writer.content = assumedDraft({ assumed: ['language'] });

    await step(writer).prepare(makeJob({ note: NOTE }), context().ctx);

    expect(briefSchema.parse(readJson(BRIEF_JSON_PATH)).assumed).toEqual(['language']);
  });
});

describe('noteStatesCanvas', () => {
  it.each([
    ['תעשה את זה אנכי, 1080x1920 לרילס', '1080x1920', true],
    ['1920x1080 please', '1920x1080', true],
    ['make it 1080 × 1920', '1080x1920', true],
    ['make it 1080 X 1920', '1080x1920', true],
    ['1080x1080 for the feed, not 1080x1920', '1080x1920', true],
    ['make it 1080x1080', '1080x1920', false],
    ['made at 11080x19200', '1080x1920', false],
    ['a vertical reel', '1080x1920', false],
    [null, '1080x1920', false],
    ['1080x1920', null, false],
  ])('%j with canvas %j is %j', (note, canvas, expected) => {
    expect(noteStatesCanvas(note, canvas)).toBe(expected);
  });
});

describe('validation', () => {
  it('fails with the first schema issue', async () => {
    put('brief.txt');
    const writer = new ScriptedWriter();
    const { goal: _goal, ...withoutGoal } = draft();
    writer.content = withoutGoal;

    expect(await step(writer).prepare(makeJob(), context().ctx)).toEqual({
      ok: false,
      error: 'Brief stopped: brief.json didn’t match the schema (goal: missing).',
    });
  });

  it('names the field and the problem for a wrong value', async () => {
    put('brief.txt');
    const writer = new ScriptedWriter();
    writer.content = draft({ canvas: '720x1280' as BriefDraft['canvas'] });

    const outcome = await step(writer).prepare(makeJob(), context().ctx);
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: string }).error).toMatch(
      /^Brief stopped: brief\.json didn’t match the schema \(canvas: .+\)\.$/,
    );
  });

  it('fails on a file that is not JSON', async () => {
    put('brief.txt');
    const writer = new ScriptedWriter();
    writer.content = '{ "summary": ';

    const outcome = await step(writer).prepare(makeJob(), context().ctx);
    expect((outcome as { error: string }).error).toMatch(
      /^Brief stopped: brief\.json didn’t match the schema \(not valid JSON: .+\)\.$/,
    );
  });

  it("passes the writer's own failure on, as it is", async () => {
    put('brief.txt');
    const writer = new ScriptedWriter();
    writer.outcome = { ok: false, error: 'Brief stopped: ElevenLabs key missing.' };

    expect(await step(writer).prepare(makeJob(), context().ctx)).toEqual({
      ok: false,
      error: 'Brief stopped: ElevenLabs key missing.',
    });
  });

  it('fails clearly when the job folder is gone', async () => {
    rmSync(jobDir(), { recursive: true });
    const writer = new ScriptedWriter();
    expect(await step(writer).prepare(makeJob(), context().ctx)).toEqual({
      ok: false,
      error: 'Brief stopped: the job folder is missing: Acme/Teaser',
    });
    expect(writer.calls).toHaveLength(0);
  });
});

describe('reuse', () => {
  it('reuses a brief whose fingerprint still matches: no run, no progress', async () => {
    put('clip.mp4');
    put('brief.txt');
    const writer = new ScriptedWriter();
    await step(writer).prepare(makeJob(), context().ctx);
    const first = readFileSync(join(jobDir(), BRIEF_JSON_PATH), 'utf8');
    rmSync(join(jobDir(), BRIEF_MD_PATH));
    const { ctx, progress } = context();

    const outcome = await step(writer).prepare(makeJob(), ctx);

    expect(outcome).toMatchObject({ ok: true, source: 'reused' });
    expect(writer.calls).toHaveLength(1);
    expect(progress).not.toHaveBeenCalled();
    expect(readFileSync(join(jobDir(), BRIEF_JSON_PATH), 'utf8')).toBe(first);
    // brief.md is rendered again from it.
    expect(existsSync(join(jobDir(), BRIEF_MD_PATH))).toBe(true);
  });

  it('writes a new brief when the note changes', async () => {
    put('clip.mp4');
    const writer = new ScriptedWriter();
    await step(writer).prepare(makeJob({ note: 'Under 30 s.' }), context().ctx);
    const outcome = await step(writer).prepare(makeJob({ note: 'Under 20 s.' }), context().ctx);

    expect(outcome).toMatchObject({ ok: true, source: 'ran' });
    expect(writer.calls.map((call) => call.run.note)).toEqual(['Under 30 s.', 'Under 20 s.']);
  });

  it('writes a new brief when a file changes, is added or is removed', async () => {
    put('clip.mp4');
    const notes = put('brief.txt', 'v1');
    const writer = new ScriptedWriter();
    const prepare = () => step(writer).prepare(makeJob(), context().ctx);
    await prepare();

    writeFileSync(notes, 'version 2');
    expect(await prepare()).toMatchObject({ source: 'ran' });
    utimesSync(notes, 1_700_000_000, 1_700_000_000);
    expect(await prepare()).toMatchObject({ source: 'ran' });
    put('logo.png');
    expect(await prepare()).toMatchObject({ source: 'ran' });
    rmSync(notes);
    expect(await prepare()).toMatchObject({ source: 'ran' });
    expect(await prepare()).toMatchObject({ source: 'reused' });
    expect(writer.calls).toHaveLength(5);
  });

  it('ignores what the runs write under edit/ and dotfiles: they are not client material', async () => {
    put('brief.txt');
    const writer = new ScriptedWriter();
    await step(writer).prepare(makeJob(), context().ctx);
    put('edit/transcripts/clip.json');
    put('edit/project.md');
    put('.fail-at-render', '');
    put('.DS_Store');

    expect(await step(writer).prepare(makeJob(), context().ctx)).toMatchObject({
      source: 'reused',
    });
  });

  it('does not reuse a draft the engine never finished (no schema or fingerprint)', async () => {
    put('brief.txt');
    put(BRIEF_JSON_PATH, JSON.stringify(draft()));
    const writer = new ScriptedWriter();
    expect(await step(writer).prepare(makeJob(), context().ctx)).toMatchObject({ source: 'ran' });
  });
});

// A brief written while Songs was off could not read a song: "Music: [title] - [artist]" ended up
// in music.file, a name with no file behind it. Once Songs is on, that brief is read again.
describe('a brief that never read its song', () => {
  const unread: NonNullable<BriefDraft['music']> = {
    file: 'sara perche ti amo - Sorrento Singers',
    note: null,
    wanted: false,
    song: null,
    original: null,
    wantsTrending: false,
  };
  const read: NonNullable<BriefDraft['music']> = {
    file: null,
    note: null,
    wanted: false,
    song: {
      title: 'sara perche ti amo',
      artist: 'Sorrento Singers',
      version: null,
      link: null,
      fromFile: null,
    },
    original: null,
    wantsTrending: false,
  };
  const songsStep = (writer: BriefWriter, songs: boolean) =>
    new BriefStep({ inboxPath: inbox, writer, pollIntervalMs: 10, songs });
  const prepare = (writer: BriefWriter, songs: boolean) =>
    songsStep(writer, songs).prepare(makeJob(), context().ctx);

  it('is reused while Songs is off, read again once it is on, and kept once the song is read', async () => {
    put('clip.mp4');
    put('brief.txt', 'מוזיקה: sara perche ti amo - version to use is the sorrento singers');
    const writer = new ScriptedWriter();
    writer.content = draft({ music: unread });

    expect(await prepare(writer, false)).toMatchObject({ source: 'ran' });
    expect(await prepare(writer, false)).toMatchObject({ source: 'reused' });

    writer.content = draft({ music: read });
    expect(await prepare(writer, true)).toMatchObject({ source: 'ran' });
    expect(writer.calls).toHaveLength(2);
    expect(briefSchema.parse(readJson(BRIEF_JSON_PATH)).music?.song?.artist).toBe(
      'Sorrento Singers',
    );

    expect(await prepare(writer, true)).toMatchObject({ source: 'reused' });
    expect(writer.calls).toHaveLength(2);
  });

  it('keeps a brief whose music file is really in the folder', async () => {
    put('clip.mp4');
    put('brief.txt');
    put('audio/track.mp3');
    const writer = new ScriptedWriter();
    writer.content = draft({ music: { ...unread, file: 'track.mp3' } });

    expect(await prepare(writer, true)).toMatchObject({ source: 'ran' });
    expect(await prepare(writer, true)).toMatchObject({ source: 'reused' });
    expect(writer.calls).toHaveLength(1);
  });

  describe('briefNamesUnreadSong', () => {
    const brief = (music: BriefDraft['music']) =>
      briefSchema.parse({ schema: 1, fingerprint: 'f', ...draft({ music }) });
    const folder = [{ relPath: 'clip.mp4' }, { relPath: 'audio/track.mp3' }];

    it('is true only for a music name with no file, no song, no original audio and no trending ask', () => {
      expect(briefNamesUnreadSong(brief(unread), folder)).toBe(true);
    });

    it.each([
      ['no music at all', null],
      ['no music file', { ...unread, file: null }],
      ['a song already read', { ...unread, song: read.song }],
      ['original audio', { ...unread, original: { by: '@reels.creator' } }],
      ['a trending ask', { ...unread, wantsTrending: true }],
      ['a file in the folder', { ...unread, file: 'audio/track.mp3' }],
      ['a file in a subfolder, named without it', { ...unread, file: 'track.mp3' }],
    ])('is false for %s', (_name, music) => {
      expect(briefNamesUnreadSong(brief(music as BriefDraft['music']), folder)).toBe(false);
    });
  });
});

describe('skip', () => {
  it('writes the no-instructions brief itself when there is only video and no note', async () => {
    put('b-roll/clip-02.mov');
    put('clip-01.mp4');
    const writer = new ScriptedWriter();
    const { ctx, progress } = context();

    const outcome = await step(writer).prepare(makeJob(), ctx);

    expect(outcome).toMatchObject({ ok: true, source: 'skipped' });
    expect(writer.calls).toHaveLength(0);
    expect(progress).not.toHaveBeenCalled();
    const saved = briefSchema.parse(readJson(BRIEF_JSON_PATH));
    expect(saved).toMatchObject({
      schema: 1,
      summary: NO_INSTRUCTIONS_SUMMARY,
      goal: null,
      assumptions: [],
      files: [
        { path: 'b-roll/clip-02.mov', role: 'footage', note: null },
        { path: 'clip-01.mp4', role: 'footage', note: null },
      ],
    });
    expect(readFileSync(join(jobDir(), BRIEF_MD_PATH), 'utf8')).toContain(
      '# Brief: Teaser (Acme)\n\nNo instructions in the folder.',
    );
    // Nothing changed: the next run reuses it.
    expect(await step(writer).prepare(makeJob(), context().ctx)).toMatchObject({
      source: 'reused',
    });
  });

  it('runs the writer for only video plus a note', async () => {
    put('clip.mp4');
    const writer = new ScriptedWriter();
    const { ctx, progress } = context();
    expect(await step(writer).prepare(makeJob({ note: 'Fast cuts.' }), ctx)).toMatchObject({
      source: 'ran',
    });
    expect(progress).toHaveBeenCalledWith('reading 0 files');
  });

  it.each([
    ['a document', 'brief.txt'],
    ['an image', 'logo.png'],
    ['a voice note', 'voice.opus'],
  ])('runs the writer when the folder holds %s next to the video', async (_kind, name) => {
    put('clip.mp4');
    put('project.fcpxml');
    put(name);
    const writer = new ScriptedWriter();
    expect(await step(writer).prepare(makeJob(), context().ctx)).toMatchObject({ source: 'ran' });
    expect(writer.calls).toHaveLength(1);
  });

  it('skips for video plus unknown file types, and lists the unknown ones as ignored', async () => {
    put('clip-01.mp4');
    put('clip-02.mov');
    put('project.fcpxml');
    put('Cut.prproj');
    const writer = new ScriptedWriter();
    const { ctx, progress } = context();

    const outcome = await step(writer).prepare(makeJob(), ctx);

    expect(outcome).toMatchObject({ ok: true, source: 'skipped' });
    expect(writer.calls).toHaveLength(0);
    expect(progress).not.toHaveBeenCalled();
    const saved = briefSchema.parse(readJson(BRIEF_JSON_PATH));
    expect(saved).toMatchObject({
      summary: NO_INSTRUCTIONS_SUMMARY,
      files: [
        { path: 'Cut.prproj', role: 'ignore', note: null },
        { path: 'clip-01.mp4', role: 'footage', note: null },
        { path: 'clip-02.mov', role: 'footage', note: null },
        { path: 'project.fcpxml', role: 'ignore', note: null },
      ],
    });
    expect(readFileSync(join(jobDir(), BRIEF_MD_PATH), 'utf8')).toContain(
      '## Files\n- Footage: clip-01.mp4, clip-02.mov\n- Ignored: Cut.prproj, project.fcpxml\n',
    );
  });

  it('still runs the writer for video, unknown files and a note', async () => {
    put('clip.mp4');
    put('project.fcpxml');
    const writer = new ScriptedWriter();
    expect(
      await step(writer).prepare(makeJob({ note: 'Fast cuts.' }), context().ctx),
    ).toMatchObject({ source: 'ran' });
  });

  it('keeps unknown files in the fingerprint: reused until one of them changes', async () => {
    put('clip.mp4');
    const project = put('project.fcpxml', 'v1');
    const writer = new ScriptedWriter();
    const prepare = () => step(writer).prepare(makeJob(), context().ctx);

    const first = await prepare();
    expect(first).toMatchObject({ source: 'skipped' });
    expect(await prepare()).toMatchObject({ source: 'reused' });

    writeFileSync(project, 'version 2');
    const changed = await prepare();
    expect(changed).toMatchObject({ source: 'skipped' });
    expect((changed as { brief: { fingerprint: string } }).brief.fingerprint).not.toBe(
      (first as { brief: { fingerprint: string } }).brief.fingerprint,
    );
    expect(writer.calls).toHaveLength(0);
  });

  it('skips a folder of only unknown files too: nothing in it says how to edit', async () => {
    put('project.fcpxml');
    const writer = new ScriptedWriter();
    expect(await step(writer).prepare(makeJob(), context().ctx)).toMatchObject({
      source: 'skipped',
    });
    expect(writer.calls).toHaveLength(0);
  });
});

describe('stopping and injected failures', () => {
  it('stops at once when the signal is already aborted', async () => {
    put('brief.txt');
    const writer = new ScriptedWriter();
    const { controller, ctx } = context();
    controller.abort();
    expect((await step(writer).prepare(makeJob(), ctx)).ok).toBe(false);
    expect(writer.calls).toHaveLength(0);
  });

  it('does not judge or save anything after an abort during the run', async () => {
    put('brief.txt');
    const writer = new ScriptedWriter();
    const { controller, ctx } = context();
    writer.during = async () => controller.abort();

    const outcome = await step(writer).prepare(makeJob(), ctx);

    expect(outcome.ok).toBe(false);
    // The draft is there (the writer wrote it), but it never became the brief.
    expect(readJson(BRIEF_JSON_PATH)).not.toHaveProperty('schema');
    expect(existsSync(join(jobDir(), BRIEF_MD_PATH))).toBe(false);
  });

  it("fails with the writer's injected failure before reuse or skip", async () => {
    put('clip.mp4');
    const writer = new ScriptedWriter();
    await step(writer).prepare(makeJob(), context().ctx);
    const failing: BriefWriter = {
      write: writer.write.bind(writer),
      injectedFailure: async () => 'Brief failed: injected failure (.fail-at-brief)',
    };
    expect(await step(failing).prepare(makeJob(), context().ctx)).toEqual({
      ok: false,
      error: 'Brief failed: injected failure (.fail-at-brief)',
    });
  });

  it('turns an unexpected error into a "Brief stopped:" failure', async () => {
    put('brief.txt');
    const writer: BriefWriter = {
      write: async () => {
        throw new Error('EACCES: permission denied');
      },
    };
    expect(await step(writer).prepare(makeJob(), context().ctx)).toEqual({
      ok: false,
      error: 'Brief stopped: EACCES: permission denied',
    });
  });
});

// Phase 2 (C5): the client's _Style is frozen into the job once, and closes brief.md.
describe('the client style', () => {
  const STYLE = '# Style: Acme\nLearned from Launch (2026-10-20).\n\n## Look\n- Fonts: Heebo 800\n';
  const styleDir = () => join(inbox, 'Acme', '_Style');
  const frozen = (relPath = '') => join(jobDir(), 'edit', 'style', relPath);

  function putStyle(relPath: string, content = 'x'): void {
    const path = join(styleDir(), relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  const briefMd = () => readFileSync(join(jobDir(), BRIEF_MD_PATH), 'utf8');
  const withoutStyle = () => renderBriefMd(draft(), { client: 'Acme', job: 'Teaser', note: null });
  const prepare = (writer: BriefWriter, job = makeJob()) =>
    step(writer).prepare(job, context().ctx);

  describe('the copy', () => {
    it('copies _Style into edit/style/ before the Brief run, as it is', async () => {
      putStyle('style.md', STYLE);
      putStyle('logo.png', 'png');
      putStyle('kit/title/index.html', '<html>');
      put('brief.txt');
      const writer = new ScriptedWriter();
      let seenByTheRun: string | null = null;
      writer.during = async (run) => {
        seenByTheRun = readFileSync(join(run.jobDir, 'edit', 'style', 'style.md'), 'utf8');
      };

      expect(await prepare(writer)).toMatchObject({ ok: true, source: 'ran' });

      expect(seenByTheRun).toBe(STYLE);
      expect(readdirSync(frozen()).sort()).toEqual(['kit', 'logo.png', 'style.md']);
      expect(readFileSync(frozen('logo.png'), 'utf8')).toBe('png');
      expect(readFileSync(frozen('kit/title/index.html'), 'utf8')).toBe('<html>');
      // _Style stays as it was, and nothing of the copy's staging is left in edit/.
      expect(readFileSync(join(styleDir(), 'style.md'), 'utf8')).toBe(STYLE);
      expect(
        readdirSync(join(jobDir(), 'edit')).filter((name) => name.startsWith('.style')),
      ).toEqual([]);
    });

    it('leaves out the style run’s style.md.new and dot files', async () => {
      putStyle('style.md', STYLE);
      putStyle('style.md.new', '# Style: half done');
      putStyle('.DS_Store');
      putStyle('kit/.DS_Store');
      putStyle('kit/a.html');
      put('brief.txt');

      await prepare(new ScriptedWriter());

      expect(readdirSync(frozen()).sort()).toEqual(['kit', 'style.md']);
      expect(readdirSync(frozen('kit'))).toEqual(['a.html']);
    });

    it('copies what a link points to, so the copy does not change when _Style does', async () => {
      putStyle('style.md', STYLE);
      putStyle('real.png', 'png');
      symlinkSync(join(styleDir(), 'real.png'), join(styleDir(), 'alias.png'));
      put('brief.txt');

      await prepare(new ScriptedWriter());

      expect(lstatSync(frozen('alias.png')).isSymbolicLink()).toBe(false);
      expect(readFileSync(frozen('alias.png'), 'utf8')).toBe('png');
    });

    it.each([
      ['there is no _Style folder', () => undefined],
      ['_Style has no style.md', () => putStyle('logo.png')],
      ['style.md is a folder', () => mkdirSync(join(styleDir(), 'style.md'), { recursive: true })],
    ])('makes no copy and no section when %s', async (_case, arrange) => {
      arrange();
      put('brief.txt');

      expect(await prepare(new ScriptedWriter())).toMatchObject({ ok: true });

      expect(existsSync(frozen())).toBe(false);
      expect(briefMd()).toBe(withoutStyle());
    });

    it('is made once: Retry and Resume keep the style the job started with', async () => {
      putStyle('style.md', STYLE);
      put('brief.txt');
      const writer = new ScriptedWriter();
      await prepare(writer);

      // The client's style changes: a new look, a new file and a new kit.
      putStyle('style.md', '# Style: Acme\nNew look.\n');
      putStyle('new-logo.png');
      putStyle('kit/b/index.html');

      // A new note makes a new brief (a run); an unchanged one reuses it.
      expect(await prepare(writer, makeJob({ note: 'Shorter.' }))).toMatchObject({ source: 'ran' });
      expect(await prepare(writer, makeJob({ note: 'Shorter.' }))).toMatchObject({
        source: 'reused',
      });

      expect(readFileSync(frozen('style.md'), 'utf8')).toBe(STYLE);
      expect(readdirSync(frozen())).toEqual(['style.md']);
      expect(briefMd()).toContain('Learned from Launch');
      expect(briefMd()).not.toContain('New look.');
    });

    it('is made at the first attempt, so a job that failed keeps it for the retry', async () => {
      putStyle('style.md', STYLE);
      put('brief.txt');
      const writer = new ScriptedWriter();
      writer.outcome = {
        ok: false,
        error: 'Brief stopped: the brief took longer than 10 minutes.',
      };
      expect(await prepare(writer)).toMatchObject({ ok: false });
      expect(readFileSync(frozen('style.md'), 'utf8')).toBe(STYLE);

      putStyle('style.md', '# Style: Acme\nNew look.\n');
      writer.outcome = { ok: true };
      expect(await prepare(writer)).toMatchObject({ ok: true });

      expect(readFileSync(frozen('style.md'), 'utf8')).toBe(STYLE);
      expect(briefMd()).not.toContain('New look.');
    });

    it('is made even when an injected failure ends the step at once', async () => {
      putStyle('style.md', STYLE);
      put('brief.txt');
      const failing: BriefWriter = {
        write: new ScriptedWriter().write,
        injectedFailure: async () => 'Brief failed: injected failure (.fail-at-brief)',
      };

      expect(await prepare(failing)).toMatchObject({ ok: false });

      expect(readFileSync(frozen('style.md'), 'utf8')).toBe(STYLE);
    });

    it('goes to a job that had no style once its client has one', async () => {
      put('brief.txt');
      const writer = new ScriptedWriter();
      await prepare(writer);
      const json = readFileSync(join(jobDir(), BRIEF_JSON_PATH), 'utf8');
      expect(existsSync(frozen())).toBe(false);

      putStyle('style.md', STYLE);
      expect(await prepare(writer)).toMatchObject({ source: 'reused' });

      expect(readFileSync(frozen('style.md'), 'utf8')).toBe(STYLE);
      expect(briefMd()).toContain('\n## Client style\n');
      expect(readFileSync(join(jobDir(), BRIEF_JSON_PATH), 'utf8')).toBe(json);
    });

    it('starts over from a copy that was cut short', async () => {
      putStyle('style.md', STYLE);
      put('brief.txt');
      put('edit/.style-copying/half.txt');

      await prepare(new ScriptedWriter());

      expect(readdirSync(frozen())).toEqual(['style.md']);
      expect(existsSync(join(jobDir(), 'edit', '.style-copying'))).toBe(false);
    });

    it('leaves an edit/style/ without a style.md as it is, with no section', async () => {
      putStyle('style.md', STYLE);
      put('brief.txt');
      put('edit/style/logo.png');

      await prepare(new ScriptedWriter());

      expect(readdirSync(frozen())).toEqual(['logo.png']);
      expect(briefMd()).toBe(withoutStyle());
    });

    it('fails the step, naming the cause, when the copy cannot be made', async () => {
      putStyle('style.md', STYLE);
      put('brief.txt');
      put('edit', 'a file where the folder should be');
      const writer = new ScriptedWriter();

      const outcome = await prepare(writer);

      expect(outcome).toMatchObject({ ok: false });
      expect(outcome.ok ? '' : outcome.error).toMatch(
        /^Brief stopped: the client’s style couldn’t be copied \(.+\)\.$/,
      );
      expect(writer.calls).toHaveLength(0);
    });
  });

  describe('brief.md', () => {
    it('ends with the Client style section made from the copy', async () => {
      putStyle('style.md', STYLE);
      putStyle('logo.png');
      putStyle('kit/title/index.html');
      put('brief.txt');

      await prepare(new ScriptedWriter());

      expect(briefMd()).toBe(
        renderBriefMd(draft(), {
          client: 'Acme',
          job: 'Teaser',
          note: null,
          style: { markdown: STYLE, files: ['style.md', 'logo.png', 'kit/'] },
        }),
      );
      expect(briefMd()).toContain(
        'Its files are in edit/style/: logo.png, kit/. Reuse the graphics',
      );
      expect(briefMd().endsWith('#### Look\n- Fonts: Heebo 800\n')).toBe(true);
    });

    it('is on a reused brief too', async () => {
      putStyle('style.md', STYLE);
      put('brief.txt');
      const writer = new ScriptedWriter();
      await prepare(writer);
      rmSync(join(jobDir(), BRIEF_MD_PATH));

      expect(await prepare(writer)).toMatchObject({ source: 'reused' });

      expect(briefMd()).toContain('\n## Client style\n');
      expect(briefMd()).toContain('\n### Style: Acme\n');
    });

    it('is on the no-instructions brief too', async () => {
      putStyle('style.md', STYLE);
      put('clip.mp4');
      const writer = new ScriptedWriter();

      expect(await prepare(writer)).toMatchObject({ source: 'skipped' });

      expect(writer.calls).toHaveLength(0);
      expect(briefMd()).toBe(
        renderBriefMd(noInstructionsBrief(['clip.mp4']), {
          client: 'Acme',
          job: 'Teaser',
          note: null,
          style: { markdown: STYLE, files: ['style.md'] },
        }),
      );
      expect(briefMd()).toContain('Its files are in edit/style/: none besides style.md.');
    });

    it('matches the golden bakery brief with its style, byte for byte', async () => {
      const fixture = JSON.parse(readFileSync(`${SHARED_FIXTURES}bakery-fixture.json`, 'utf8')) as {
        client: string;
        job: string;
        note: string;
        draft: BriefDraft;
      };
      const relPath = `${fixture.client}/${fixture.job}`;
      mkdirSync(join(inbox, relPath), { recursive: true });
      writeFileSync(join(inbox, relPath, '_chat.txt'), 'chat');
      // The sample style: its style.md, three of its files and a kit with two graphics.
      const bakeryStyle = join(inbox, fixture.client, '_Style');
      mkdirSync(join(bakeryStyle, 'kit', 'title-card'), { recursive: true });
      mkdirSync(join(bakeryStyle, 'kit', 'lower-third'), { recursive: true });
      writeFileSync(
        join(bakeryStyle, 'style.md'),
        readFileSync(`${SHARED_FIXTURES}bakery-style.md`, 'utf8'),
      );
      for (const name of ['brand-guide.pdf', 'logo-north-bakery.png', 'reference-reel.mp4']) {
        writeFileSync(join(bakeryStyle, name), name);
      }
      writeFileSync(join(bakeryStyle, 'kit', 'title-card', 'index.html'), '<html>');
      writeFileSync(join(bakeryStyle, 'kit', 'lower-third', 'index.html'), '<html>');
      const writer = new ScriptedWriter();
      writer.content = fixture.draft;
      const job = makeJob({
        client: fixture.client,
        name: fixture.job,
        relPath,
        note: fixture.note,
      });

      expect((await prepare(writer, job)).ok).toBe(true);

      expect(readFileSync(join(inbox, relPath, BRIEF_MD_PATH), 'utf8')).toBe(
        readFileSync(`${SHARED_FIXTURES}bakery-brief-with-style.md`, 'utf8'),
      );
    });
  });

  it('does not change the fingerprint: edit/style/ is not client material', async () => {
    putStyle('style.md', STYLE);
    put('brief.txt');
    put('clip.mp4');
    const before = briefFingerprint(await listJobFiles(jobDir()), null);

    await prepare(new ScriptedWriter());

    const saved = briefSchema.parse(readJson(BRIEF_JSON_PATH));
    expect(saved.fingerprint).toBe(before);
    expect(briefFingerprint(await listJobFiles(jobDir()), null)).toBe(before);
  });
});

// Series plan §4 (CVP-179): an episode's brief.md starts from its series, frozen in edit/series/.
describe('the series', () => {
  const SERIES =
    '# Series: Show\nFormat from Show 5 (2026-10-20).\n\n## New in each episode\n- Title\n';
  const STYLE = '# Style: Acme\nLearned from Launch (2026-10-20).\n';
  const SERIES_ID = '5e51e5000001';
  const seriesDir = () => join(inbox, 'Acme', '_Series', 'Show');
  const frozen = (relPath = '') => join(jobDir(), 'edit', 'series', relPath);
  const briefMd = () => readFileSync(join(jobDir(), BRIEF_MD_PATH), 'utf8');
  const episode = (overrides: Partial<Job> = {}) =>
    makeJob({ name: 'Show 6', seriesId: SERIES_ID, episode: 6, ...overrides });

  /** The series rows the step may look up, by id. */
  let rows: Map<string, StoredSeries>;
  beforeEach(() => {
    rows = new Map([
      [SERIES_ID, makeStoredSeries({ id: SERIES_ID, name: 'Show', client: 'Acme' })],
    ]);
  });

  function putSeries(relPath: string, content = 'x'): void {
    const path = join(seriesDir(), relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  function putStyle(relPath: string, content = 'x'): void {
    const path = join(inbox, 'Acme', '_Style', relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  function seriesStep(writer: BriefWriter) {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const brief = new BriefStep({
      inboxPath: inbox,
      writer,
      pollIntervalMs: 10,
      logger,
      series: { get: (id) => rows.get(id) ?? null },
    });
    return { brief, warn: logger.warn };
  }

  const prepare = (writer: BriefWriter, job = episode()) =>
    seriesStep(writer).brief.prepare(job, context().ctx);

  // CVP-255: the Brief run is told when the section will follow its brief, so its summary cannot
  // say "everything else follows video-use defaults" above a section that says the opposite.
  describe('what the Brief run is told', () => {
    it('is the series’ name and the episode’s number, for an episode with a series.md', async () => {
      putSeries('series.md', SERIES);
      put('brief.txt');
      const writer = new ScriptedWriter();

      expect(await prepare(writer)).toMatchObject({ ok: true, source: 'ran' });

      expect(writer.calls[0]?.run.series).toEqual({ name: 'Show', episode: 6 });
    });

    it('is the job’s own name without its number when the series row is gone', async () => {
      putSeries('series.md', SERIES);
      put('brief.txt');
      await prepare(new ScriptedWriter());
      rmSync(seriesDir(), { recursive: true });
      rows.clear();
      put('brief.txt', 'changed, so a new brief is written');
      const writer = new ScriptedWriter();

      expect(await prepare(writer)).toMatchObject({ ok: true, source: 'ran' });

      expect(writer.calls[0]?.run.series).toEqual({ name: 'Show', episode: 6 });
    });

    it('is nothing for a job that is not in a series', async () => {
      putSeries('series.md', SERIES);
      put('brief.txt');
      const writer = new ScriptedWriter();

      expect(await seriesStep(writer).brief.prepare(makeJob(), context().ctx)).toMatchObject({
        ok: true,
      });

      expect(writer.calls[0]?.run.series ?? null).toBeNull();
    });

    it('is nothing for an episode whose series has no series.md yet, as no Series section follows', async () => {
      put('brief.txt');
      const writer = new ScriptedWriter();

      expect(await prepare(writer)).toMatchObject({ ok: true, source: 'ran' });

      expect(writer.calls[0]?.run.series ?? null).toBeNull();
      expect(briefMd()).not.toContain('## Series');
    });
  });

  describe('the copy', () => {
    it('copies _Series/<name> into edit/series/ before the Brief run, as it is', async () => {
      putSeries('series.md', SERIES);
      putSeries('kit/index.html', '<html>');
      putSeries('kit/compositions/title.html', '<title>');
      putSeries('Review notes – Show 5 – round 1.md', 'a note');
      put('brief.txt');
      const writer = new ScriptedWriter();
      let seenByTheRun: string | null = null;
      writer.during = async (run) => {
        seenByTheRun = readFileSync(join(run.jobDir, 'edit', 'series', 'series.md'), 'utf8');
      };

      expect(await prepare(writer)).toMatchObject({ ok: true, source: 'ran' });

      expect(seenByTheRun).toBe(SERIES);
      expect(readdirSync(frozen()).sort()).toEqual([
        'Review notes – Show 5 – round 1.md',
        'kit',
        'series.md',
      ]);
      expect(readFileSync(frozen('kit/index.html'), 'utf8')).toBe('<html>');
      expect(readFileSync(frozen('kit/compositions/title.html'), 'utf8')).toBe('<title>');
      // _Series stays as it was, and nothing of the copy's staging is left in edit/.
      expect(readFileSync(join(seriesDir(), 'series.md'), 'utf8')).toBe(SERIES);
      expect(
        readdirSync(join(jobDir(), 'edit')).filter((name) => name.startsWith('.series')),
      ).toEqual([]);
    });

    it('leaves out series.md.new and dot files', async () => {
      putSeries('series.md', SERIES);
      putSeries('series.md.new', '# Series: half done');
      putSeries('.DS_Store');
      putSeries('kit/.DS_Store');
      putSeries('kit/a.html');
      put('brief.txt');

      await prepare(new ScriptedWriter());

      expect(readdirSync(frozen()).sort()).toEqual(['kit', 'series.md']);
      expect(readdirSync(frozen('kit'))).toEqual(['a.html']);
    });

    it('copies what a link points to, so the copy does not change when _Series does', async () => {
      putSeries('series.md', SERIES);
      putSeries('real.png', 'png');
      symlinkSync(join(seriesDir(), 'real.png'), join(seriesDir(), 'alias.png'));
      put('brief.txt');

      await prepare(new ScriptedWriter());

      expect(lstatSync(frozen('alias.png')).isSymbolicLink()).toBe(false);
      expect(readFileSync(frozen('alias.png'), 'utf8')).toBe('png');
    });

    it('is made once: Retry and Resume keep the series the job started with', async () => {
      putSeries('series.md', SERIES);
      putSeries('kit/index.html', '<html>');
      put('brief.txt');
      const writer = new ScriptedWriter();
      await prepare(writer);

      // The series changes in between: a new format, a new kit file, an install in progress.
      putSeries('series.md', '# Series: Show\nNew format.\n');
      putSeries('kit/new.html');
      putSeries('series.md.new', '# Series: Show\nNext.\n');

      // A new note makes a new brief (a run); an unchanged one reuses it.
      expect(await prepare(writer, episode({ note: 'Shorter.' }))).toMatchObject({ source: 'ran' });
      expect(await prepare(writer, episode({ note: 'Shorter.' }))).toMatchObject({
        source: 'reused',
      });

      expect(readFileSync(frozen('series.md'), 'utf8')).toBe(SERIES);
      expect(readdirSync(frozen('kit'))).toEqual(['index.html']);
      expect(briefMd()).toContain('Format from Show 5');
      expect(briefMd()).not.toContain('New format.');
    });

    it('is kept for the retry even when the series is gone from _Series and the database', async () => {
      putSeries('series.md', SERIES);
      put('brief.txt');
      const writer = new ScriptedWriter();
      writer.outcome = {
        ok: false,
        error: 'Brief stopped: the brief took longer than 10 minutes.',
      };
      expect(await prepare(writer)).toMatchObject({ ok: false });
      rmSync(seriesDir(), { recursive: true });
      rows.clear();

      writer.outcome = { ok: true };
      expect(await prepare(writer)).toMatchObject({ ok: true, source: 'ran' });

      expect(readFileSync(frozen('series.md'), 'utf8')).toBe(SERIES);
      // The name comes from the job's own name now that the series row is gone.
      expect(briefMd()).toContain('This job is episode 6 of the series “Show”.');
      expect(briefMd()).toContain('\n### Series: Show\n');
    });

    it('is made even when an injected failure ends the step at once', async () => {
      putSeries('series.md', SERIES);
      put('brief.txt');
      const failing: BriefWriter = {
        write: new ScriptedWriter().write,
        injectedFailure: async () => 'Brief failed: injected failure (.fail-at-brief)',
      };

      expect(await prepare(failing)).toMatchObject({ ok: false });

      expect(readFileSync(frozen('series.md'), 'utf8')).toBe(SERIES);
    });

    it('starts over from a copy that was cut short', async () => {
      putSeries('series.md', SERIES);
      put('brief.txt');
      put('edit/.series-copying/half.txt');

      await prepare(new ScriptedWriter());

      expect(readdirSync(frozen())).toEqual(['series.md']);
      expect(existsSync(join(jobDir(), 'edit', '.series-copying'))).toBe(false);
    });

    it('makes no copy and no section for a job that is not in a series', async () => {
      putSeries('series.md', SERIES);
      put('brief.txt');
      const { brief, warn } = seriesStep(new ScriptedWriter());

      expect(await brief.prepare(makeJob(), context().ctx)).toMatchObject({ ok: true });

      expect(existsSync(frozen())).toBe(false);
      expect(briefMd()).toBe(renderBriefMd(draft(), { client: 'Acme', job: 'Teaser', note: null }));
      expect(warn).not.toHaveBeenCalled();
    });

    it('makes no copy when the step was built without the series rows', async () => {
      putSeries('series.md', SERIES);
      put('brief.txt');

      expect(await step(new ScriptedWriter()).prepare(episode(), context().ctx)).toMatchObject({
        ok: true,
      });

      expect(existsSync(frozen())).toBe(false);
      expect(briefMd()).not.toContain('## Series');
    });

    describe('a series with no series.md yet', () => {
      it.each([
        ['there is no folder for it', () => undefined],
        ['its folder has no series.md', () => putSeries('kit/index.html')],
        [
          'only the pass’s series.md.new is there',
          () => putSeries('series.md.new', '# Series: Show'),
        ],
        [
          'series.md is a folder',
          () => mkdirSync(join(seriesDir(), 'series.md'), { recursive: true }),
        ],
      ])('makes no copy and no section, and warns, when %s', async (_case, arrange) => {
        arrange();
        put('brief.txt');
        const { brief, warn } = seriesStep(new ScriptedWriter());

        expect(await brief.prepare(episode(), context().ctx)).toMatchObject({ ok: true });

        expect(existsSync(frozen())).toBe(false);
        expect(briefMd()).toBe(
          renderBriefMd(draft(), { client: 'Acme', job: 'Show 6', note: null }),
        );
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ jobId: 'b4b4b4b4b4b4', series: 'Show' }),
          expect.stringContaining('series.md yet'),
        );
      });

      it('warns when the series is not in the database either', async () => {
        putSeries('series.md', SERIES);
        put('brief.txt');
        rows.clear();
        const { brief, warn } = seriesStep(new ScriptedWriter());

        expect(await brief.prepare(episode(), context().ctx)).toMatchObject({ ok: true });

        expect(existsSync(frozen())).toBe(false);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ seriesId: SERIES_ID, series: null }),
          expect.stringContaining('series.md yet'),
        );
      });

      it('is copied by a later attempt, once the series has its series.md', async () => {
        put('brief.txt');
        const writer = new ScriptedWriter();
        await prepare(writer);
        expect(existsSync(frozen())).toBe(false);

        putSeries('series.md', SERIES);
        putSeries('kit/index.html');
        expect(await prepare(writer)).toMatchObject({ source: 'reused' });

        expect(readFileSync(frozen('series.md'), 'utf8')).toBe(SERIES);
        expect(briefMd()).toContain('\n## Series\n');
      });
    });

    it('fails the step, naming the cause, when the copy cannot be made', async () => {
      putSeries('series.md', SERIES);
      put('brief.txt');
      put('edit', 'a file where the folder should be');
      const writer = new ScriptedWriter();

      const outcome = await prepare(writer);

      expect(outcome).toMatchObject({ ok: false });
      expect(outcome.ok ? '' : outcome.error).toMatch(
        /^Brief stopped: the series couldn’t be copied \(.+\)\.$/,
      );
      expect(writer.calls).toHaveLength(0);
    });
  });

  describe('brief.md', () => {
    it('has the Series section, then the Client style one that points to the series kit', async () => {
      putSeries('series.md', SERIES);
      putSeries('kit/index.html');
      putStyle('style.md', STYLE);
      putStyle('kit/title/index.html');
      put('brief.txt');

      await prepare(new ScriptedWriter());

      expect(briefMd()).toBe(
        renderBriefMd(draft(), {
          client: 'Acme',
          job: 'Show 6',
          note: null,
          style: { markdown: STYLE, files: ['style.md', 'kit/'] },
          series: { name: 'Show', episode: 6, markdown: SERIES },
        }),
      );
      const md = briefMd();
      expect(md).toContain(
        '\n## Series\nThis job is episode 6 of the series “Show”. Rebuild it from the series’ composition in edit/series/kit/:',
      );
      expect(md).toContain(
        '\n### Series: Show\nFormat from Show 5 (2026-10-20).\n\n#### New in each episode\n- Title\n',
      );
      expect(md.indexOf('\n## Series\n')).toBeLessThan(md.indexOf('\n## Client style\n'));
      expect(md).toContain(
        'Its files are in edit/style/: kit/. Use the series kit in edit/series/kit/, not edit/style/kit/.',
      );
      expect(md).not.toContain('Reuse the graphics in edit/style/kit/');
    });

    it('says "an episode" when the job’s name has no number', async () => {
      putSeries('series.md', SERIES);
      put('brief.txt');

      await prepare(new ScriptedWriter(), episode({ name: 'Show', episode: null }));

      expect(briefMd()).toContain('\nThis job is an episode of the series “Show”. Rebuild it');
    });

    it('is on a reused brief and on the no-instructions brief too', async () => {
      putSeries('series.md', SERIES);
      put('brief.txt');
      const writer = new ScriptedWriter();
      await prepare(writer);
      rmSync(join(jobDir(), BRIEF_MD_PATH));

      expect(await prepare(writer)).toMatchObject({ source: 'reused' });
      expect(briefMd()).toContain('\n## Series\n');

      rmSync(join(jobDir(), 'brief.txt'));
      put('clip.mp4');
      expect(await prepare(writer)).toMatchObject({ source: 'skipped' });
      expect(briefMd()).toContain('\n## Series\n');
    });

    it('leaves a job that is not in a series with the brief.md it had, byte for byte', async () => {
      const fixture = JSON.parse(readFileSync(`${SHARED_FIXTURES}bakery-fixture.json`, 'utf8')) as {
        client: string;
        job: string;
        note: string;
        draft: BriefDraft;
      };
      const relPath = `${fixture.client}/${fixture.job}`;
      mkdirSync(join(inbox, relPath), { recursive: true });
      writeFileSync(join(inbox, relPath, '_chat.txt'), 'chat');
      // The client has a series; this job simply isn't an episode of it.
      mkdirSync(join(inbox, fixture.client, '_Series', 'Show', 'kit'), { recursive: true });
      writeFileSync(join(inbox, fixture.client, '_Series', 'Show', 'series.md'), SERIES);
      const writer = new ScriptedWriter();
      writer.content = fixture.draft;
      const job = makeJob({
        client: fixture.client,
        name: fixture.job,
        relPath,
        note: fixture.note,
      });

      expect((await prepare(writer, job)).ok).toBe(true);

      expect(readFileSync(join(inbox, relPath, BRIEF_MD_PATH), 'utf8')).toBe(
        readFileSync(`${SHARED_FIXTURES}bakery-brief.md`, 'utf8'),
      );
      expect(existsSync(join(inbox, relPath, 'edit', 'series'))).toBe(false);
    });
  });

  it('does not change the fingerprint: edit/series/ is not client material', async () => {
    putSeries('series.md', SERIES);
    put('brief.txt');
    put('clip.mp4');
    const before = briefFingerprint(await listJobFiles(jobDir()), null);

    await prepare(new ScriptedWriter());

    const saved = briefSchema.parse(readJson(BRIEF_JSON_PATH));
    expect(saved.fingerprint).toBe(before);
    expect(briefFingerprint(await listJobFiles(jobDir()), null)).toBe(before);
  });
});

// GR8: the Graphics library. While the graphicsInEdits switch is on the engine gives the step the
// library's rows; each edit then gets a fresh copy of every live graphic that edits can use, in
// edit/graphics/<id>/, and brief.md a "Graphics library" section. Off, none of it happens.
describe('the Graphics library', () => {
  const PILL = 'a1b2c3d4e5f6';
  const BIG = '0f9e8d7c6b5a';
  const NAME = 'Name on a white pill';
  const frozen = (relPath = '') => join(jobDir(), 'edit', 'graphics', relPath);
  const briefMd = () => readFileSync(join(jobDir(), BRIEF_MD_PATH), 'utf8');
  const withoutGraphics = () =>
    renderBriefMd(draft(), { client: 'Acme', job: 'Teaser', note: null });

  let repo: GraphicRepository;
  beforeEach(() => {
    repo = new GraphicRepository(memoryDb());
    put('brief.txt');
  });

  /** A file of a graphic's version, in `_Graphics/<folder>/versions/v<n>/`. */
  function putVersion(folder: string, version: number, relPath: string, content = 'x'): void {
    const path = join(inbox, '_Graphics', folder, 'versions', `v${version}`, relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  /** The files of a whole version; `marker` is inside the graphic, so a test can tell versions apart. */
  function putWholeVersion(folder: string, id: string, version: number, marker = `v${version}`) {
    putVersion(folder, version, 'index.html', '<html>host</html>');
    putVersion(folder, version, 'vendor/gsap.min.js', '/* gsap */');
    putVersion(folder, version, 'about.json', '{}');
    putVersion(folder, version, `compositions/lib-${id}.html`, `<template>${marker}</template>`);
    putVersion(folder, version, `lib/${id}/fonts/Heebo-Bold.ttf`, 'font');
  }

  /** A graphic in the library, at `version` with its files in `_Graphics` (`files: false`: no files). */
  function makeGraphic(
    options: {
      id?: string;
      name?: string;
      version?: number | null;
      uses?: boolean;
      files?: boolean;
    } = {},
  ): string {
    const { id = PILL, name = NAME, version = 1, uses = true, files = true } = options;
    repo.create({ id, name, uses });
    if (version !== null) {
      repo.setVersion(id, {
        version,
        kind: 'lower-third',
        lengthSec: 3,
        variables: [
          { id: 'name', label: 'Name', default: 'דנה לוי' },
          { id: 'role', label: 'Role', default: 'Founder' },
        ],
        when: 'The first time a person is named on camera.',
      });
      if (files) putWholeVersion(name, id, version);
    }
    return id;
  }

  const LINE =
    '- Name on a white pill (edit/graphics/a1b2c3d4e5f6/): lower third, 3 s. When: The first time a person is named on camera. Text: name (Name), role (Role).';

  function libraryStep(
    writer: BriefWriter = new ScriptedWriter(),
    graphics: Pick<GraphicRepository, 'list'> = repo,
  ) {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const brief = new BriefStep({ inboxPath: inbox, writer, pollIntervalMs: 10, logger, graphics });
    return { brief, logger };
  }

  const prepare = (job = makeJob(), writer: BriefWriter = new ScriptedWriter()) =>
    libraryStep(writer).brief.prepare(job, context().ctx);

  describe('the copy', () => {
    it('copies a live graphic with a version into edit/graphics/<id>/, whole', async () => {
      makeGraphic();

      expect(await prepare()).toMatchObject({ ok: true });

      expect(readFileSync(frozen(`${PILL}/compositions/lib-${PILL}.html`), 'utf8')).toBe(
        '<template>v1</template>',
      );
      expect(readFileSync(frozen(`${PILL}/lib/${PILL}/fonts/Heebo-Bold.ttf`), 'utf8')).toBe('font');
      // The engine-only files cost nothing and stay.
      expect(existsSync(frozen(`${PILL}/index.html`))).toBe(true);
      expect(existsSync(frozen(`${PILL}/vendor/gsap.min.js`))).toBe(true);
      expect(existsSync(frozen(`${PILL}/about.json`))).toBe(true);
    });

    it('copies the version edits use, not another one that is in the folder', async () => {
      const id = makeGraphic({ version: 2 });
      putWholeVersion(NAME, id, 3, 'v3: made but not used');

      expect(await prepare()).toMatchObject({ ok: true });

      expect(readFileSync(frozen(`${id}/compositions/lib-${id}.html`), 'utf8')).toBe(
        '<template>v2</template>',
      );
      expect(existsSync(frozen(`${id}/versions`))).toBe(false);
    });

    it('copies every graphic that is live, with a version and Edits can use it on', async () => {
      makeGraphic();
      makeGraphic({ id: BIG, name: 'Big number' });

      expect(await prepare()).toMatchObject({ ok: true });

      expect(readdirSync(frozen()).sort()).toEqual([BIG, PILL]);
    });

    it.each([
      ['Edits can use it is off', { uses: false }],
      ['it has no version yet', { version: null }],
    ])('leaves a graphic out when %s', async (_case, options) => {
      makeGraphic();
      makeGraphic({ id: BIG, name: 'Big number', ...options });

      expect(await prepare()).toMatchObject({ ok: true });

      expect(readdirSync(frozen())).toEqual([PILL]);
      expect(briefMd()).not.toContain('Big number');
    });

    it('leaves a deleted graphic out', async () => {
      makeGraphic();
      makeGraphic({ id: BIG, name: 'Big number' });
      repo.softDelete(BIG);

      expect(await prepare()).toMatchObject({ ok: true });

      expect(readdirSync(frozen())).toEqual([PILL]);
      expect(briefMd()).not.toContain('Big number');
    });

    it('leaves out dot files and folders: they are tools’ scratch, not the graphic', async () => {
      makeGraphic();
      putVersion(NAME, 1, '.DS_Store');
      putVersion(NAME, 1, '.hyperframes/video-state.json');

      expect(await prepare()).toMatchObject({ ok: true });

      expect(existsSync(frozen(`${PILL}/.DS_Store`))).toBe(false);
      expect(existsSync(frozen(`${PILL}/.hyperframes`))).toBe(false);
      expect(existsSync(frozen(`${PILL}/index.html`))).toBe(true);
    });

    it('copies what a link points to, so the copy does not change when the graphic does', async () => {
      makeGraphic();
      const outside = join(inbox, 'logo.svg');
      writeFileSync(outside, '<svg/>');
      symlinkSync(
        outside,
        join(inbox, '_Graphics', NAME, 'versions', 'v1', 'lib', PILL, 'logo.svg'),
      );

      expect(await prepare()).toMatchObject({ ok: true });

      expect(lstatSync(frozen(`${PILL}/lib/${PILL}/logo.svg`)).isSymbolicLink()).toBe(false);
      expect(readFileSync(frozen(`${PILL}/lib/${PILL}/logo.svg`), 'utf8')).toBe('<svg/>');
    });

    it('leaves no staging folder behind', async () => {
      makeGraphic();

      await prepare();

      expect(readdirSync(join(jobDir(), 'edit')).filter((name) => name.startsWith('.'))).toEqual(
        [],
      );
    });

    it('makes no edit/graphics/ when no graphic can be used', async () => {
      makeGraphic({ uses: false });

      expect(await prepare()).toMatchObject({ ok: true });

      expect(existsSync(frozen())).toBe(false);
      expect(briefMd()).toBe(withoutGraphics());
    });

    it('does not change the fingerprint: edit/graphics/ is not client material', async () => {
      makeGraphic();
      put('clip.mp4');
      const before = briefFingerprint(await listJobFiles(jobDir()), null);

      await prepare();

      expect(briefSchema.parse(readJson(BRIEF_JSON_PATH)).fingerprint).toBe(before);
      expect(briefFingerprint(await listJobFiles(jobDir()), null)).toBe(before);
    });
  });

  describe('fresh on every prepare', () => {
    it('is made again, so a graphic changed since is the new version', async () => {
      const id = makeGraphic();
      await prepare();
      putWholeVersion(NAME, id, 2);
      repo.setVersion(id, { version: 2 });

      expect(await prepare()).toMatchObject({ ok: true, source: 'reused' });

      expect(readFileSync(frozen(`${id}/compositions/lib-${id}.html`), 'utf8')).toBe(
        '<template>v2</template>',
      );
    });

    it('takes away what the last copy had and this one does not', async () => {
      const id = makeGraphic();
      makeGraphic({ id: BIG, name: 'Big number' });
      await prepare();
      // A file the job's run put into the copy, and a graphic that is turned off since.
      writeFileSync(frozen(`${id}/scratch.txt`), 'x');
      repo.setUses(BIG, false);

      expect(await prepare()).toMatchObject({ ok: true });

      expect(existsSync(frozen(`${id}/scratch.txt`))).toBe(false);
      expect(readdirSync(frozen())).toEqual([PILL]);
      expect(briefMd()).not.toContain('Big number');
    });

    it('removes edit/graphics/ once no graphic can be used any more', async () => {
      const id = makeGraphic();
      await prepare();
      expect(existsSync(frozen())).toBe(true);
      repo.softDelete(id);

      expect(await prepare()).toMatchObject({ ok: true });

      expect(existsSync(frozen())).toBe(false);
      expect(briefMd()).toBe(withoutGraphics());
    });

    it('is made for a brief that is reused and for one that is skipped too', async () => {
      makeGraphic();
      const { brief } = libraryStep();
      expect(await brief.prepare(makeJob(), context().ctx)).toMatchObject({ source: 'ran' });
      rmSync(frozen(), { recursive: true });
      writeFileSync(join(jobDir(), BRIEF_MD_PATH), 'stale');

      expect(await brief.prepare(makeJob(), context().ctx)).toMatchObject({ source: 'reused' });
      expect(existsSync(frozen(`${PILL}/index.html`))).toBe(true);
      expect(briefMd()).toContain(LINE);

      // Only video and no note: the engine writes the brief itself.
      rmSync(join(jobDir(), 'brief.txt'));
      put('clip.mp4');
      rmSync(frozen(), { recursive: true });
      expect(await brief.prepare(makeJob(), context().ctx)).toMatchObject({ source: 'skipped' });
      expect(existsSync(frozen(`${PILL}/index.html`))).toBe(true);
      expect(briefMd()).toContain(LINE);
    });
  });

  describe('brief.md', () => {
    it('ends with the Graphics library section made from the graphics that were copied', async () => {
      makeGraphic();
      makeGraphic({ id: BIG, name: 'Big number' });
      const about = {
        kind: 'lower-third',
        lengthSec: 3,
        when: 'The first time a person is named on camera.',
        variables: [
          { id: 'name', label: 'Name' },
          { id: 'role', label: 'Role' },
        ],
      } as const;

      expect(await prepare()).toMatchObject({ ok: true });

      expect(briefMd()).toBe(
        renderBriefMd(draft(), {
          client: 'Acme',
          job: 'Teaser',
          note: null,
          graphics: [
            { id: BIG, name: 'Big number', ...about },
            { id: PILL, name: NAME, ...about },
          ],
        }),
      );
      expect(briefMd()).toContain('\n## Graphics library\n');
      expect(briefMd()).toContain(LINE);
    });

    it('comes after the shared fonts', async () => {
      makeGraphic();
      const font = join(inbox, '_Fonts', 'Heebo-Bold.ttf');
      mkdirSync(dirname(font), { recursive: true });
      writeFileSync(font, 'font');

      expect(await prepare()).toMatchObject({ ok: true });

      expect(
        briefMd()
          .match(/^## .*$/gm)
          ?.slice(-2),
      ).toEqual(['## Fonts', '## Graphics library']);
    });

    it('says when to use a graphic whose When the owner left blank', async () => {
      makeGraphic();
      repo.setWhen(PILL, '');

      expect(await prepare()).toMatchObject({ ok: true });

      expect(briefMd()).toContain(
        'When: only where the brief or the owner’s note names it. Text: name (Name), role (Role).',
      );
    });
  });

  describe('a copy that fails', () => {
    it('leaves that graphic out, warns, and still copies and lists the others', async () => {
      makeGraphic();
      makeGraphic({ id: BIG, name: 'Big number', files: false });
      const { brief, logger } = libraryStep();

      expect(await brief.prepare(makeJob(), context().ctx)).toMatchObject({ ok: true });

      expect(readdirSync(frozen())).toEqual([PILL]);
      expect(briefMd()).toContain(LINE);
      expect(briefMd()).not.toContain('Big number');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ graphic: 'Big number', graphicId: BIG }),
        expect.stringContaining('could not be copied'),
      );
    });

    it('leaves out a graphic whose version has no compositions/lib-<id>.html, and nothing of it in the copy', async () => {
      makeGraphic();
      makeGraphic({ id: BIG, name: 'Big number', files: false });
      putVersion('Big number', 1, 'index.html', '<html/>');
      putVersion('Big number', 1, `lib/${BIG}/logo.svg`, '<svg/>');
      const { brief, logger } = libraryStep();

      expect(await brief.prepare(makeJob(), context().ctx)).toMatchObject({ ok: true });

      expect(readdirSync(frozen())).toEqual([PILL]);
      expect(briefMd()).not.toContain('Big number');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          graphicId: BIG,
          err: expect.objectContaining({ message: expect.stringContaining(`lib-${BIG}.html`) }),
        }),
        expect.any(String),
      );
    });

    it('makes no section and no folder when none of them can be copied', async () => {
      makeGraphic({ files: false });

      expect(await prepare()).toMatchObject({ ok: true });

      expect(existsSync(frozen())).toBe(false);
      expect(briefMd()).toBe(withoutGraphics());
    });

    it('never fails the brief when the library cannot be read at all', async () => {
      const broken = {
        list: () => {
          throw new Error('database is locked');
        },
      };
      const { brief, logger } = libraryStep(new ScriptedWriter(), broken);

      expect(await brief.prepare(makeJob(), context().ctx)).toMatchObject({ ok: true });

      expect(briefMd()).toBe(withoutGraphics());
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'b4b4b4b4b4b4' }),
        expect.stringContaining('graphics library could not be copied'),
      );
    });
  });

  describe('with the switch off (the step is built without the library)', () => {
    it('copies nothing and leaves brief.md exactly as it was, byte for byte', async () => {
      makeGraphic();
      makeGraphic({ id: BIG, name: 'Big number' });

      expect(await step(new ScriptedWriter()).prepare(makeJob(), context().ctx)).toMatchObject({
        ok: true,
      });

      expect(existsSync(frozen())).toBe(false);
      expect(briefMd()).toBe(withoutGraphics());
      expect(briefMd()).not.toContain('Graphics library');
    });

    it('matches the golden bakery brief byte for byte', async () => {
      makeGraphic();
      const fixture = JSON.parse(readFileSync(`${SHARED_FIXTURES}bakery-fixture.json`, 'utf8')) as {
        client: string;
        job: string;
        note: string;
        draft: BriefDraft;
      };
      const relPath = `${fixture.client}/${fixture.job}`;
      mkdirSync(join(inbox, relPath), { recursive: true });
      writeFileSync(join(inbox, relPath, '_chat.txt'), 'chat');
      const writer = new ScriptedWriter();
      writer.content = fixture.draft;
      const job = makeJob({
        client: fixture.client,
        name: fixture.job,
        relPath,
        note: fixture.note,
      });

      expect((await step(writer).prepare(job, context().ctx)).ok).toBe(true);

      expect(readFileSync(join(inbox, relPath, BRIEF_MD_PATH), 'utf8')).toBe(
        readFileSync(`${SHARED_FIXTURES}bakery-brief.md`, 'utf8'),
      );
    });
  });
});

// U21: music is made only when the job asks for it. With the music switch on, brief.md tells the
// editor whether the instructions asked; with it off the brief is what it was.
describe('music only when asked', () => {
  const musicOf = (wanted: boolean): NonNullable<BriefDraft['music']> => ({
    file: null,
    note: wanted ? 'intense, with drops' : null,
    wanted,
    song: null,
    original: null,
    wantsTrending: false,
  });
  const stepWith = (writer: BriefWriter, music: boolean) =>
    new BriefStep({ inboxPath: inbox, writer, pollIntervalMs: 10, music });
  const briefMd = () => readFileSync(join(jobDir(), BRIEF_MD_PATH), 'utf8');
  const decisions = () =>
    briefMd()
      .split('\n')
      .filter((line) => line.startsWith('- Music'));

  it('says “asked for, made by the editor” for a brief that asks for music', async () => {
    put('clip.mp4');
    put('brief.txt', 'Add music with drops.');
    const writer = new ScriptedWriter();
    writer.content = draft({ music: musicOf(true) });

    expect((await stepWith(writer, true).prepare(makeJob(), context().ctx)).ok).toBe(true);

    expect(decisions()).toEqual(['- Music: asked for, made by the editor (intense, with drops)']);
    expect(briefSchema.parse(readJson(BRIEF_JSON_PATH)).music?.wanted).toBe(true);
  });

  it('says “not asked for” for a brief that asks for nothing, only with the switch on', async () => {
    put('clip.mp4');
    put('brief.txt', 'Short and punchy.');
    const writer = new ScriptedWriter();
    writer.content = draft({ music: null });

    expect((await stepWith(writer, true).prepare(makeJob(), context().ctx)).ok).toBe(true);
    expect(decisions()).toEqual(['- Music: not asked for']);

    // Off: brief.md has no music line, as it never had.
    expect(
      (await stepWith(writer, false).prepare(makeJob({ note: 'again' }), context().ctx)).ok,
    ).toBe(true);
    expect(decisions()).toEqual([]);
    expect(briefMd()).toBe(
      renderBriefMd(draft({ music: null }), { client: 'Acme', job: 'Teaser', note: 'again' }),
    );
  });

  it('says it for a brief with no instructions at all (the skipped brief): nothing asked', async () => {
    put('clip.mp4');
    const outcome = await stepWith(new ScriptedWriter(), true).prepare(makeJob(), context().ctx);
    expect(outcome).toMatchObject({ ok: true, source: 'skipped' });
    expect(decisions()).toEqual(['- Music: not asked for']);
  });

  it('drops a music.wanted the run wrote while the switch is off, and keeps it while it is on', async () => {
    put('clip.mp4');
    put('brief.txt', 'Add music.');
    const writer = new ScriptedWriter();
    writer.content = draft({ music: musicOf(true) });

    await stepWith(writer, false).prepare(makeJob(), context().ctx);
    expect(briefSchema.parse(readJson(BRIEF_JSON_PATH)).music).toEqual({
      ...musicOf(true),
      wanted: false,
    });
    expect(decisions()).toEqual(['- Music: intense, with drops']);

    await stepWith(writer, true).prepare(makeJob({ note: 'again' }), context().ctx);
    expect(briefSchema.parse(readJson(BRIEF_JSON_PATH)).music?.wanted).toBe(true);
  });

  it('reuses a brief from before music.wanted: it parses as not asked, and the fingerprint is the same', async () => {
    put('clip.mp4');
    put('brief.txt', 'Keep the logo at the end.');
    const before = new ScriptedWriter();
    // The brief.json a run wrote before the key existed: music with only a file and a note.
    before.content = draft({
      music: { file: 'm.mp3', note: null } as unknown as BriefDraft['music'],
    });
    await step(before).prepare(makeJob(), context().ctx);
    const fingerprint = briefSchema.parse(readJson(BRIEF_JSON_PATH)).fingerprint;

    const writer = new ScriptedWriter();
    const outcome = await stepWith(writer, true).prepare(makeJob(), context().ctx);

    expect(outcome).toMatchObject({ ok: true, source: 'reused' });
    expect(writer.calls).toHaveLength(0);
    expect(briefSchema.parse(readJson(BRIEF_JSON_PATH))).toMatchObject({
      fingerprint,
      music: { file: 'm.mp3', wanted: false },
    });
    expect(decisions()).toEqual(['- Music: m.mp3']);
  });
});
