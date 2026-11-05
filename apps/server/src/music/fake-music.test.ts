import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FIXED_NOTES_HEADING,
  MUSIC_FILES,
  MUSIC_NOT_ASKED_REASON,
  musicPlanSchema,
  musicRecordSchema,
  renderRoundFile,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAKE_BRIEF_ORIGINAL_BY, fakeBriefDraft } from '../pipeline/fake-brief.js';
import { resolveFfmpeg } from '../pipeline/fake-media.js';
import {
  FAKE_SONG_NICHE,
  type FakeSongAsk,
  fakeMusicPlan,
  fakeSongArgv,
  fakeSongEnv,
  getFakeRoundSongs,
  makeFakeMusic,
  makeFakeNoMusic,
  readFakeMusicWanted,
  readFakeNotAsked,
  readFakeSongAsk,
  songAsksOfRound,
} from './fake-music.js';
import type { MusicScriptRunner } from './music-script.js';
import { ranFailed, ranOk } from './test-utils.js';

// The fake runner's music: a plan that fits the cut, and the script's fake path to make v1.

const haveFfmpeg = (await resolveFfmpeg('ffmpeg')) !== null;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('fakeMusicPlan', () => {
  it.each([3_000, 5_999, 6_000, 6_400, 28_400, 120_000, 125_000, 240_000, 300_000, 600_000])(
    'is a plan that fits the contract for a cut of %s ms',
    (lengthMs) => {
      const plan = fakeMusicPlan(lengthMs);
      expect(musicPlanSchema.safeParse(plan).success, JSON.stringify(plan)).toBe(true);
      expect(plan.lengthMs).toBe(lengthMs);
      expect(plan.sections.reduce((sum, section) => sum + section.ms, 0)).toBe(lengthMs);
    },
  );

  it('has a build and a drop once the cut is long enough, a single tone before that', () => {
    expect(fakeMusicPlan(6_000).sections.map((section) => section.name)).toEqual(['Build', 'Drop']);
    expect(fakeMusicPlan(5_000).sections.map((section) => section.name)).toEqual(['Tone']);
    expect(fakeMusicPlan(6_000).describe).toBe('A fake tone, 0:06 long, made without ElevenLabs.');
  });

  it('is never shorter than ElevenLabs makes', () => {
    expect(fakeMusicPlan(1_000).lengthMs).toBe(3_000);
  });
});

describe('makeFakeMusic', () => {
  it('writes the plan and runs `make --by edit --fake` for the edit folder', async () => {
    const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-music-'));
    dirs.push(editDir);
    const run = vi.fn<MusicScriptRunner>(async () => ranOk('v1', 6_000));
    const signal = new AbortController().signal;

    expect(await makeFakeMusic({ editDir, lengthMs: 6_000, signal, run })).toBe(true);

    expect(run).toHaveBeenCalledWith({
      argv: ['make', editDir, '--by', 'edit', '--fake'],
      signal,
      timeoutMs: 60_000,
    });
    const plan = JSON.parse(readFileSync(join(editDir, MUSIC_FILES.plan), 'utf8'));
    expect(plan).toEqual(fakeMusicPlan(6_000));
    expect(existsSync(`${join(editDir, MUSIC_FILES.plan)}.tmp`)).toBe(false);
  });

  it('says false when the script did not make it (it said no, or it was stopped)', async () => {
    for (const outcome of [
      ranFailed('failed', 'ffmpeg is not installed.', 1),
      { kind: 'stopped', reason: 'cancel' },
      { kind: 'timed_out' },
    ] as const) {
      const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-music-'));
      dirs.push(editDir);
      expect(await makeFakeMusic({ editDir, lengthMs: 6_000, run: async () => outcome })).toBe(
        false,
      );
    }
  });
});

// --- Music only when asked (U21) -----------------------------------------------------------------

