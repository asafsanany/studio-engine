import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProgressSignal } from './progress-reducer.js';
import { checkPassOf, diffSnapshots, EditWatcher, scanEditDir } from './progress-watcher.js';

// The edit/ poller against a real folder: what it lists, what it leaves out, the order it reports
// in, and that it stops.

let root: string;
let editDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-progress-'));
  editDir = join(root, 'edit');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes `edit/<path>`; `at` sets its mtime (seconds since the epoch). */
function put(path: string, content = 'x', at?: number): void {
  const full = join(editDir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  if (at !== undefined) utimesSync(full, at, at);
}

function paths(signals: readonly ProgressSignal[]): string[] {
  return signals.map((s) => (s.type === 'file' ? `${s.change} ${s.path}` : JSON.stringify(s)));
}

/** A watcher that collects what it reports, and that tests drive with `poll()`. */
function watcher(baseline: boolean) {
  const batches: ProgressSignal[][] = [];
  const errors: unknown[] = [];
  const w = new EditWatcher({
    editDir,
    baseline,
    intervalMs: 60_000,
    onSignals: (signals) => batches.push(signals),
    onError: (err) => errors.push(err),
  });
  return { w, batches, errors };
}

describe('scanEditDir', () => {
  it('finds nothing, without an error, when edit/ does not exist yet', async () => {
    expect((await scanEditDir(editDir)).size).toBe(0);
  });

  it('lists where progress shows, and nothing else', async () => {
    put('takes_packed.md');
    put('project.md');
    put('transcripts/clip-01.json');
    put('transcripts/nested/x.json');
    put('verify/p_0.9.jpg');
    put('animations/words_out.json');
    put('animations/_shared/vendor/gsap.min.js');
    put('animations/slot_1/index.html');
    put('animations/slot_1/render.mov');
    put('animations/slot_1/vendor/gsap.min.js');
    put('animations/slot_1/work-af46/frame_0001.png');
    put('clips_graded/seg_00.mp4');
    // Dotfiles anywhere: HyperFrames' state, the fake runner's partial files, macOS litter.
    put('.final.mp4.partial');
    put('.DS_Store');
    put('transcripts/.clip-02.json.tmp');
    put('animations/slot_1/.hyperframes/video-state.json');
    put('animations/slot_1/.render.hf-transaction-nVHRZC/frame.png');

    const listed = [...(await scanEditDir(editDir)).keys()].sort();

    expect(listed).toEqual([
      'animations/',
      'animations/_shared/',
      'animations/slot_1/',
      'animations/slot_1/index.html',
      'animations/slot_1/render.mov',
      'animations/words_out.json',
      'clips_graded/',
      'project.md',
      'takes_packed.md',
      'transcripts/',
      'transcripts/clip-01.json',
      'verify/',
      'verify/p_0.9.jpg',
    ]);
  });

  // W2: a run that ends in Review leaves a live composition in edit/preview/. Its root file and
  // the cut it plays are what progress reads; a real composition can hold hundreds of files
  // (sub-compositions, fonts, a .hyperframes/ folder of snapshots), which are never listed.
  it('lists the files at the top of preview/, and nothing below or beside them', async () => {
    put('preview/index.html');
    put('preview/cut.mp4');
    put('preview/music.mp3');
    put('preview/compositions/badge.html');
    put('preview/compositions/captions/words.json');
    put('preview/assets/fonts/Heebo.woff2');
    put('preview/vendor/gsap.min.js');
    put('preview/.hyperframes/snapshots/frame_0001.png');
    put('preview/.DS_Store');
    // A composition being swapped in: dot-named, so it is invisible until it is renamed.
    put('.preview-7c1d.tmp/index.html');

    const listed = [...(await scanEditDir(editDir)).keys()].sort();

    expect(listed).toEqual([
      'preview/',
      'preview/cut.mp4',
      'preview/index.html',
      'preview/music.mp3',
    ]);
    expect(listed).not.toContain('preview/compositions/badge.html');
    expect(listed.some((path) => path.includes('.hyperframes'))).toBe(false);
  });

  it('lists preview.mp4 and preview/ side by side', async () => {
    put('preview.mp4');
    put('preview/index.html');
    const listed = [...(await scanEditDir(editDir)).keys()].sort();
    expect(listed).toEqual(['preview.mp4', 'preview/', 'preview/index.html']);
  });

  it('finds no preview/ without an error when it does not exist', async () => {
    put('project.md');
    expect([...(await scanEditDir(editDir)).keys()]).toEqual(['project.md']);
  });
});

describe('diffSnapshots', () => {
  it('reports removals first, then additions and changes, oldest first', async () => {
    put('project.md', 'a', 1_000);
    put('takes_packed.md', 'a', 2_000);
    put('verify/src_full.png', 'a', 3_000);
    const before = await scanEditDir(editDir);

    unlinkSync(join(editDir, 'verify', 'src_full.png'));
    put('project.md', 'longer', 5_000);
    put('edl.json', '{}', 4_000);
    const after = await scanEditDir(editDir);

    expect(paths(diffSnapshots(before, after))).toEqual([
      'unlink verify/src_full.png',
      'add edl.json',
      'change project.md',
    ]);
  });

  it('sees no change in a folder whose content changed', async () => {
    put('verify/a.jpg');
    const before = await scanEditDir(editDir);
    put('verify/b.jpg');
    expect(paths(diffSnapshots(before, await scanEditDir(editDir)))).toEqual(['add verify/b.jpg']);
  });
});

describe('EditWatcher', () => {
  it('for a fresh run, leaves what is already there out and reports what the run does', async () => {
    put('project.md', 'left over', 1_000);
    put('final.mp4', 'left over', 1_000);
    const { w, batches } = watcher(true);

    await w.start();
    expect(batches).toEqual([]);

    put('transcripts/clip-01.json');
    put('project.md', 'rewritten by this run');
    await w.poll();
    await w.stop();

    expect(batches.map(paths)).toEqual([
      ['add transcripts/', 'add transcripts/clip-01.json', 'change project.md'],
    ]);
  });

  it('for a resumed run, reports what is there oldest first, so it replays in order', async () => {
    // project.md written before the transcripts were packed (as in E1's blocked run), then the
    // run carried on: alphabetical order would say Plan, the real order does not.
    put('project.md', 'session note', 1_000);
    put('transcripts/clip-01.json', '{}', 2_000);
    put('takes_packed.md', 'packed', 3_000);
    const { w, batches } = watcher(false);

    await w.start();
    await w.stop();

    expect(batches.map(paths)).toEqual([
      [
        'add project.md',
        'add transcripts/clip-01.json',
        'add takes_packed.md',
        // the folder was made just now, by this test
        'add transcripts/',
      ],
    ]);
  });

  it('reports the composition of a run that ends in Review as it is written, files only', async () => {
    const { w, batches } = watcher(true);
    await w.start();

    put('preview/cut.mp4');
    put('preview/compositions/badge.html');
    await w.poll();
    put('preview/index.html');
    put('preview/assets/fonts/Heebo.woff2');
    await w.poll();
    put('preview/index.html', 'edited later, longer');
    await w.poll();
    await w.stop();

    expect(batches.map(paths)).toEqual([
      ['add preview/', 'add preview/cut.mp4'],
      ['add preview/index.html'],
      ['change preview/index.html'],
    ]);
  });

  it('reads edl.json and says how many overlays it places', async () => {
    const { w, batches } = watcher(true);
    await w.start();

    put('edl.json', JSON.stringify({ ranges: [], overlays: [{ file: 'a' }, { file: 'b' }] }));
    await w.poll();
    await w.stop();

    expect(batches.map(paths)).toEqual([['add edl.json', '{"type":"edl","overlays":2}']]);
  });

  it('reads an edl.json caught half-written again at the next look', async () => {
    const { w, batches } = watcher(true);
    await w.start();

    put('edl.json', '{"ranges": [');
    await w.poll();
    put('edl.json', '{"ranges": [], "overlays": [{}]}');
    await w.poll();
    await w.stop();

    expect(batches.map(paths)).toEqual([
      ['add edl.json'],
      ['add edl.json', '{"type":"edl","overlays":1}'],
    ]);
  });

  it('reports nothing when nothing changed', async () => {
    put('project.md');
    const { w, batches } = watcher(false);
    await w.start();
    await w.poll();
    await w.poll();
    await w.stop();
    expect(batches).toHaveLength(1);
  });

  it('looks again on its own, every interval, until stopped', async () => {
    const batches: ProgressSignal[][] = [];
    const w = new EditWatcher({
      editDir,
      baseline: true,
      intervalMs: 10,
      onSignals: (signals) => batches.push(signals),
    });
    await w.start();
    put('takes_packed.md');
    const deadline = Date.now() + 5_000;
    while (batches.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await w.stop();
    expect(batches.map(paths)).toEqual([['add takes_packed.md']]);

    put('final.mp4');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(batches).toHaveLength(1);
  });

  it('takes one last look when asked to as it stops, and none after', async () => {
    const { w, batches } = watcher(true);
    await w.start();
    put('final.mp4');

    await w.stop({ finalLook: true });
    await w.stop({ finalLook: true });
    await w.poll();

    expect(batches.map(paths)).toEqual([['add final.mp4']]);
  });

  it('never looks when it was stopped before it started', async () => {
    const { w, batches } = watcher(false);
    put('takes_packed.md');
    await w.stop({ finalLook: true });
    await w.start();
    await w.poll();
    expect(batches).toEqual([]);
  });

  it('can be stopped before its first look ends, and then never looks again', async () => {
    const { w, batches } = watcher(false);
    put('takes_packed.md');
    const started = w.start();
    await w.stop();
    await started;
    put('final.mp4');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(batches.map(paths)).toEqual([['add takes_packed.md']]);
  });

  it('reports a look that fails and carries on', async () => {
    // edit/ is a file: listing it fails with ENOTDIR, which counts as "not there yet".
    writeFileSync(editDir, 'not a folder');
    const { w, batches, errors } = watcher(false);
    await w.start();
    rmSync(editDir);
    put('takes_packed.md');
    await w.poll();
    await w.stop();
    expect(errors).toEqual([]);
    expect(batches.map(paths)).toEqual([['add takes_packed.md']]);
  });

  it('passes a listener error to onError instead of throwing', async () => {
    const errors: unknown[] = [];
    const w = new EditWatcher({
      editDir,
      baseline: false,
      onSignals: () => {
        throw new Error('listener broke');
      },
      onError: (err) => errors.push(err),
    });
    put('project.md');
    await expect(w.start()).resolves.toBeUndefined();
    await w.stop();
    expect(errors).toHaveLength(1);
  });
});

// CVP-138: a replay has no stored `pass n/3`, so its first look ends with an estimate made from
// the times of the preview and of the frames in verify/.
describe('the pass a replay ends with', () => {
  /** The first look at the sources, a preview and the frames of its check, then more of both. */
  function secondPassOfCheck(): void {
    put('takes_packed.md', 'packed', 100);
    put('project.md', 'plan', 110);
    put('edl.json', '{}', 120);
    put('verify/src_full.png', 'filmstrip', 130);
    put('verify/p_0.9.jpg', 'frame', 700);
    put('verify/p_3.6.jpg', 'frame', 702);
    put('preview.mp4', 'second render', 1_200);
    put('verify/g_0.9.jpg', 'frame', 1_201);
  }

  it('is checkPassOf: 1 with no preview or no check, 2 once an earlier check was followed by a render', async () => {
    expect(checkPassOf(await scanEditDir(editDir))).toBe(1);
    secondPassOfCheck();
    expect(checkPassOf(await scanEditDir(editDir))).toBe(2);
  });

  it('ends the first look of a resumed run with a pass signal', async () => {
    secondPassOfCheck();
    const { w, batches } = watcher(false);
    await w.start();
    await w.stop();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.at(-1)).toEqual({ type: 'pass', n: 2 });
    expect(batches[0]?.filter((signal) => signal.type === 'pass')).toHaveLength(1);
  });

  it('says nothing for a first check', async () => {
    put('takes_packed.md', 'packed', 100);
    put('verify/src_full.png', 'filmstrip', 130);
    put('preview.mp4', 'first render', 700);
    put('verify/p_0.9.jpg', 'frame', 701);
    const { w, batches } = watcher(false);
    await w.start();
    await w.stop();

    expect(batches.flat().some((signal) => signal.type === 'pass')).toBe(false);
  });

  it('says nothing for a fresh run, which does not replay, or at later looks', async () => {
    secondPassOfCheck();
    const fresh = watcher(true);
    await fresh.w.start();
    put('verify/g_9.jpg', 'frame', 1_300);
    await fresh.w.poll();
    await fresh.w.stop();
    expect(fresh.batches.flat().some((signal) => signal.type === 'pass')).toBe(false);

    const resumed = watcher(false);
    await resumed.w.start();
    put('verify/g_10.jpg', 'frame', 1_400);
    await resumed.w.poll();
    await resumed.w.stop();
    expect(resumed.batches.flat().filter((signal) => signal.type === 'pass')).toHaveLength(1);
  });
});
