import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COMPOSITION_FILE_MAX_BYTES,
  isCompositionKitFile,
  isKitFile,
  isLibraryGraphicPath,
  keepPreviousKit,
  keepReplacedKit,
  listSlots,
  PREVIOUS_KIT_NAME,
  prepareKit,
  restoreKit,
} from './style-kit.js';

// The kit of a Learn pass on real temp folders: a job with graphics, a style folder, a history.

let root: string;
let jobDir: string;
let styleDir: string;
let historyKit: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-style-kit-'));
  jobDir = join(root, 'inbox', 'Kova Coffee', 'Menu');
  styleDir = join(root, 'inbox', 'Kova Coffee', '_Style');
  historyKit = join(root, 'data', 'clients', 'abc', 'history', '2-kit');
  mkdirSync(styleDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text = 'x'): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Every file below `dir`, relative to it, sorted. */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** A finished edit's graphics: two slots with their renders, a shared folder, loose files. */
function makeGraphics(): void {
  const animations = join(jobDir, 'edit', 'animations');
  write(join(animations, 'slot_title', 'index.html'), '<h1>Kova</h1>');
  write(join(animations, 'slot_title', 'assets', 'fonts', 'inter-700.woff2'));
  write(join(animations, 'slot_title', 'render.mov'), 'big');
  write(join(animations, 'slot_title', 'preview.MP4'), 'big');
  write(join(animations, 'slot_title', 'loop.webm'), 'big');
  write(join(animations, 'slot_title', 'snaps', 'frame-00.png'));
  write(join(animations, 'slot_title', '.hyperframes', 'video-state.json'));
  write(join(animations, 'slot_title', '.DS_Store'));
  write(join(animations, 'slot_captions', 'index.html'), '<p>captions</p>');
  write(join(animations, '_shared', 'vendor', 'gsap.min.js'));
  write(join(animations, 'words_out.json'));
  write(join(animations, 'slot_note.txt'), 'a file, not a slot');
}

/**
 * A finished edit built as one composition (no slots): the HTML, a sub-composition, fonts and
 * assets, plus what it also holds that is no graphic: the baked cut, music, renders, render state.
 */
function makeComposition(folder: 'preview' | 'composition' = 'preview'): void {
  const composition = join(jobDir, 'edit', folder);
  write(join(composition, 'index.html'), '<div data-composition-id="root"></div>');
  write(join(composition, 'compositions', 'captions.html'), '<template>captions</template>');
  write(join(composition, 'assets', 'fonts', 'rubik-700.woff2'));
  write(join(composition, 'assets', 'logo.png'));
  write(join(composition, 'vendor', 'gsap.min.js'));
  write(join(composition, 'README.md'), 'notes');
  write(join(composition, 'cut.mp4'), 'big');
  write(join(composition, 'music.wav'), 'big');
  write(join(composition, 'music.MP3'), 'big');
  write(join(composition, 'renders', 'draft.webm'), 'big');
  write(join(composition, 'node_modules', 'gsap', 'index.js'));
  write(join(composition, '.hyperframes', 'state.json'));
  write(join(composition, '.DS_Store'));
}

/**
 * What a composition with music holds (C21): the index plays `assets/audio/music.mp3`, a
 * sub-composition's script plays `stamp.m4a` and a name with a space, URL-encoded; beside them an
 * audio file nothing names, and the episode's own speech at the top of the folder.
 */
function addAudio(): void {
  const composition = join(jobDir, 'edit', 'preview');
  write(
    join(composition, 'index.html'),
    '<div data-composition-id="root"><audio src="assets/audio/music.mp3" data-start="0"></audio></div>',
  );
  write(
    join(composition, 'compositions', 'captions.html'),
    '<template><script>new Audio("../assets/audio/stamp.m4a"); load("assets/audio/my%20song.wav")</script></template>',
  );
  write(join(composition, 'assets', 'audio', 'music.mp3'), 'music');
  write(join(composition, 'assets', 'audio', 'stamp.m4a'), 'stamp');
  write(join(composition, 'assets', 'audio', 'my song.wav'), 'song');
  write(join(composition, 'assets', 'audio', 'unused.wav'), 'unused');
  write(join(composition, 'speech.m4a'), 'the episode’s own speech');
}