describe('makeFakeNoMusic: music was not asked for', () => {
  it('writes the plan and runs `none --plan` with the reason the app tells apart', async () => {
    const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-nomusic-'));
    dirs.push(editDir);
    const run = vi.fn<MusicScriptRunner>(async () => ranOk('none', null));
    const signal = new AbortController().signal;

    expect(await makeFakeNoMusic({ editDir, lengthMs: 6_000, signal, run })).toBe(true);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      argv: ['none', editDir, MUSIC_NOT_ASKED_REASON, '--plan'],
      signal,
      timeoutMs: 60_000,
    });
    expect(MUSIC_NOT_ASKED_REASON).toBe('Music was not asked for.');
    expect(JSON.parse(readFileSync(join(editDir, MUSIC_FILES.plan), 'utf8'))).toEqual(
      fakeMusicPlan(6_000),
    );
  });

  it('says false when the script did not record it (it said no, or it was stopped)', async () => {
    for (const outcome of [
      ranFailed('failed', 'ffmpeg is not installed.', 1),
      { kind: 'stopped', reason: 'cancel' },
    ] as const) {
      const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-nomusic-'));
      dirs.push(editDir);
      expect(await makeFakeNoMusic({ editDir, lengthMs: 6_000, run: async () => outcome })).toBe(
        false,
      );
    }
  });

  it.skipIf(!haveFfmpeg)(
    'with the real script: no music in the record, a plan, silence',
    async () => {
      const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-nomusic-'));
      dirs.push(editDir);
      expect(await makeFakeNoMusic({ editDir, lengthMs: 6_000 })).toBe(true);
      const record = musicRecordSchema.parse(
        JSON.parse(readFileSync(join(editDir, MUSIC_FILES.record), 'utf8')),
      );
      expect(record).toMatchObject({
        source: 'none',
        reason: MUSIC_NOT_ASKED_REASON,
        picked: null,
        versions: [],
      });
      expect(record.plan).toEqual(fakeMusicPlan(6_000));
      expect(existsSync(join(editDir, MUSIC_FILES.preview))).toBe(true);
      expect(await readFakeNotAsked(editDir)).toBe(true);
    },
  );
});

describe('readFakeMusicWanted and readFakeNotAsked', () => {
  const editWithMusic = (music: unknown): string => {
    const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-wanted-'));
    dirs.push(editDir);
    const draft = fakeBriefDraft({ client: 'Acme', name: 'Teaser' }, [], null);
    writeFileSync(
      join(editDir, 'brief.json'),
      JSON.stringify({ schema: 1, fingerprint: 'abc', ...draft, music }),
    );
    return editDir;
  };
  const music = (wanted: boolean) => ({
    file: null,
    note: null,
    wanted,
    song: null,
    original: null,
    wantsTrending: false,
  });

  it('reads music.wanted from the brief', async () => {
    expect(await readFakeMusicWanted(editWithMusic(music(true)))).toBe(true);
    expect(await readFakeMusicWanted(editWithMusic(music(false)))).toBe(false);
    expect(await readFakeMusicWanted(editWithMusic(null))).toBe(false);
    // A brief from before the key has no `wanted`: not asked.
    const { wanted: _wanted, ...before } = music(true);
    expect(await readFakeMusicWanted(editWithMusic(before))).toBe(false);
  });

  it('is false when there is no brief or it is not one', async () => {
    const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-wanted-'));
    dirs.push(editDir);
    expect(await readFakeMusicWanted(editDir)).toBe(false);
    writeFileSync(join(editDir, 'brief.json'), '{"nope":true}');
    expect(await readFakeMusicWanted(editDir)).toBe(false);
  });

  it('reads the not-asked reason from the music record, and nothing else', async () => {
    const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-wanted-'));
    dirs.push(editDir);
    expect(await readFakeNotAsked(editDir)).toBe(false);
    mkdirSync(join(editDir, 'music'), { recursive: true });
    const record = (reason: string) => ({
      v: 1,
      source: 'none',
      reason,
      file: null,
      plan: null,
      picked: null,
      versions: [],
      picks: [],
      making: null,
      failure: null,
    });
    writeFileSync(
      join(editDir, MUSIC_FILES.record),
      JSON.stringify(record(MUSIC_NOT_ASKED_REASON)),
    );
    expect(await readFakeNotAsked(editDir)).toBe(true);
    writeFileSync(
      join(editDir, MUSIC_FILES.record),
      JSON.stringify(record('The client’s style says no music.')),
    );
    expect(await readFakeNotAsked(editDir)).toBe(false);
  });
});

// --- Songs (SG12) ------------------------------------------------------------------------------

