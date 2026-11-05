import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUSIC_FILES, musicRecordSchema } from '@studio/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveFfmpeg } from '../pipeline/fake-media.js';
import { fakeMusicPlan } from './fake-music.js';
import { MUSIC_SCRIPT } from './music-assets.js';

// The stand-ins the e2e engine points the song command at (support/engine.ts, `songs`): a getter that
// makes a 40 s track with a drop at 0:20, a fixed trending pick and a beat finder that answers for that
// track. The real script runs against them in a temp job folder, as the fake runner calls it, so the
// e2e specs rest on stand-ins that work. Nothing here touches the network or the real inbox.

const ffmpeg = await resolveFfmpeg('ffmpeg');
const haveFfmpeg = ffmpeg !== null;
if (!haveFfmpeg) console.warn('e2e-standins.test.ts: ffmpeg not found; skipping');

const TESTDATA = fileURLToPath(new URL('./testdata/', import.meta.url));
const STANDINS = {
  MUSIC_GET_SONG: join(TESTDATA, 'fake-e2e-songs.mjs'),
  MUSIC_TRENDING_PICK: join(TESTDATA, 'fake-e2e-songs.mjs'),
  MUSIC_HYPERFRAMES: join(TESTDATA, 'fake-e2e-hyperframes.mjs'),
};

const root = mkdtempSync(join(tmpdir(), 'studio-e2e-standins-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
/** A job's edit folder with the plan a 6 s cut gets, as the fake runner leaves it. */
function editFolder(): string {
  counter += 1;
  const editDir = join(root, `job-${counter}`, 'Acme', 'Teaser', 'edit');
  mkdirSync(join(editDir, 'music'), { recursive: true });
  writeFileSync(join(editDir, MUSIC_FILES.plan), JSON.stringify(fakeMusicPlan(6_000)));
  return editDir;
}

function song(editDir: string, args: string[]) {
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const ran = spawnSync(process.execPath, [MUSIC_SCRIPT, 'song', editDir, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: home, ...STANDINS },
    timeout: 60_000,
  });
  return { status: ran.status, line: JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}') };
}

const record = (editDir: string) =>
  musicRecordSchema.parse(JSON.parse(readFileSync(join(editDir, MUSIC_FILES.record), 'utf8')));

// A song call runs ffmpeg 6 times: under 1 s alone, over vitest's 5 s default when a full run keeps every core busy.
describe.runIf(haveFfmpeg)(
  'the e2e stand-ins for the song getter, the picker and the beat finder',
  { timeout: 60_000 },
  () => {
    it('get the song asked for: the part starts on the bar line before the drop at 0:20', () => {
      const editDir = editFolder();
      const { status, line } = song(editDir, [
        ...['--title', 'נתתי לך בית', '--artist', 'Ofek Adanek', '--version', 'sped up'],
        ...['--from', 'screenshot', '--file', 'IMG_4412.PNG', '--by', 'brief'],
      ]);
      expect(status).toBe(0);
      expect(line).toMatchObject({
        ok: true,
        part: { startMs: 19_100, endMs: 25_100, how: 'measured' },
        dropMs: 900,
        fullMs: 40_000,
        instagramLine:
          'In Instagram tap Add audio, pick נתתי לך בית by Ofek Adanek and slide it to start at 0:19.',
      });
      expect(record(editDir)).toMatchObject({ source: 'song', picked: 'song', songFailure: null });
      expect(existsSync(join(editDir, MUSIC_FILES.preview))).toBe(true);
    });

    it('pick a trending song with its numbers', () => {
      const editDir = editFolder();
      const { status } = song(editDir, ['--trending', '--from', 'trending', '--by', 'editor']);
      expect(status).toBe(0);
      expect(record(editDir).song).toMatchObject({
        title: 'Skyline Run',
        artist: 'Dana Kahn',
        asked: { from: 'trending', by: 'editor' },
        trending: { reels: 18_400, isTrending: true, nicheTop20: 3, niche: '#fpv' },
      });
    });

    it('cannot get a song whose title starts with Fail: unavailable, and the record says so', () => {
      const editDir = editFolder();
      const { status, line } = song(editDir, [
        ...['--title', 'Fail Song', '--artist', 'Nobody', '--from', 'screenshot'],
        ...['--file', 'fail.png', '--by', 'brief'],
      ]);
      expect(status).toBe(3);
      expect(line).toMatchObject({ ok: false, code: 'unavailable' });
      expect(record(editDir).songFailure).toMatchObject({ code: 'unavailable' });
    });
  },
);