/** Two graphics of the Graphics library, as an edit mounts them (the Brief step's instructions). */
const PILL = 'a7c2fb621794';
const CALLOUT = 'e983f5f21d00';

/**
 * What an edit that used library graphics holds in the project at `project` (its root): each one's
 * composition and the folder of what it loads, mounted in index.html, beside the edit's own files.
 */
function addLibraryGraphics(project: string): void {
  const index = join(project, 'index.html');
  const mounts = [PILL, CALLOUT]
    .map(
      (id, i) =>
        `<div data-composition-id="lib-${id}" data-composition-src="compositions/lib-${id}.html" data-start="${i + 4}"></div>`,
    )
    .join('');
  const current = existsSync(index)
    ? readFileSync(index, 'utf8')
    : '<div data-composition-id="root"></div>';
  write(index, current.replace(/<\/div>\s*$/, `${mounts}</div>`));
  for (const id of [PILL, CALLOUT]) {
    write(join(project, 'compositions', `lib-${id}.html`), `<template>library ${id}</template>`);
    write(join(project, 'lib', id, 'fonts', 'Heebo-Bold.ttf'), 'font');
    write(join(project, 'lib', id, 'logo.svg'), '<svg/>');
  }
}

describe('what a kit holds', () => {
  it('keeps graphics, never a render output or a dot file', () => {
    expect(isKitFile('index.html')).toBe(true);
    expect(isKitFile('inter-700.woff2')).toBe(true);
    expect(isKitFile('contact-sheet.jpg')).toBe(true);
    for (const name of ['render.mov', 'render.MOV', 'preview.mp4', 'loop.webm', '.DS_Store']) {
      expect(isKitFile(name), name).toBe(false);
    }
  });

  it('keeps a composition’s HTML, fonts and assets, never media, node_modules or a dot file', () => {
    for (const name of [
      'index.html',
      'captions.html',
      'rubik-700.woff2',
      'logo.png',
      'gsap.min.js',
    ]) {
      expect(isCompositionKitFile(name), name).toBe(true);
    }
    for (const name of [
      'cut.mp4',
      'render.MOV',
      'loop.webm',
      'music.wav',
      'music.mp3',
      'voice.m4a',
      'node_modules',
      '.hyperframes',
      '.DS_Store',
    ]) {
      expect(isCompositionKitFile(name), name).toBe(false);
    }
  });

  it('lists the slot folders only, sorted, and none for a job without graphics', async () => {
    makeGraphics();
    expect(await listSlots(jobDir)).toEqual(['slot_captions', 'slot_title']);
    expect(await listSlots(join(root, 'nowhere'))).toEqual([]);
  });
});

describe('prepareKit', () => {
  it('copies the slots into a fresh kit/ without the render outputs', async () => {
    makeGraphics();

    const slots = await prepareKit(jobDir, styleDir);

    expect(slots).toEqual(['slot_captions', 'slot_title']);
    expect(tree(join(styleDir, 'kit'))).toEqual([
      'slot_captions/index.html',
      'slot_title/assets/fonts/inter-700.woff2',
      'slot_title/index.html',
      'slot_title/snaps/frame-00.png',
    ]);
    expect(readFileSync(join(styleDir, 'kit', 'slot_title', 'index.html'), 'utf8')).toBe(
      '<h1>Kova</h1>',
    );
    // The job is read, never changed.
    expect(existsSync(join(jobDir, 'edit', 'animations', 'slot_title', 'render.mov'))).toBe(true);
    // Nothing half-made is left beside it.
    expect(readdirSync(styleDir).sort()).toEqual([PREVIOUS_KIT_NAME, 'kit']);
  });

  it('copies what a link in a slot points at, so the kit stands on its own', async () => {
    makeGraphics();
    const shared = join(jobDir, 'edit', 'animations', '_shared', 'vendor');
    symlinkSync(shared, join(jobDir, 'edit', 'animations', 'slot_captions', 'vendor'));

    await prepareKit(jobDir, styleDir);

    expect(tree(join(styleDir, 'kit', 'slot_captions'))).toEqual([
      'index.html',
      'vendor/gsap.min.js',
    ]);
  });

  it('sets the old kit aside, and puts it back when the run fails', async () => {
    makeGraphics();
    write(join(styleDir, 'kit', 'slot_old', 'index.html'), 'old');

    await prepareKit(jobDir, styleDir);
    expect(tree(join(styleDir, PREVIOUS_KIT_NAME))).toEqual(['slot_old/index.html']);
    expect(tree(join(styleDir, 'kit'))).toContain('slot_title/index.html');

    await restoreKit(styleDir);
    expect(tree(join(styleDir, 'kit'))).toEqual(['slot_old/index.html']);
    expect(existsSync(join(styleDir, PREVIOUS_KIT_NAME))).toBe(false);
  });

  it('leaves no kit after a failed run when there was none before', async () => {
    makeGraphics();

    await prepareKit(jobDir, styleDir);
    await restoreKit(styleDir);

    expect(readdirSync(styleDir)).toEqual([]);
  });

  it('after a crash mid-run keeps the kit that was set aside and throws the half-made one away', async () => {
    makeGraphics();
    write(join(styleDir, PREVIOUS_KIT_NAME, 'slot_old', 'index.html'), 'old');
    write(join(styleDir, 'kit', 'slot_title', 'half.html'));

    await prepareKit(jobDir, styleDir);

    expect(tree(join(styleDir, PREVIOUS_KIT_NAME))).toEqual(['slot_old/index.html']);
    expect(tree(join(styleDir, 'kit'))).not.toContain('slot_title/half.html');
  });
});