/** An edit folder whose brief.json is the fake Brief's draft for a picture attached to the note. */
function editWithBrief(picture: string | null): string {
  const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-song-'));
  dirs.push(editDir);
  const files =
    picture === null
      ? []
      : [
          {
            relPath: `edit/brief/from-you/${picture}`,
            absPath: `/x/${picture}`,
            kind: 'image' as const,
            size: 1,
            mtimeMs: 1,
            attached: true as const,
          },
        ];
  const draft = fakeBriefDraft({ client: 'Acme', name: 'Teaser' }, files, null);
  mkdirSync(editDir, { recursive: true });
  writeFileSync(
    join(editDir, 'brief.json'),
    JSON.stringify({ schema: 1, fingerprint: 'abc', ...draft }),
  );
  return editDir;
}

describe('readFakeSongAsk', () => {
  it('reads the song, a trending one, or nothing from the brief the fake Brief wrote', async () => {
    expect(await readFakeSongAsk(editWithBrief('IMG_4412.PNG'))).toEqual({
      kind: 'song',
      title: 'נתתי לך בית',
      artist: 'Ofek Adanek',
      version: 'sped up',
      link: null,
      fromFile: 'IMG_4412.PNG',
    });
    expect(await readFakeSongAsk(editWithBrief('trending.png'))).toEqual({ kind: 'trending' });
    // "Original audio": no song to get, only a note (RGM1). No picture at all: nothing is asked.
    expect(await readFakeSongAsk(editWithBrief('original.png'))).toEqual({
      kind: 'original',
      by: FAKE_BRIEF_ORIGINAL_BY,
    });
    expect(await readFakeSongAsk(editWithBrief(null))).toBeNull();
  });

  it('asks for nothing when there is no brief or it is not one', async () => {
    const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-song-'));
    dirs.push(editDir);
    expect(await readFakeSongAsk(editDir)).toBeNull();
    writeFileSync(join(editDir, 'brief.json'), '{"nope":true}');
    expect(await readFakeSongAsk(editDir)).toBeNull();
  });
});

describe('fakeSongArgv', () => {
  const song = (fields: Partial<Extract<FakeSongAsk, { kind: 'song' }>>): FakeSongAsk => ({
    kind: 'song',
    title: null,
    artist: null,
    version: null,
    link: null,
    fromFile: null,
    ...fields,
  });

  it('calls the song command as the edit prompt writes it', () => {
    expect(
      fakeSongArgv(
        '/e',
        song({ title: 'T', artist: 'A', version: 'sped up', fromFile: 'IMG_4412.PNG' }),
      ),
    ).toEqual([
      ...['song', '/e', '--title', 'T', '--artist', 'A', '--version', 'sped up'],
      ...['--from', 'screenshot', '--file', 'IMG_4412.PNG', '--by', 'brief'],
    ]);
    // A link is all there is: given alone, without a title and an artist.
    expect(fakeSongArgv('/e', song({ link: 'https://www.instagram.com/reel/x/' }))).toEqual([
      ...['song', '/e', '--link', 'https://www.instagram.com/reel/x/', '--from', 'link'],
      ...['--by', 'brief'],
    ]);
    expect(fakeSongArgv('/e', song({ title: 'T', artist: 'A' }))).toEqual([
      ...['song', '/e', '--title', 'T', '--artist', 'A', '--from', 'name', '--by', 'brief'],
    ]);
    // "Original audio" is noted, not looked up: the account as the brief has it.
    expect(fakeSongArgv('/e', { kind: 'original', by: '@reels.creator' })).toEqual([
      ...['song-note', '/e', '--original', '@reels.creator'],
    ]);
    expect(fakeSongArgv('/e', { kind: 'trending' })).toEqual([
      ...['song', '/e', '--trending', '--from', 'trending', '--by', 'editor'],
      ...['--niche', FAKE_SONG_NICHE],
    ]);
  });

  it('calls it as the revise prompt writes it for a note of a round: --from note --by you (RGM2)', () => {
    expect(
      fakeSongArgv('/e', song({ title: 'Blinding Lights', artist: 'The Weeknd', inRound: true })),
    ).toEqual([
      ...['song', '/e', '--title', 'Blinding Lights', '--artist', 'The Weeknd'],
      ...['--from', 'note', '--by', 'you'],
    ]);
    expect(fakeSongArgv('/e', song({ title: 'Blinding Lights', inRound: true }))).toEqual([
      ...['song', '/e', '--title', 'Blinding Lights', '--from', 'note', '--by', 'you'],
    ]);
    expect(fakeSongArgv('/e', song({ link: 'https://youtu.be/x', inRound: true }))).toEqual([
      ...['song', '/e', '--link', 'https://youtu.be/x', '--from', 'note', '--by', 'you'],
    ]);
    expect(fakeSongArgv('/e', { kind: 'trending', inRound: true })).toEqual([
      ...['song', '/e', '--trending', '--from', 'trending', '--by', 'you'],
      ...['--niche', FAKE_SONG_NICHE],
    ]);
  });
});

