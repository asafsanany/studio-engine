import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixDirPath, snapshotFileName } from './quick-fix-files.js';
import {
  BIG_FILE_BYTES,
  collectCompareStills,
  type LintPreview,
  listingChanges,
  listJobFolder,
  verifyQuickFix,
} from './verify-quick-fix.js';

// The engine's checks after a quick fix run, on a job folder in a temp dir: the "run" is a function
// that changes files, taken between the two listings.

const FIX_ID = 'fix-1';
const FIX_DIR = fixDirPath(FIX_ID);
const AT = 12.4;

let jobDir: string;

beforeEach(() => {
  jobDir = mkdtempSync(join(tmpdir(), 'studio-verify-quick-fix-'));
  put('edit/preview/index.html', '<html>title</html>');
  put('edit/preview/compositions/captions.html', '<template>captions</template>');
  put('edit/preview/cut.mp4', 'the cut');
  put('edit/preview/assets/music.mp3', 'the music');
  put('edit/preview/vendor/gsap.min.js', 'gsap');
  put('edit/project.md', '# Job\n');
  put('edit/fonts/Heebo-Bold.ttf', 'font');
  put('clip-1.mp4', 'footage');
});

afterEach(() => {
  rmSync(jobDir, { recursive: true, force: true });
});

function put(path: string, content: string | Uint8Array): void {
  const full = join(jobDir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Moves a file's modified time on, so a rewrite with the same size still reads as changed. */
function touch(path: string): void {
  const later = new Date(Date.now() + 5_000);
  utimesSync(join(jobDir, path), later, later);
}

const LINT_OK: LintPreview = async () => ({ ok: true });

/** Lists the job, lets `run` change it, and verifies. */
async function verify(
  run: () => void,
  options: { lint?: LintPreview; ignore?: (path: string) => boolean } = {},
) {
  const before = await listJobFolder(jobDir);
  run();
  return verifyQuickFix({
    jobDir,
    fixId: FIX_ID,
    atSec: AT,
    before,
    lint: options.lint ?? LINT_OK,
    ...(options.ignore === undefined ? {} : { ignore: options.ignore }),
  });
}

/** The change a good fix makes: the captions file, then its answer. */
function goodFix(said = 'The captions are Heebo Bold now.'): void {
  put('edit/preview/compositions/captions.html', '<template>captions, in Heebo</template>');
  put(`${FIX_DIR}/reply.json`, JSON.stringify({ done: true, said }));
}

describe('a good fix', () => {
  it('is fixed with the run’s sentence', async () => {
    expect(await verify(() => goodFix())).toEqual({
      status: 'fixed',
      said: 'The captions are Heebo Bold now.',
      hasCompare: false,
    });
  });

  it('may also change project.md, add a font and write its own folder', async () => {
    const outcome = await verify(() => {
      goodFix();
      put('edit/project.md', '# Job\n\n## Round 2 · fixed in Review\n- Heebo.\n');
      put('edit/preview/assets/fonts/Heebo-Bold.ttf', 'font');
      put(`${FIX_DIR}/notes.txt`, 'its own folder');
    });
    expect(outcome.status).toBe('fixed');
  });

  it('counts a rewrite with the same size as a change (the modified time moved)', async () => {
    const outcome = await verify(() => {
      // "captions" in capitals: as long as before. Only the modified time says it changed.
      put('edit/preview/compositions/captions.html', '<template>CAPTIONS</template>');
      put(`${FIX_DIR}/reply.json`, JSON.stringify({ done: true, said: 'Done.' }));
      touch('edit/preview/compositions/captions.html');
    });
    expect(outcome.status).toBe('fixed');
  });

  it('trims a very long sentence rather than failing it', async () => {
    const outcome = await verify(() => goodFix('Heebo. '.repeat(200)));
    expect(outcome.status).toBe('fixed');
    expect(outcome.status === 'fixed' && outcome.said.length).toBeLessThanOrEqual(300);
  });

  it('ignores what the engine writes meanwhile: voice notes, the phone video, its poster, the export, temporary files, the tool’s state', async () => {
    const outcome = await verify(() => {
      goodFix();
      put('edit/review/voice/note-9.webm', 'audio');
      put('edit/preview-lite.mp4', 'small video');
      put('edit/poster.jpg', 'poster');
      put('edit/review-export.mp4', 'exported video');
      // Export MP4 of an extra format (C65), and its partial file while it renders.
      put('edit/review-export-1x1.mp4', 'exported square video');
      put('edit/.review-export-1x1.partial.mp4', 'half');
      put('edit/.preview-lite.partial.tmp', 'half');
      put('edit/review/.round-3.md.tmp', 'half');
      put('edit/preview/.hyperframes/video-state.json', '{}');
      put('.DS_Store', 'x');
    });
    expect(outcome.status).toBe('fixed');
  });

  it('leaves out the paths the caller says are not the run’s', async () => {
    const outcome = await verify(
      () => {
        goodFix();
        put('stub-claude.call.json', '{}');
      },
      { ignore: (path) => path.startsWith('stub-claude') },
    );
    expect(outcome.status).toBe('fixed');
  });
});

describe('the reply', () => {
  it('is missing: failed', async () => {
    expect(
      await verify(() => put('edit/preview/compositions/captions.html', '<template>x</template>')),
    ).toMatchObject({ status: 'failed', why: 'it finished without writing its answer' });
  });

  it.each([
    ['not JSON', 'done'],
    ['an empty sentence', JSON.stringify({ done: true, said: '  ' })],
    ['no sentence', JSON.stringify({ done: true })],
    ['no reason', JSON.stringify({ done: false })],
    ['no done', JSON.stringify({ said: 'Fixed.' })],
    ['a done that is not a boolean', JSON.stringify({ done: 'yes', said: 'Fixed.' })],
  ])('is %s: failed', async (_name, reply) => {
    const outcome = await verify(() => {
      put('edit/preview/compositions/captions.html', '<template>x</template>');
      put(`${FIX_DIR}/reply.json`, reply);
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.why).toMatch(/^its answer was not/);
  });

  it('says done: false: escalated with its reason, even though something changed', async () => {
    const outcome = await verify(() => {
      put('edit/preview/compositions/captions.html', '<template>x</template>');
      put(
        `${FIX_DIR}/reply.json`,
        JSON.stringify({ done: false, why: 'the sign is part of the footage.' }),
      );
    });
    expect(outcome).toEqual({
      status: 'escalated',
      why: 'the sign is part of the footage',
      hasCompare: false,
    });
  });
});

describe('nothing changed', () => {
  it('done: true and no file changed: escalated', async () => {
    expect(
      await verify(() =>
        put(`${FIX_DIR}/reply.json`, JSON.stringify({ done: true, said: 'Done.' })),
      ),
    ).toEqual({ status: 'escalated', why: 'nothing changed', hasCompare: false });
  });

  it.each([
    ['only a font was added', () => put('edit/preview/assets/fonts/Heebo-Bold.ttf', 'font')],
    ['only project.md changed', () => put('edit/project.md', '# Job\n\n- a line\n')],
    ['only the tool’s state changed', () => put('edit/preview/.hyperframes/state.json', '{}')],
    ['only an image was added', () => put('edit/preview/assets/logo.png', 'png')],
  ])('%s: escalated', async (_name, change) => {
    const outcome = await verify(() => {
      change();
      put(`${FIX_DIR}/reply.json`, JSON.stringify({ done: true, said: 'Done.' }));
    });
    expect(outcome).toMatchObject({ status: 'escalated', why: 'nothing changed' });
  });

  it.each([
    ['a stylesheet', 'edit/preview/style.css'],
    ['a script', 'edit/preview/compositions/captions.js'],
    ['a data file', 'edit/preview/data.json'],
    ['a sub-composition', 'edit/preview/compositions/new-title.html'],
    ['a vector graphic', 'edit/preview/assets/logo.svg'],
  ])('%s that is new counts as the composition', async (_name, path) => {
    const outcome = await verify(() => {
      put(path, 'x');
      put(`${FIX_DIR}/reply.json`, JSON.stringify({ done: true, said: 'Done.' }));
    });
    expect(outcome.status).toBe('fixed');
  });
});

describe('the media', () => {
  it('cut.mp4 changed: failed', async () => {
    const outcome = await verify(() => {
      goodFix();
      put('edit/preview/cut.mp4', 'another cut');
    });
    expect(outcome).toMatchObject({
      status: 'failed',
      why: 'it changed cut.mp4, which it must not touch',
    });
  });

  it('cut.mp4 with only its modified time moved: failed', async () => {
    const outcome = await verify(() => {
      goodFix();
      touch('edit/preview/cut.mp4');
    });
    expect(outcome).toMatchObject({
      status: 'failed',
      why: 'it changed cut.mp4, which it must not touch',
    });
  });

  it('cut.mp4 removed: failed', async () => {
    const outcome = await verify(() => {
      goodFix();
      rmSync(join(jobDir, 'edit/preview/cut.mp4'));
    });
    expect(outcome).toMatchObject({
      status: 'failed',
      why: 'it removed cut.mp4, which it must not touch',
    });
  });

  it('the music changed or a video added to the preview: failed', async () => {
    expect(
      await verify(() => {
        goodFix();
        put('edit/preview/assets/music.mp3', 'other music');
      }),
    ).toMatchObject({
      status: 'failed',
      why: 'it changed assets/music.mp3, which it must not touch',
    });
    expect(
      await verify(() => {
        goodFix();
        put('edit/preview/clips/new.mov', 'a video');
      }),
    ).toMatchObject({ status: 'failed', why: 'it added clips/new.mov, which it must not touch' });
  });

  it('a file over 5 MB changed, whatever its name: failed; a small file of any other kind is fine', async () => {
    const big = join(jobDir, 'edit/preview/assets/bg.dat');
    mkdirSync(dirname(big), { recursive: true });
    writeFileSync(big, '');
    truncateSync(big, BIG_FILE_BYTES + 1);
    expect(
      await verify(() => {
        goodFix();
        truncateSync(big, BIG_FILE_BYTES + 2);
      }),
    ).toMatchObject({ status: 'failed', why: 'it changed assets/bg.dat, which it must not touch' });
    expect(
      await verify(() => {
        goodFix();
        put('edit/preview/assets/small.dat', 'small');
      }),
    ).toMatchObject({ status: 'fixed' });
  });

  it('a media file is checked even when the reply says it could not (done: false)', async () => {
    const outcome = await verify(() => {
      put('edit/preview/cut.mp4', 'another cut');
      put(`${FIX_DIR}/reply.json`, JSON.stringify({ done: false, why: 'no' }));
    });
    expect(outcome.status).toBe('failed');
  });
});

describe('writes outside the allowed places', () => {
  it.each([
    ['a file at the top of the job folder', 'stray.txt'],
    ['another file of edit/', 'edit/brief.json'],
    ['the job’s footage', 'clip-1.mp4'],
    ['the shared fonts', 'edit/fonts/Heebo-Bold.ttf'],
    ['another fix’s folder', 'edit/review/fixes/other/reply.json'],
  ])('%s: failed', async (_name, path) => {
    const outcome = await verify(() => {
      goodFix();
      put(path, 'changed');
    });
    expect(outcome).toMatchObject({
      status: 'failed',
      why: `it changed ${path}, outside the composition`,
    });
  });

  it('a removed file counts too', async () => {
    const outcome = await verify(() => {
      goodFix();
      rmSync(join(jobDir, 'edit/fonts/Heebo-Bold.ttf'));
    });
    expect(outcome).toMatchObject({
      status: 'failed',
      why: expect.stringContaining('edit/fonts/Heebo-Bold.ttf'),
    });
  });
});

describe('the lint', () => {
  it('failing: failed with the lint’s own words, and it is asked about this job', async () => {
    const asked: string[] = [];
    const outcome = await verify(goodFix, {
      lint: async (dir) => {
        asked.push(dir);
        return { ok: false, why: 'lint: Root composition is missing data-width' };
      },
    });
    expect(outcome).toMatchObject({
      status: 'failed',
      why: 'lint: Root composition is missing data-width',
    });
    expect(asked).toEqual([jobDir]);
  });

  it('is not run for a fix that is escalated', async () => {
    let ran = false;
    const outcome = await verify(
      () =>
        put(`${FIX_DIR}/reply.json`, JSON.stringify({ done: false, why: 'it changes the cut' })),
      {
        lint: async () => {
          ran = true;
          return { ok: true };
        },
      },
    );
    expect(outcome.status).toBe('escalated');
    expect(ran).toBe(false);
  });
});

describe('the compare stills', () => {
  it('become before.png and after.png, hasCompare is true, and stills/ is removed', async () => {
    const outcome = await verify(() => {
      goodFix();
      put(`${FIX_DIR}/stills/before/${snapshotFileName(AT)}`, 'before');
      put(`${FIX_DIR}/stills/after/${snapshotFileName(AT)}`, 'after');
      put(`${FIX_DIR}/stills/frames/at-1s.png`, 'frame');
    });
    expect(outcome).toMatchObject({ status: 'fixed', hasCompare: true });
    expect(readFileSync(join(jobDir, FIX_DIR, 'before.png'), 'utf8')).toBe('before');
    expect(readFileSync(join(jobDir, FIX_DIR, 'after.png'), 'utf8')).toBe('after');
    expect(existsSync(join(jobDir, FIX_DIR, 'stills'))).toBe(false);
  });

  it('are collected for an escalated fix too, and hasCompare says only one exists', async () => {
    const outcome = await verify(() => {
      put(`${FIX_DIR}/reply.json`, JSON.stringify({ done: false, why: 'the sign is footage' }));
      put(`${FIX_DIR}/stills/before/${snapshotFileName(AT)}`, 'before');
    });
    expect(outcome).toMatchObject({ status: 'escalated', hasCompare: false });
    expect(existsSync(join(jobDir, FIX_DIR, 'before.png'))).toBe(true);
    expect(existsSync(join(jobDir, FIX_DIR, 'after.png'))).toBe(false);
  });

  it('take the only PNG of a folder when it is not at the name expected', async () => {
    put(`${FIX_DIR}/stills/before/frame-00-at-12.4s.png`, 'before');
    put(`${FIX_DIR}/stills/after/something.png`, 'after');
    expect(await collectCompareStills(jobDir, FIX_ID, AT)).toBe(true);
    expect(readFileSync(join(jobDir, FIX_DIR, 'after.png'), 'utf8')).toBe('after');
  });

  it('take the name expected when a folder has more than one', async () => {
    put(`${FIX_DIR}/stills/before/at-1s.png`, 'other');
    put(`${FIX_DIR}/stills/before/${snapshotFileName(AT)}`, 'before');
    put(`${FIX_DIR}/stills/after/${snapshotFileName(AT)}`, 'after');
    expect(await collectCompareStills(jobDir, FIX_ID, AT)).toBe(true);
    expect(readFileSync(join(jobDir, FIX_DIR, 'before.png'), 'utf8')).toBe('before');
  });

  it('cannot choose between several PNGs without the name: no compare', async () => {
    put(`${FIX_DIR}/stills/before/a.png`, 'a');
    put(`${FIX_DIR}/stills/before/b.png`, 'b');
    put(`${FIX_DIR}/stills/after/${snapshotFileName(AT)}`, 'after');
    expect(await collectCompareStills(jobDir, FIX_ID, AT)).toBe(false);
  });

  it('an empty still is not a compare', async () => {
    put(`${FIX_DIR}/stills/before/${snapshotFileName(AT)}`, '');
    put(`${FIX_DIR}/stills/after/${snapshotFileName(AT)}`, 'after');
    expect(await collectCompareStills(jobDir, FIX_ID, AT)).toBe(false);
  });

  it('a job with no fix folder at all is not a compare, and does not throw', async () => {
    expect(await collectCompareStills(jobDir, 'never-made', AT)).toBe(false);
  });
});

describe('the listing', () => {
  it('lists every file with its size, and sees added, modified and removed ones', async () => {
    const before = await listJobFolder(jobDir);
    expect(before.get('edit/preview/cut.mp4')?.size).toBe('the cut'.length);
    expect(before.has('edit/preview')).toBe(false);
    put('new.txt', 'n');
    put('edit/project.md', '# Job, changed\n');
    rmSync(join(jobDir, 'clip-1.mp4'));
    const after = await listJobFolder(jobDir);
    expect(listingChanges(before, after)).toEqual([
      { path: 'clip-1.mp4', kind: 'removed' },
      { path: 'edit/project.md', kind: 'modified' },
      { path: 'new.txt', kind: 'added' },
    ]);
  });

  it('is empty for a folder that is not there', async () => {
    expect((await listJobFolder(join(jobDir, 'nope'))).size).toBe(0);
  });
});