describe('prepareKit for a composition-only edit (no slot folders)', () => {
  it('copies the live composition of a Review job into kit/composition/ without media', async () => {
    makeComposition('preview');

    expect(await prepareKit(jobDir, styleDir)).toEqual(['composition']);

    expect(tree(join(styleDir, 'kit'))).toEqual([
      'composition/README.md',
      'composition/assets/fonts/rubik-700.woff2',
      'composition/assets/logo.png',
      'composition/compositions/captions.html',
      'composition/index.html',
      'composition/vendor/gsap.min.js',
    ]);
    // The folders that held only media are not left behind empty.
    expect(readdirSync(join(styleDir, 'kit', 'composition')).sort()).toEqual([
      'README.md',
      'assets',
      'compositions',
      'index.html',
      'vendor',
    ]);
    // The job is read, never changed.
    expect(existsSync(join(jobDir, 'edit', 'preview', 'cut.mp4'))).toBe(true);
    expect(readdirSync(styleDir).sort()).toEqual([PREVIOUS_KIT_NAME, 'kit']);
  });

  it('copies edit/composition/ when the job has no live composition', async () => {
    makeComposition('composition');

    expect(await prepareKit(jobDir, styleDir)).toEqual(['composition']);

    expect(tree(join(styleDir, 'kit'))).toContain('composition/index.html');
    expect(tree(join(styleDir, 'kit'))).not.toContain('composition/cut.mp4');
  });

  it('takes the live composition before edit/composition/ when a job has both', async () => {
    makeComposition('composition');
    write(join(jobDir, 'edit', 'preview', 'index.html'), 'the approved one');

    await prepareKit(jobDir, styleDir);

    expect(readFileSync(join(styleDir, 'kit', 'composition', 'index.html'), 'utf8')).toBe(
      'the approved one',
    );
    expect(tree(join(styleDir, 'kit'))).toEqual(['composition/index.html']);
  });

  it('goes on to edit/composition/ when the live composition holds only media', async () => {
    write(join(jobDir, 'edit', 'preview', 'cut.mp4'), 'big');
    makeComposition('composition');

    expect(await prepareKit(jobDir, styleDir)).toEqual(['composition']);

    expect(tree(join(styleDir, 'kit'))).toContain('composition/index.html');
  });

  it('leaves out a file over the size limit, whatever its type', async () => {
    makeComposition('preview');
    const big = join(jobDir, 'edit', 'preview', 'assets', 'broll.png');
    mkdirSync(dirname(big), { recursive: true });
    writeFileSync(big, Buffer.alloc(COMPOSITION_FILE_MAX_BYTES + 1));

    await prepareKit(jobDir, styleDir);

    expect(tree(join(styleDir, 'kit'))).not.toContain('composition/assets/broll.png');
    expect(tree(join(styleDir, 'kit'))).toContain('composition/assets/logo.png');
  });

  it('copies what a link in the composition points at', async () => {
    makeComposition('preview');
    const vendor = join(root, 'shared-vendor');
    write(join(vendor, 'gsap.min.js'), 'shared');
    symlinkSync(vendor, join(jobDir, 'edit', 'preview', 'linked'));

    await prepareKit(jobDir, styleDir);

    expect(
      readFileSync(join(styleDir, 'kit', 'composition', 'linked', 'gsap.min.js'), 'utf8'),
    ).toBe('shared');
  });

  it('replaces an old slot kit, which goes to history', async () => {
    makeComposition('preview');
    write(join(styleDir, 'kit', 'slot_old', 'index.html'), 'old');

    await prepareKit(jobDir, styleDir);
    await keepPreviousKit(styleDir, historyKit, true);

    expect(tree(join(styleDir, 'kit'))).toContain('composition/index.html');
    expect(tree(join(styleDir, 'kit'))).not.toContain('slot_old/index.html');
    expect(tree(historyKit)).toEqual(['slot_old/index.html']);
  });

  it('puts the old kit back when the run fails', async () => {
    makeComposition('preview');
    write(join(styleDir, 'kit', 'slot_old', 'index.html'), 'old');

    await prepareKit(jobDir, styleDir);
    await restoreKit(styleDir);

    expect(tree(join(styleDir, 'kit'))).toEqual(['slot_old/index.html']);
  });

  it('prefers the slots when a job has both', async () => {
    makeGraphics();
    makeComposition('preview');

    expect(await prepareKit(jobDir, styleDir)).toEqual(['slot_captions', 'slot_title']);

    expect(tree(join(styleDir, 'kit')).some((path) => path.startsWith('composition/'))).toBe(false);
  });
});