describe('songAsksOfRound (RGM2)', () => {
  /** A round file as the engine writes it, with these notes (all at the start of the video). */
  const roundOf = (...texts: string[]): string =>
    renderRoundFile({
      job: 'Teaser',
      client: 'Acme',
      round: 1,
      notes: texts.map((text) => ({ atSec: 0, kind: 'text' as const, text })),
    });
  const named = (title: string, artist: string | null) => ({
    kind: 'song',
    title,
    artist,
    version: null,
    link: null,
    fromFile: null,
    inRound: true,
  });

  it('reads the three notes Another song and Pick a trending one add, word for word', () => {
    expect(songAsksOfRound(roundOf('Use Blinding Lights instead.'))).toEqual([
      named('Blinding Lights', null),
    ]);
    expect(
      songAsksOfRound(roundOf('Use the song from https://www.instagram.com/reel/x/ instead.')),
    ).toEqual([
      {
        kind: 'song',
        title: null,
        artist: null,
        version: null,
        link: 'https://www.instagram.com/reel/x/',
        fromFile: null,
        inRound: true,
      },
    ]);
    expect(songAsksOfRound(roundOf('Use a trending song that fits the cut.'))).toEqual([
      { kind: 'trending', inRound: true },
    ]);
  });

  it('splits a title and an artist at the last " by ", in any case', () => {
    expect(songAsksOfRound(roundOf('Use Blinding Lights by The Weeknd instead.'))).toEqual([
      named('Blinding Lights', 'The Weeknd'),
    ]);
    expect(songAsksOfRound(roundOf('Use Stand by Me BY Ben E. King instead.'))).toEqual([
      named('Stand by Me', 'Ben E. King'),
    ]);
    expect(songAsksOfRound(roundOf('Use נתתי לך בית instead.'))).toEqual([
      named('נתתי לך בית', null),
    ]);
  });

  it('keeps the notes’ order, one ask for each, and skips every other note', () => {
    const asks = songAsksOfRound(
      roundOf(
        'Use a trending song that fits the cut.',
        'Make the title bigger.',
        'Use Skyline by Dana instead.',
        'Use the song from https://youtu.be/x instead.',
        'Use a bigger font instead of this one, please.',
      ),
    );
    // The last is a note about something else that happens to start with "Use": it has no " instead."
    // at its end, so it is not one (the real editor would read it; this fake only knows the three).
    expect(asks.map((ask) => ask.kind)).toEqual(['trending', 'song', 'song']);
    expect(asks[1]).toMatchObject({ title: 'Skyline', artist: 'Dana' });
    expect(asks[2]).toMatchObject({ link: 'https://youtu.be/x' });
  });

  it('reads the line of a note on a job with two formats ("(on 1:1)") and a note that is not at 0:00', () => {
    const text = renderRoundFile({
      job: 'Teaser',
      client: 'Acme',
      round: 1,
      notes: [{ atSec: 7, kind: 'text', text: 'Use Skyline instead.', format: '1x1' }],
      formats: [
        { id: '9x16', label: '9:16' },
        { id: '1x1', label: '1:1' },
      ],
    });
    expect(text).toContain('- 0:07.0 (on 1:1) — Use Skyline instead.');
    expect(songAsksOfRound(text)).toEqual([named('Skyline', null)]);
  });

  it('leaves out the notes already changed in Review, and voice notes', () => {
    const text = renderRoundFile({
      job: 'Teaser',
      client: 'Acme',
      round: 1,
      notes: [
        { atSec: 0, kind: 'text', text: 'Use Skyline instead.' },
        {
          atSec: 1,
          kind: 'voice',
          audioFile: 'edit/review/voice/x.webm',
          transcriptStatus: 'done',
          text: 'Use Other instead.',
        },
      ],
      fixed: [
        { atSec: 0, kind: 'text', text: 'Use a trending song that fits the cut.', said: 'Done.' },
      ],
    });
    expect(text).toContain(`## ${FIXED_NOTES_HEADING}`);
    expect(songAsksOfRound(text)).toEqual([named('Skyline', null)]);
  });

  it('asks for nothing from a round file with no song note, or an empty one', () => {
    expect(songAsksOfRound(roundOf('Make the logo bigger.', 'Cut the first clip.'))).toEqual([]);
    expect(songAsksOfRound('')).toEqual([]);
  });
});

