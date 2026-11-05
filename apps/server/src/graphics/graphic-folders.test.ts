import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GSAP_ASSET_PATH } from './graphic-assets.js';
import {
  GraphicFolders,
  graphicDir,
  graphicFontsDir,
  graphicRefsDir,
  graphicVersionDir,
  graphicWorkDir,
} from './graphic-folders.js';
import { stagedFile, writeCannedGraphic } from './test-utils.js';

// What the library does on disk (GR1): the folder of a graphic, its refs, work/ and versions, the
// copies, and the Trash. Real temp folders.

const ID = '0a1b2c3d4e5f';
const NEW_ID = 'f5e4d3c2b1a0';
let root: string;
let inbox: string;
let dataDir: string;
let home: string;
let folders: GraphicFolders;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-graphic-folders-'));
  inbox = join(root, 'inbox');
  dataDir = join(root, 'data');
  home = join(root, 'home');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(join(home, '.Trash'), { recursive: true });
  folders = new GraphicFolders({ inboxPath: inbox, dataDir, home });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const dir = (folder: string) => graphicDir(inbox, folder);
const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');

function sharedFont(name: string, content = name): void {
  const path = join(inbox, '_Fonts', name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A graphic folder with v1 (and v2 when asked), made the way a run's work/ becomes a version. */
async function graphicWithVersions(folder: string, versions: number): Promise<void> {
  await folders.create(folder);
  for (let version = 1; version <= versions; version += 1) {
    await folders.prepareWork(folder, {
      id: ID,
      fromVersion: version === 1 ? null : version - 1,
      lengthSec: 3,
    });
    writeCannedGraphic(graphicWorkDir(dir(folder)), ID, version);
    await folders.saveVersion(folder, version);
  }
}

describe('create, names and rename', () => {
  it('makes _Graphics/<folder>/ with an empty refs/, and refuses a folder that is there', async () => {
    await folders.create('Name on a white pill');

    expect(readdirSync(dir('Name on a white pill'))).toEqual(['refs']);
    await expect(folders.create('Name on a white pill')).rejects.toThrow();
  });

  it('lists the folders, leaving out the hidden ones, and knows which are there', async () => {
    expect(await folders.names()).toEqual([]);
    await folders.create('Beta');
    await folders.create('Alpha');
    await folders.stagingDir();

    expect((await folders.names()).sort()).toEqual(['Alpha', 'Beta']);
    expect(await folders.has('Alpha')).toBe(true);
    expect(await folders.has('Gamma')).toBe(false);
  });

  it('renames the folder, with what is in it', async () => {
    await graphicWithVersions('New graphic', 1);

    await folders.rename('New graphic', 'Name on a white pill');

    expect(existsSync(dir('New graphic'))).toBe(false);
    expect(existsSync(join(graphicVersionDir(dir('Name on a white pill'), 1), 'about.json'))).toBe(
      true,
    );
  });

  it('refuses to put a folder on top of another one, and takes a change of case alone', async () => {
    await folders.create('Alpha');
    await folders.create('Beta');
    await expect(folders.rename('Alpha', 'Beta')).rejects.toThrow(/already there/);
    expect(existsSync(dir('Alpha'))).toBe(true);

    await folders.rename('Alpha', 'ALPHA');
    expect((await folders.names()).sort()).toEqual(['ALPHA', 'Beta']);
  });

  it('discards a folder that was made and never used', async () => {
    await folders.create('Alpha');
    await folders.discard('Alpha');
    await folders.discard('Alpha');
    expect(await folders.has('Alpha')).toBe(false);
  });
});

describe('refs and uploads', () => {
  it('moves the staged files into refs/ under their names, numbering one that is taken', async () => {
    await folders.create('Alpha');
    const staging = await folders.stagingDir();
    expect(statSync(staging).isDirectory()).toBe(true);
    expect(dirname(staging)).toBe(join(inbox, '_Graphics'));

    const first = await folders.storeRefs('Alpha', [
      stagedFile(staging, 'logo.png', 'one', 0),
      stagedFile(staging, 'logo.png', 'two', 1),
    ]);
    const next = await folders.storeRefs('Alpha', [stagedFile(staging, 'logo.png', 'three', 2)]);

    expect(first).toEqual(['logo.png', 'logo (1).png']);
    expect(next).toEqual(['logo (2).png']);
    expect(readdirSync(graphicRefsDir(dir('Alpha'))).sort()).toEqual([
      'logo (1).png',
      'logo (2).png',
      'logo.png',
    ]);
    expect(read(graphicRefsDir(dir('Alpha')), 'logo (1).png')).toBe('two');
    expect(readdirSync(staging)).toEqual([]);
  });

  it('clears the upload folders a stopped engine left behind, but only the old ones', async () => {
    const old = await folders.stagingDir();
    const recent = await folders.stagingDir();
    const aWeekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    utimesSync(old, aWeekAgo, aWeekAgo);

    await folders.cleanStaging();

    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });
});

describe('work/ and versions', () => {
  it('makes a fresh work/ for v1: the host, GSAP and the shared fonts in fonts/', async () => {
    await folders.create('Alpha');
    sharedFont('Heebo-Bold.ttf', 'heebo');
    sharedFont('Rubik/Rubik.ttf', 'rubik');

    const fonts = await folders.prepareWork('Alpha', { id: ID, fromVersion: null, lengthSec: 3 });

    const work = graphicWorkDir(dir('Alpha'));
    expect(fonts).toEqual(['Heebo-Bold.ttf', 'Rubik/Rubik.ttf']);
    expect(readdirSync(work).sort()).toEqual(['index.html', 'vendor']);
    expect(read(work, 'index.html')).toContain(
      `data-composition-src="compositions/lib-${ID}.html"`,
    );
    expect(read(work, 'vendor', 'gsap.min.js')).toBe(readFileSync(GSAP_ASSET_PATH, 'utf8'));
    expect(read(graphicFontsDir(dir('Alpha')), 'Rubik', 'Rubik.ttf')).toBe('rubik');
  });

  it('has no fonts/ when there are no shared fonts, and a fresh copy each time', async () => {
    await folders.create('Alpha');
    expect(await folders.prepareWork('Alpha', { id: ID, fromVersion: null, lengthSec: 3 })).toEqual(
      [],
    );
    expect(existsSync(graphicFontsDir(dir('Alpha')))).toBe(false);

    sharedFont('Old.ttf');
    await folders.prepareWork('Alpha', { id: ID, fromVersion: null, lengthSec: 3 });
    rmSync(join(inbox, '_Fonts', 'Old.ttf'));
    sharedFont('New.ttf');
    await folders.prepareWork('Alpha', { id: ID, fromVersion: null, lengthSec: 3 });

    expect(readdirSync(graphicFontsDir(dir('Alpha')))).toEqual(['New.ttf']);
  });

  it('resets work/ from the newest version and throws away what a run left in it', async () => {
    await graphicWithVersions('Alpha', 1);
    const work = graphicWorkDir(dir('Alpha'));
    writeFileSync(join(work, 'half-done.txt'), 'a run that was stopped');
    writeFileSync(join(work, 'about.json'), 'changed');

    await folders.prepareWork('Alpha', { id: ID, fromVersion: 1, lengthSec: 3 });

    expect(existsSync(join(work, 'half-done.txt'))).toBe(false);
    expect(JSON.parse(read(work, 'about.json')).reply).toBe('Made v1.');
    expect(existsSync(join(work, 'compositions', `lib-${ID}.html`))).toBe(true);
  });

  it('fails to reset from a version that is not there', async () => {
    await folders.create('Alpha');
    await expect(folders.resetWork('Alpha', 4)).rejects.toThrow(/v4 is not/);
  });

  it('saves work/ as a version, leaving out the tools’ scratch, and never changes it after', async () => {
    await folders.create('Alpha');
    await folders.prepareWork('Alpha', { id: ID, fromVersion: null, lengthSec: 3 });
    const work = graphicWorkDir(dir('Alpha'));
    writeCannedGraphic(work, ID, 1);
    mkdirSync(join(work, '.hyperframes', 'artifacts', 'snapshots'), { recursive: true });
    writeFileSync(join(work, '.hyperframes', 'artifacts', 'snapshots', 'a.png'), 'png');
    mkdirSync(join(work, '.hyperframes', 'keep'), { recursive: true });
    writeFileSync(join(work, '.hyperframes', 'keep', 'history.json'), '{}');
    mkdirSync(join(work, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(work, '.DS_Store'), 'x');

    await folders.saveVersion('Alpha', 1);
    writeFileSync(join(work, 'about.json'), 'later change of work/');

    const version = graphicVersionDir(dir('Alpha'), 1);
    expect(existsSync(join(version, 'compositions', `lib-${ID}.html`))).toBe(true);
    expect(existsSync(join(version, 'vendor', 'gsap.min.js'))).toBe(true);
    expect(existsSync(join(version, '.hyperframes', 'keep', 'history.json'))).toBe(true);
    expect(existsSync(join(version, '.hyperframes', 'artifacts'))).toBe(false);
    expect(existsSync(join(version, 'node_modules'))).toBe(false);
    expect(existsSync(join(version, '.DS_Store'))).toBe(false);
    expect(JSON.parse(read(version, 'about.json')).reply).toBe('Made v1.');
    expect(readdirSync(join(dir('Alpha'), 'versions'))).toEqual(['v1']);
  });

  it('replaces the folder of an orphan version, left by a run the engine lost', async () => {
    await graphicWithVersions('Alpha', 1);
    writeFileSync(join(graphicVersionDir(dir('Alpha'), 1), 'orphan.txt'), 'x');
    writeCannedGraphic(graphicWorkDir(dir('Alpha')), ID, 1, { reply: 'Made it again.' });

    await folders.saveVersion('Alpha', 1);

    const version = graphicVersionDir(dir('Alpha'), 1);
    expect(existsSync(join(version, 'orphan.txt'))).toBe(false);
    expect(JSON.parse(read(version, 'about.json')).reply).toBe('Made it again.');
  });

  it('copies a version to a new number ("Use v1 again")', async () => {
    await graphicWithVersions('Alpha', 2);

    await folders.copyVersion('Alpha', 1, 3);

    const [v1, v3] = [1, 3].map((n) => graphicVersionDir(dir('Alpha'), n));
    expect(read(v3 as string, 'about.json')).toBe(read(v1 as string, 'about.json'));
    expect(read(v3 as string, 'lib', ID, 'fonts', 'Heebo-Bold.ttf')).toBe('font v1');
    expect(readdirSync(join(dir('Alpha'), 'versions')).sort()).toEqual(['v1', 'v2', 'v3']);
  });
});

describe('duplicate', () => {
  it('makes the copy’s v1 from the chosen version, under the copy’s own id', async () => {
    await graphicWithVersions('Alpha', 2);
    sharedFont('Heebo-Bold.ttf');

    await folders.duplicate('Alpha', 2, 'Alpha copy', { from: ID, to: NEW_ID });

    const copy = dir('Alpha copy');
    expect(readdirSync(copy).sort()).toEqual(['refs', 'versions']);
    expect(readdirSync(join(copy, 'versions'))).toEqual(['v1']);
    const v1 = graphicVersionDir(copy, 1);
    expect(existsSync(join(v1, 'compositions', `lib-${ID}.html`))).toBe(false);
    const composition = read(v1, 'compositions', `lib-${NEW_ID}.html`);
    expect(composition).toContain(`data-composition-id="lib-${NEW_ID}"`);
    expect(composition).toContain(`__timelines["lib-${NEW_ID}"]`);
    expect(composition).toContain(`url("lib/${NEW_ID}/fonts/Heebo-Bold.ttf")`);
    expect(composition).not.toContain(ID);
    expect(read(v1, 'lib', NEW_ID, 'fonts', 'Heebo-Bold.ttf')).toBe('font v2');
    expect(existsSync(join(v1, 'lib', ID))).toBe(false);
    expect(read(v1, 'index.html')).toContain(`lib-${NEW_ID}`);
    expect(read(v1, 'index.html')).not.toContain(ID);
    // the original is as it was
    expect(
      existsSync(join(graphicVersionDir(dir('Alpha'), 2), 'compositions', `lib-${ID}.html`)),
    ).toBe(true);
  });

  it('leaves no folder behind when the copy fails', async () => {
    await folders.create('Alpha');

    await expect(
      folders.duplicate('Alpha', 1, 'Alpha copy', { from: ID, to: NEW_ID }),
    ).rejects.toThrow(/v1 is not/);

    expect(await folders.has('Alpha copy')).toBe(false);
  });
});

describe('trash', () => {
  it('moves the folder into ~/.Trash under its name', async () => {
    await graphicWithVersions('Name on a white pill', 1);

    const trashed = await folders.trash('Name on a white pill');

    expect(trashed).toEqual({ where: join(home, '.Trash', 'Name on a white pill'), trashed: true });
    expect(existsSync(dir('Name on a white pill'))).toBe(false);
    expect(existsSync(join(trashed.where, 'versions', 'v1', 'about.json'))).toBe(true);
  });

  it('numbers the name when the Trash already has one, as Finder does', async () => {
    mkdirSync(join(home, '.Trash', 'Alpha'));
    mkdirSync(join(home, '.Trash', 'Alpha 2'));
    await folders.create('Alpha');

    expect((await folders.trash('Alpha')).where).toBe(join(home, '.Trash', 'Alpha 3'));
  });

  it('makes ~/.Trash when it is not there', async () => {
    rmSync(join(home, '.Trash'), { recursive: true });
    await folders.create('Alpha');

    expect((await folders.trash('Alpha')).trashed).toBe(true);
    expect(existsSync(join(home, '.Trash', 'Alpha'))).toBe(true);
  });

  it('keeps the folder in <data>/deleted-graphics/ when macOS will not take it, and says why', async () => {
    // A file where the Trash should be: nothing can be moved into it (as a refused permission).
    rmSync(join(home, '.Trash'), { recursive: true });
    writeFileSync(join(home, '.Trash'), 'not a folder');
    await graphicWithVersions('Alpha', 1);

    const trashed = await folders.trash('Alpha');

    expect(trashed.trashed).toBe(false);
    expect(trashed.where).toBe(join(dataDir, 'deleted-graphics', 'Alpha'));
    expect(trashed.reason).toBeTruthy();
    expect(existsSync(join(trashed.where, 'versions', 'v1', 'about.json'))).toBe(true);
    expect(existsSync(dir('Alpha'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'falls back when the Trash is a folder the engine may not write to (macOS’s refusal)',
    async () => {
      chmodSync(join(home, '.Trash'), 0o500);
      try {
        await folders.create('Alpha');
        mkdirSync(join(dataDir, 'deleted-graphics', 'Alpha'), { recursive: true });

        const trashed = await folders.trash('Alpha');

        expect(trashed.trashed).toBe(false);
        expect(trashed.where).toBe(join(dataDir, 'deleted-graphics', 'Alpha 2'));
        expect(readdirSync(join(home, '.Trash'))).toEqual([]);
      } finally {
        chmodSync(join(home, '.Trash'), 0o700);
      }
    },
  );

  it('throws when neither the Trash nor the data folder can take it', async () => {
    rmSync(join(home, '.Trash'), { recursive: true });
    writeFileSync(join(home, '.Trash'), 'not a folder');
    writeFileSync(dataDir, 'not a folder either');
    await folders.create('Alpha');

    await expect(folders.trash('Alpha')).rejects.toThrow();
    expect(await folders.has('Alpha')).toBe(true);
  });
});