describe('prepareKit for a job with neither slots nor a composition', () => {
  it('leaves the client’s kit exactly as it is, and sets nothing aside', async () => {
    write(join(styleDir, 'kit', 'slot_old', 'index.html'), 'old');
    write(join(styleDir, 'kit', 'composition', 'index.html'), 'older');
    // A job whose edit holds a video and notes only.
    write(join(jobDir, 'edit', 'final.mp4'), 'big');
    write(join(jobDir, 'edit', 'project.md'), 'plan');
    write(join(jobDir, 'edit', 'preview', 'cut.mp4'), 'big');

    expect(await prepareKit(jobDir, styleDir)).toEqual([]);

    expect(tree(join(styleDir, 'kit'))).toEqual(['composition/index.html', 'slot_old/index.html']);
    expect(readdirSync(styleDir)).toEqual(['kit']);
  });

  it('then keeps nothing in history, and restoreKit changes nothing', async () => {
    write(join(styleDir, 'kit', 'slot_old', 'index.html'), 'old');

    await prepareKit(jobDir, styleDir);
    await keepPreviousKit(styleDir, historyKit, true);
    await restoreKit(styleDir);

    expect(existsSync(historyKit)).toBe(false);
    expect(tree(join(styleDir, 'kit'))).toEqual(['slot_old/index.html']);
  });

  it('makes no kit/ for a client that has none', async () => {
    expect(await prepareKit(jobDir, styleDir)).toEqual([]);

    expect(readdirSync(styleDir)).toEqual([]);
  });

  it('puts back the kit a crashed run set aside, and drops the half-made one', async () => {
    write(join(styleDir, PREVIOUS_KIT_NAME, 'slot_old', 'index.html'), 'old');
    write(join(styleDir, 'kit', 'composition', 'half.html'));

    expect(await prepareKit(jobDir, styleDir)).toEqual([]);

    expect(tree(join(styleDir, 'kit'))).toEqual(['slot_old/index.html']);
    expect(existsSync(join(styleDir, PREVIOUS_KIT_NAME))).toBe(false);
  });

  it('keeps the kit for a job folder that is not there', async () => {
    write(join(styleDir, 'kit', 'slot_old', 'index.html'), 'old');

    expect(await prepareKit(join(root, 'nowhere'), styleDir)).toEqual([]);

    expect(tree(join(styleDir, 'kit'))).toEqual(['slot_old/index.html']);
  });
});