describe('makeFakeMusic with a song', () => {
  const ask: FakeSongAsk = {
    kind: 'song',
    title: 'T',
    artist: 'A',
    version: null,
    link: null,
    fromFile: null,
  };

  it('gets the song first and makes no music of its own when it was got', async () => {
    const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-music-'));
    dirs.push(editDir);
    const run = vi.fn<MusicScriptRunner>(async () => ranOk('song', 6_000));
    expect(await makeFakeMusic({ editDir, lengthMs: 6_000, run, song: ask })).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0].argv[0]).toBe('song');
    // The plan is there before the command runs: the command reads the cut's length from it.
    expect(existsSync(join(editDir, MUSIC_FILES.plan))).toBe(true);
  });

  it('makes v1 as before when the song could not be got', async () => {
    const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-music-'));
    dirs.push(editDir);
    const run = vi.fn<MusicScriptRunner>(async (call) =>
      call.argv[0] === 'song'
        ? ranFailed('failed', 'The downloader didn’t answer', 3)
        : ranOk('v1'),
    );
    expect(await makeFakeMusic({ editDir, lengthMs: 6_000, run, song: ask })).toBe(true);
    expect(run.mock.calls.map((call) => call[0].argv[0])).toEqual(['song', 'make']);
  });

  it('stops where it is when the run was cancelled', async () => {
    const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-music-'));
    dirs.push(editDir);
    const controller = new AbortController();
    const run = vi.fn<MusicScriptRunner>(async () => {
      controller.abort();
      return { kind: 'stopped', reason: 'cancel' };
    });
    expect(
      await makeFakeMusic({ editDir, lengthMs: 6_000, run, song: ask, signal: controller.signal }),
    ).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('asks for no song when the brief asks for none (the same call as before Songs)', async () => {
    const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-music-'));
    dirs.push(editDir);
    const run = vi.fn<MusicScriptRunner>(async () => ranOk('v1'));
    await makeFakeMusic({ editDir, lengthMs: 6_000, run, song: null });
    expect(run.mock.calls.map((call) => call[0].argv[0])).toEqual(['make']);
  });
});

describe('makeFakeMusic with “Original audio” (RGM1)', () => {
  const original: FakeSongAsk = { kind: 'original', by: '@reels.creator' };

  it('makes v1, then notes it with song-note, and never runs the song command', async () => {
    const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-music-'));
    dirs.push(editDir);
    const run = vi.fn<MusicScriptRunner>(async () => ranOk('v1'));
    expect(await makeFakeMusic({ editDir, lengthMs: 6_000, run, song: original })).toBe(true);
    expect(run.mock.calls.map((call) => call[0].argv)).toEqual([
      ['make', editDir, '--by', 'edit', '--fake'],
      ['song-note', editDir, '--original', '@reels.creator'],
    ]);
    // The plan is there before the make, as for any music.
    expect(existsSync(join(editDir, MUSIC_FILES.plan))).toBe(true);
  });

  it('notes it also when the make failed, and says false as before', async () => {
    const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-music-'));
    dirs.push(editDir);
    const run = vi.fn<MusicScriptRunner>(async (call) =>
      call.argv[0] === 'make' ? ranFailed('failed', 'ffmpeg is not installed.', 1) : ranOk('none'),
    );
    expect(await makeFakeMusic({ editDir, lengthMs: 6_000, run, song: original })).toBe(false);
    expect(run.mock.calls.map((call) => call[0].argv[0])).toEqual(['make', 'song-note']);
  });

  it('notes nothing when the run was cancelled', async () => {
    const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-music-'));
    dirs.push(editDir);
    const controller = new AbortController();
    const run = vi.fn<MusicScriptRunner>(async () => {
      controller.abort();
      return { kind: 'stopped', reason: 'cancel' };
    });
    expect(
      await makeFakeMusic({
        editDir,
        lengthMs: 6_000,
        run,
        song: original,
        signal: controller.signal,
      }),
    ).toBe(false);
    expect(run.mock.calls.map((call) => call[0].argv[0])).toEqual(['make']);
  });

  it.skipIf(!haveFfmpeg)(
    'leaves music.json with v1 picked and the original_audio failure next to it (the real script)',
    async () => {
      const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-music-'));
      dirs.push(editDir);
      expect(await makeFakeMusic({ editDir, lengthMs: 6_000, song: original })).toBe(true);
      const record = musicRecordSchema.parse(
        JSON.parse(readFileSync(join(editDir, MUSIC_FILES.record), 'utf8')),
      );
      expect(record).toMatchObject({
        source: 'made',
        picked: 'v1',
        song: null,
        songFailure: { asked: 'Original audio · @reels.creator', code: 'original_audio' },
      });
      expect(record.versions.map((version) => version.id)).toEqual(['v1']);
      expect(existsSync(join(editDir, MUSIC_FILES.preview))).toBe(true);
    },
  );
});