describe('a Learn never leaves the kit empty when the old one had graphics', () => {
  const jobs: Array<[string, () => void]> = [
    ['slots', makeGraphics],
    ['a live composition', () => makeComposition('preview')],
    ['a composition folder', () => makeComposition('composition')],
    ['neither', () => undefined],
  ];

  for (const [what, make] of jobs) {
    it(`from a job with ${what}`, async () => {
      write(join(styleDir, 'kit', 'slot_old', 'index.html'), 'old');
      make();

      await prepareKit(jobDir, styleDir);
      await keepPreviousKit(styleDir, historyKit, true);

      expect(tree(join(styleDir, 'kit')).length).toBeGreaterThan(0);
    });
  }
});

describe('keepPreviousKit', () => {
  it('moves the old kit to history once the new style is in place', async () => {
    makeGraphics();
    write(join(styleDir, 'kit', 'slot_old', 'index.html'), 'old');
    await prepareKit(jobDir, styleDir);

    await keepPreviousKit(styleDir, historyKit, true);

    expect(tree(historyKit)).toEqual(['slot_old/index.html']);
    expect(existsSync(join(styleDir, PREVIOUS_KIT_NAME))).toBe(false);
    expect(tree(join(styleDir, 'kit'))).toContain('slot_title/index.html');
  });

  it('keeps an empty one when the replaced style had no kit, so Undo knows to clear it', async () => {
    makeGraphics();
    await prepareKit(jobDir, styleDir);

    await keepPreviousKit(styleDir, historyKit, true);

    expect(existsSync(historyKit)).toBe(true);
    expect(readdirSync(historyKit)).toEqual([]);
  });

  it('keeps nothing for a first style that had nothing before it', async () => {
    makeGraphics();
    await prepareKit(jobDir, styleDir);

    await keepPreviousKit(styleDir, historyKit, false);

    expect(existsSync(historyKit)).toBe(false);
    expect(existsSync(join(styleDir, PREVIOUS_KIT_NAME))).toBe(false);
  });
});

// C17: a Read pass that replaces the style has no new kit, only the old one to let go of.
describe('keepReplacedKit', () => {
  it('moves the kit to history, whole, and leaves no kit in the style folder', async () => {
    write(join(styleDir, 'kit', 'slot_title', 'index.html'), 'title');
    write(join(styleDir, 'kit', 'slot_title', 'assets', 'font.woff2'), 'font');
    write(join(styleDir, 'kit', 'slot_end', 'index.html'), 'end');
    write(join(styleDir, 'style.md'), '# Style: Kova Coffee\n');

    expect(await keepReplacedKit(styleDir, historyKit)).toBe(true);

    expect(tree(historyKit)).toEqual([
      'slot_end/index.html',
      'slot_title/assets/font.woff2',
      'slot_title/index.html',
    ]);
    expect(existsSync(join(styleDir, 'kit'))).toBe(false);
    // The rest of the style folder is not its business.
    expect(existsSync(join(styleDir, 'style.md'))).toBe(true);
  });

  it('replaces a history kit left at that version, rather than mixing the two', async () => {
    write(join(historyKit, 'slot_stale', 'index.html'), 'stale');
    write(join(styleDir, 'kit', 'slot_title', 'index.html'), 'title');

    expect(await keepReplacedKit(styleDir, historyKit)).toBe(true);

    expect(tree(historyKit)).toEqual(['slot_title/index.html']);
  });

  it('does nothing for a client with no kit: no empty history kit either', async () => {
    expect(await keepReplacedKit(styleDir, historyKit)).toBe(false);

    expect(existsSync(historyKit)).toBe(false);
    expect(existsSync(join(styleDir, 'kit'))).toBe(false);
  });
});

describe('prepareKit for a series (layout series)', () => {
  const seriesDir = () => join(root, 'inbox', 'Kova Coffee', '_Series', 'Weekly');

  it('copies the composition itself into a new series folder’s kit/, without media', async () => {
    makeComposition('preview');
    // Slot folders are not a series' kit: the composition is what episodes are rebuilt from.
    makeGraphics();

    expect(await prepareKit(jobDir, seriesDir(), 'series')).toEqual(['edit/preview']);

    expect(tree(join(seriesDir(), 'kit'))).toEqual([
      'README.md',
      'assets/fonts/rubik-700.woff2',
      'assets/logo.png',
      'compositions/captions.html',
      'index.html',
      'vendor/gsap.min.js',
    ]);
    // A new series has no old kit: an empty one is set aside, as for a first style kit.
    expect(readdirSync(seriesDir()).sort()).toEqual([PREVIOUS_KIT_NAME, 'kit']);
    expect(readdirSync(join(seriesDir(), PREVIOUS_KIT_NAME))).toEqual([]);
  });

  // C21: the music and sounds are part of the format, so the series keeps them.
  it('keeps the audio the composition uses, which the style kit leaves out', async () => {
    makeComposition('preview');
    addAudio();

    expect(await prepareKit(jobDir, seriesDir(), 'series')).toEqual(['edit/preview']);

    expect(tree(join(seriesDir(), 'kit'))).toEqual([
      'README.md',
      'assets/audio/music.mp3',
      'assets/audio/my song.wav',
      'assets/audio/stamp.m4a',
      'assets/fonts/rubik-700.woff2',
      'assets/logo.png',
      'compositions/captions.html',
      'index.html',
      'vendor/gsap.min.js',
    ]);
    expect(readFileSync(join(seriesDir(), 'kit', 'assets', 'audio', 'music.mp3'), 'utf8')).toBe(
      'music',
    );
    // The job is read, never changed.
    expect(existsSync(join(jobDir, 'edit', 'preview', 'assets', 'audio', 'unused.wav'))).toBe(true);

    expect(await prepareKit(jobDir, styleDir)).toEqual(['composition']);
    expect(tree(join(styleDir, 'kit')).filter((path) => path.includes('audio'))).toEqual([]);
    expect(tree(join(styleDir, 'kit'))).not.toContain('composition/assets/audio/music.mp3');
  });

  it('still leaves out the cut, the renders, big audio and audio no file names', async () => {
    makeComposition('preview');
    addAudio();
    const composition = join(jobDir, 'edit', 'preview');
    write(join(composition, 'assets', 'cut.mp4'), 'big');
    write(join(composition, 'assets', 'audio', 'render.webm'), 'big');
    write(
      join(composition, 'compositions', 'more.html'),
      '<audio src="assets/audio/long-mix.mp3"></audio>',
    );
    writeFileSync(
      join(composition, 'assets', 'audio', 'long-mix.mp3'),
      Buffer.alloc(COMPOSITION_FILE_MAX_BYTES + 1),
    );

    await prepareKit(jobDir, seriesDir(), 'series');

    const kit = tree(join(seriesDir(), 'kit'));
    for (const name of [
      'assets/cut.mp4',
      'assets/audio/render.webm',
      'assets/audio/long-mix.mp3',
      'assets/audio/unused.wav',
      'cut.mp4',
      'speech.m4a',
      'music.wav',
      'music.MP3',
      'renders/draft.webm',
    ]) {
      expect(kit, name).not.toContain(name);
    }
    expect(kit).toContain('assets/audio/music.mp3');
  });

  it('keeps no audio when nothing in the composition names it', async () => {
    makeComposition('preview');
    write(join(jobDir, 'edit', 'preview', 'assets', 'audio', 'music.mp3'), 'music');

    await prepareKit(jobDir, seriesDir(), 'series');

    expect(tree(join(seriesDir(), 'kit'))).not.toContain('assets/audio/music.mp3');
    expect(readdirSync(join(seriesDir(), 'kit', 'assets')).sort()).toEqual(['fonts', 'logo.png']);
  });

  it('takes edit/composition/ when there is no live composition', async () => {
    makeComposition('composition');

    expect(await prepareKit(jobDir, seriesDir(), 'series')).toEqual(['edit/composition']);
    expect(tree(join(seriesDir(), 'kit'))).toContain('index.html');
  });

  it('sets the old series kit aside, and restoreKit puts it back after a failed run', async () => {
    write(join(seriesDir(), 'kit', 'index.html'), 'the old format');
    makeComposition('preview');

    await prepareKit(jobDir, seriesDir(), 'series');
    expect(readFileSync(join(seriesDir(), PREVIOUS_KIT_NAME, 'index.html'), 'utf8')).toBe(
      'the old format',
    );

    await restoreKit(seriesDir());
    expect(tree(join(seriesDir(), 'kit'))).toEqual(['index.html']);
    expect(readFileSync(join(seriesDir(), 'kit', 'index.html'), 'utf8')).toBe('the old format');
    expect(existsSync(join(seriesDir(), PREVIOUS_KIT_NAME))).toBe(false);
  });

  it('copies nothing for a job without a composition, and leaves the series kit alone', async () => {
    makeGraphics();
    write(join(seriesDir(), 'kit', 'index.html'), 'the old format');

    expect(await prepareKit(jobDir, seriesDir(), 'series')).toEqual([]);
    expect(tree(seriesDir())).toEqual(['kit/index.html']);
  });

  it('keeps the kit set aside in the series history once the new series.md is in', async () => {
    write(join(seriesDir(), 'kit', 'index.html'), 'the old format');
    makeComposition('preview');
    await prepareKit(jobDir, seriesDir(), 'series');

    await keepPreviousKit(seriesDir(), historyKit, true);

    expect(tree(historyKit)).toEqual(['index.html']);
    expect(existsSync(join(seriesDir(), PREVIOUS_KIT_NAME))).toBe(false);
  });
});