describe('getFakeRoundSongs (RGM2)', () => {
  const asks: FakeSongAsk[] = [
    {
      kind: 'song',
      title: 'T',
      artist: 'A',
      version: null,
      link: null,
      fromFile: null,
      inRound: true,
    },
    { kind: 'trending', inRound: true },
  ];

  it('writes the plan for the cut first, then one song call for each ask, in order', async () => {
    const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-round-'));
    dirs.push(editDir);
    const plans: (number | null)[] = [];
    const run = vi.fn<MusicScriptRunner>(async () => {
      const text = readFileSync(join(editDir, MUSIC_FILES.plan), 'utf8');
      plans.push(JSON.parse(text).lengthMs);
      return ranOk('song', 6_000);
    });
    const signal = new AbortController().signal;

    expect(await getFakeRoundSongs({ editDir, lengthMs: 6_400, asks, signal, run })).toBe(2);

    expect(run.mock.calls.map((call) => call[0])).toEqual([
      { argv: fakeSongArgv(editDir, asks[0] as FakeSongAsk), signal, timeoutMs: 120_000 },
      { argv: fakeSongArgv(editDir, asks[1] as FakeSongAsk), signal, timeoutMs: 120_000 },
    ]);
    expect(plans).toEqual([6_400, 6_400]);
  });

  it('keeps a plan that is for this cut, and makes a new one for another length', async () => {
    const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-round-'));
    dirs.push(editDir);
    mkdirSync(join(editDir, MUSIC_FILES.dir), { recursive: true });
    const mine = { ...fakeMusicPlan(6_000), describe: 'The edit run’s own plan.' };
    writeFileSync(join(editDir, MUSIC_FILES.plan), JSON.stringify(mine));
    const run = vi.fn<MusicScriptRunner>(async () => ranOk('song', 6_000));

    await getFakeRoundSongs({ editDir, lengthMs: 6_000, asks, run });
    expect(JSON.parse(readFileSync(join(editDir, MUSIC_FILES.plan), 'utf8'))).toEqual(mine);

    await getFakeRoundSongs({ editDir, lengthMs: 9_000, asks, run });
    expect(JSON.parse(readFileSync(join(editDir, MUSIC_FILES.plan), 'utf8'))).toEqual(
      fakeMusicPlan(9_000),
    );
  });

  it('goes on to the next ask when a song cannot be got: the script leaves the music as it was', async () => {
    const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-round-'));
    dirs.push(editDir);
    const run = vi.fn<MusicScriptRunner>(async (call) =>
      call.argv.includes('--trending')
        ? ranOk('song', 6_000)
        : ranFailed('failed', 'The downloader didn’t answer', 3),
    );
    expect(await getFakeRoundSongs({ editDir, lengthMs: 6_000, asks, run })).toBe(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does nothing for no asks, and nothing for “Original audio” (it asks for no song)', async () => {
    const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-round-'));
    dirs.push(editDir);
    const run = vi.fn<MusicScriptRunner>(async () => ranOk('song', 6_000));
    expect(await getFakeRoundSongs({ editDir, lengthMs: 6_000, asks: [], run })).toBe(0);
    expect(
      await getFakeRoundSongs({
        editDir,
        lengthMs: 6_000,
        asks: [{ kind: 'original', by: '@x' }],
        run,
      }),
    ).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(join(editDir, MUSIC_FILES.plan))).toBe(false);
  });

  it('stops where it is when the run was cancelled', async () => {
    const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-round-'));
    dirs.push(editDir);
    const controller = new AbortController();
    const run = vi.fn<MusicScriptRunner>(async () => {
      controller.abort();
      return { kind: 'stopped', reason: 'cancel' };
    });
    expect(
      await getFakeRoundSongs({ editDir, lengthMs: 6_000, asks, run, signal: controller.signal }),
    ).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.skipIf(!haveFfmpeg)(
    'puts the song in music.json as asked by you from a note, then from trending, and keeps it when the next cannot be got (the real script, on the stand-ins)',
    async () => {
      const editDir = mkdtempSync(join(tmpdir(), 'studio-fake-round-'));
      dirs.push(editDir);
      // The edit run's music is there first, as it is in a round.
      expect(await makeFakeMusic({ editDir, lengthMs: 6_000 })).toBe(true);
      const record = () =>
        musicRecordSchema.parse(
          JSON.parse(readFileSync(join(editDir, MUSIC_FILES.record), 'utf8')),
        );
      expect(record()).toMatchObject({ source: 'made', picked: 'v1' });

      expect(
        await getFakeRoundSongs({
          editDir,
          lengthMs: 6_000,
          asks: songAsksOfRound('- 0:00.0 — Use Blinding Lights by The Weeknd instead.\n'),
        }),
      ).toBe(1);
      expect(record()).toMatchObject({
        source: 'song',
        picked: 'song',
        song: {
          title: 'Blinding Lights',
          artist: 'The Weeknd',
          asked: { from: 'note', by: 'you', file: null },
        },
      });
      expect(existsSync(join(editDir, 'music', 'song.mp3'))).toBe(true);

      expect(
        await getFakeRoundSongs({
          editDir,
          lengthMs: 6_000,
          asks: songAsksOfRound('- 0:00.0 — Use a trending song that fits the cut.\n'),
        }),
      ).toBe(1);
      expect(record().song).toMatchObject({
        title: 'Skyline Run',
        artist: 'Dana Kahn',
        asked: { from: 'trending', by: 'you', file: null },
        trending: { niche: '#fpv' },
      });

      // A song the downloader cannot get: the failure is recorded and the song that plays stays.
      const playing = readFileSync(join(editDir, MUSIC_FILES.preview));
      expect(
        await getFakeRoundSongs({
          editDir,
          lengthMs: 6_000,
          asks: songAsksOfRound('- 0:00.0 — Use Fail Song instead.\n'),
        }),
      ).toBe(0);
      expect(record()).toMatchObject({
        picked: 'song',
        song: { title: 'Skyline Run' },
        songFailure: { code: 'unavailable' },
      });
      expect(readFileSync(join(editDir, MUSIC_FILES.preview)).equals(playing)).toBe(true);
    },
    60_000,
  );
});

describe('fakeSongEnv', () => {
  it('points the script’s test hooks at the stand-ins, which are there', () => {
    const env = fakeSongEnv({ PATH: '/bin' });
    expect(env.PATH).toBe('/bin');
    for (const [name, file] of [
      ['MUSIC_GET_SONG', 'fake-e2e-songs.mjs'],
      ['MUSIC_TRENDING_PICK', 'fake-e2e-songs.mjs'],
      ['MUSIC_HYPERFRAMES', 'fake-e2e-hyperframes.mjs'],
    ] as const) {
      expect(env[name]?.endsWith(`/testdata/${file}`), name).toBe(true);
      expect(existsSync(env[name] ?? ''), name).toBe(true);
    }
  });

  it('keeps the hooks the environment already names', () => {
    const env = fakeSongEnv({ MUSIC_GET_SONG: '/mine/get.mjs', MUSIC_TRENDING_PICK: '' });
    expect(env.MUSIC_GET_SONG).toBe('/mine/get.mjs');
    expect(env.MUSIC_TRENDING_PICK?.endsWith('fake-e2e-songs.mjs')).toBe(true);
  });
});