// C30: the library is the only source of a library graphic, so no kit copies one.
describe('library graphics are never copied into a kit', () => {
  const seriesDir = () => join(root, 'inbox', 'Kova Coffee', '_Series', 'Weekly');

  it('knows a library graphic’s files by their path in the project', () => {
    for (const path of [
      `compositions/lib-${PILL}.html`,
      `lib/${PILL}`,
      `lib/${PILL}/logo.svg`,
      `lib/${PILL}/fonts/Heebo-Bold.ttf`,
    ]) {
      expect(isLibraryGraphicPath(path), path).toBe(true);
    }
    for (const path of [
      '',
      'index.html',
      'compositions',
      'compositions/captions.html',
      'compositions/lib-name.html',
      'compositions/lib-A7C2FB621794.html',
      'compositions/lib-a7c2fb62179.html',
      'compositions/lib-a7c2fb6217945.html',
      `compositions/lib-${PILL}.css`,
      `compositions/more/lib-${PILL}.html`,
      `lib-${PILL}.html`,
      'lib',
      'lib/gsap/gsap.min.js',
      'lib/fonts',
      `assets/lib/${PILL}/logo.svg`,
    ]) {
      expect(isLibraryGraphicPath(path), path).toBe(false);
    }
  });

  it('leaves them out of the style kit’s composition, and keeps everything else', async () => {
    makeComposition('preview');
    addLibraryGraphics(join(jobDir, 'edit', 'preview'));

    expect(await prepareKit(jobDir, styleDir)).toEqual(['composition']);

    expect(tree(join(styleDir, 'kit'))).toEqual([
      'composition/README.md',
      'composition/assets/fonts/rubik-700.woff2',
      'composition/assets/logo.png',
      'composition/compositions/captions.html',
      'composition/index.html',
      'composition/vendor/gsap.min.js',
    ]);
    // Nothing of them is left behind, not even an empty lib/ folder.
    expect(readdirSync(join(styleDir, 'kit', 'composition')).sort()).toEqual([
      'README.md',
      'assets',
      'compositions',
      'index.html',
      'vendor',
    ]);
    // The mount stays in index.html: it shows where the graphic played.
    expect(readFileSync(join(styleDir, 'kit', 'composition', 'index.html'), 'utf8')).toContain(
      `data-composition-src="compositions/lib-${PILL}.html"`,
    );
  });

  it('reads the job, never changes it: the edit still holds its library graphics', async () => {
    makeComposition('preview');
    addLibraryGraphics(join(jobDir, 'edit', 'preview'));

    await prepareKit(jobDir, styleDir);

    const preview = join(jobDir, 'edit', 'preview');
    expect(readFileSync(join(preview, 'compositions', `lib-${PILL}.html`), 'utf8')).toBe(
      `<template>library ${PILL}</template>`,
    );
    expect(existsSync(join(preview, 'lib', CALLOUT, 'fonts', 'Heebo-Bold.ttf'))).toBe(true);
  });

  it('leaves them out of the kit of a Review-off job’s edit/composition/ too', async () => {
    makeComposition('composition');
    addLibraryGraphics(join(jobDir, 'edit', 'composition'));

    await prepareKit(jobDir, styleDir);

    expect(tree(join(styleDir, 'kit')).filter((path) => /lib-|\/lib\//.test(path))).toEqual([]);
    expect(tree(join(styleDir, 'kit'))).toContain('composition/compositions/captions.html');
  });

  it('leaves them out of the style kit’s slot folders', async () => {
    makeGraphics();
    addLibraryGraphics(join(jobDir, 'edit', 'animations', 'slot_title'));

    expect(await prepareKit(jobDir, styleDir)).toEqual(['slot_captions', 'slot_title']);

    expect(tree(join(styleDir, 'kit'))).toEqual([
      'slot_captions/index.html',
      'slot_title/assets/fonts/inter-700.woff2',
      'slot_title/index.html',
      'slot_title/snaps/frame-00.png',
    ]);
  });

  it('leaves them out of a series’ kit, with the audio and the rest of the format kept', async () => {
    makeComposition('preview');
    addAudio();
    addLibraryGraphics(join(jobDir, 'edit', 'preview'));

    expect(await prepareKit(jobDir, seriesDir(), 'series')).toEqual(['edit/preview']);

    expect(tree(join(seriesDir(), 'kit'))).toEqual([
      'README.md',
      'assets/audio/music.mp3',
      'assets/audio/my song.wav',
      'assets/audio/stamp.m4a',
      'assets/fonts/rubik-700.woff2',
      'assets/logo.png',
      'compositions/captions.html',
      'index.html',
      'vendor/gsap.min.js',
    ]);
    expect(readFileSync(join(seriesDir(), 'kit', 'index.html'), 'utf8')).toContain(
      `data-composition-src="compositions/lib-${CALLOUT}.html"`,
    );
  });

  it('keeps the client’s own lib/ folder and files whose names only look alike', async () => {
    makeComposition('preview');
    const preview = join(jobDir, 'edit', 'preview');
    write(join(preview, 'lib', 'gsap', 'gsap.min.js'), 'gsap');
    write(join(preview, 'compositions', 'lib-name.html'), '<template>own</template>');
    write(join(preview, 'compositions', `lib-${PILL}.css`), 'own');
    write(join(preview, 'assets', 'lib', PILL, 'logo.svg'), '<svg/>');

    await prepareKit(jobDir, styleDir);
    await prepareKit(jobDir, seriesDir(), 'series');

    for (const [kit, prefix] of [
      [join(styleDir, 'kit'), 'composition/'],
      [join(seriesDir(), 'kit'), ''],
    ] as const) {
      const files = tree(kit);
      for (const name of [
        'lib/gsap/gsap.min.js',
        'compositions/lib-name.html',
        `compositions/lib-${PILL}.css`,
        `assets/lib/${PILL}/logo.svg`,
      ]) {
        expect(files, `${prefix}${name}`).toContain(`${prefix}${name}`);
      }
    }
  });

  it('copies exactly what it did before when the edit used no library graphic', async () => {
    makeComposition('preview');

    await prepareKit(jobDir, styleDir);
    await prepareKit(jobDir, seriesDir(), 'series');

    expect(tree(join(styleDir, 'kit'))).toEqual([
      'composition/README.md',
      'composition/assets/fonts/rubik-700.woff2',
      'composition/assets/logo.png',
      'composition/compositions/captions.html',
      'composition/index.html',
      'composition/vendor/gsap.min.js',
    ]);
    expect(tree(join(seriesDir(), 'kit'))).toEqual([
      'README.md',
      'assets/fonts/rubik-700.woff2',
      'assets/logo.png',
      'compositions/captions.html',
      'index.html',
      'vendor/gsap.min.js',
    ]);
  });

  it('counts a composition that holds only library graphics as nothing to learn', async () => {
    const preview = join(jobDir, 'edit', 'preview');
    write(join(preview, 'compositions', `lib-${PILL}.html`), '<template/>');
    write(join(preview, 'lib', PILL, 'logo.svg'), '<svg/>');
    write(join(styleDir, 'kit', 'slot_old', 'index.html'), 'old');

    expect(await prepareKit(jobDir, styleDir)).toEqual([]);
    expect(await prepareKit(jobDir, seriesDir(), 'series')).toEqual([]);

    // The client’s kit is left exactly as it was.
    expect(tree(join(styleDir, 'kit'))).toEqual(['slot_old/index.html']);
    expect(existsSync(join(seriesDir(), 'kit'))).toBe(false);
  });
});
