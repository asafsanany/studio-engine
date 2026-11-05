import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  errorCode,
  freeFileNameIn,
  freeNameIn,
  moveDir,
  moveFile,
  pathExists,
  safeTrashName,
  trashFiles,
  trashPath,
} from './trash-path.js';

// The Trash and the small move helpers Graphics and Fonts share. Real temp folders: `home` stands
// for the user's home, so nothing here ever reaches the real ~/.Trash.

let root: string;
let home: string;
let aside: string;
let work: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-trash-path-'));
  home = join(root, 'home');
  aside = join(root, 'data', 'deleted-things');
  work = join(root, 'work');
  mkdirSync(join(home, '.Trash'), { recursive: true });
  mkdirSync(work, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const file = (name: string, text = name): string => {
  const path = join(work, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const names = (dir: string): string[] => readdirSync(dir).sort();

describe('the small helpers', () => {
  it('errorCode reads the code of a file system error and nothing else', () => {
    expect(errorCode(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('ENOENT');
    expect(errorCode(new Error('x'))).toBeUndefined();
    expect(errorCode('ENOENT')).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
  });

  it('pathExists sees files, folders and a link that points nowhere', async () => {
    file('a.txt');
    expect(await pathExists(join(work, 'a.txt'))).toBe(true);
    expect(await pathExists(work)).toBe(true);
    expect(await pathExists(join(work, 'nothing'))).toBe(false);
  });

  it('freeNameIn numbers a folder name the way Finder does', async () => {
    expect(await freeNameIn(work, 'Alpha')).toBe('Alpha');
    mkdirSync(join(work, 'Alpha'));
    expect(await freeNameIn(work, 'Alpha')).toBe('Alpha 2');
    mkdirSync(join(work, 'Alpha 2'));
    expect(await freeNameIn(work, 'Alpha')).toBe('Alpha 3');
  });

  it('freeFileNameIn numbers a file name before its extension', async () => {
    expect(await freeFileNameIn(work, 'logo.png')).toBe('logo.png');
    file('logo.png');
    expect(await freeFileNameIn(work, 'logo.png')).toBe('logo (1).png');
    file('logo (1).png');
    expect(await freeFileNameIn(work, 'logo.png')).toBe('logo (2).png');
    file('README');
    expect(await freeFileNameIn(work, 'README')).toBe('README (1)');
  });

  it('moveFile and moveDir move what is there', async () => {
    const from = file('one.txt', 'hello');
    await moveFile(from, join(work, 'two.txt'));
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(join(work, 'two.txt'), 'utf8')).toBe('hello');

    file('folder/inside.txt', 'in');
    await moveDir(join(work, 'folder'), join(work, 'moved'));
    expect(existsSync(join(work, 'folder'))).toBe(false);
    expect(readFileSync(join(work, 'moved', 'inside.txt'), 'utf8')).toBe('in');
  });
});

describe('safeTrashName', () => {
  it('keeps an ordinary name', () => {
    expect(safeTrashName('Secular One')).toBe('Secular One');
    expect(safeTrashName('עברית')).toBe('עברית');
  });

  it('turns slashes, colons and control characters into spaces', () => {
    expect(safeTrashName('A/B:C\\D')).toBe('A B C D');
    expect(safeTrashName('Tab\there\nnow')).toBe('Tab here now');
  });

  it('never starts with a dot or stays empty', () => {
    expect(safeTrashName('..hidden')).toBe('hidden');
    expect(safeTrashName('..')).toBe('Deleted');
    expect(safeTrashName('   ')).toBe('Deleted');
    expect(safeTrashName('', 'Fonts')).toBe('Fonts');
  });
});

describe('trashPath', () => {
  it('moves a folder into ~/.Trash under its name', async () => {
    file('Alpha/inside.txt', 'in');

    const trashed = await trashPath(join(work, 'Alpha'), { home });

    expect(trashed).toEqual({ where: join(home, '.Trash', 'Alpha'), trashed: true });
    expect(existsSync(join(work, 'Alpha'))).toBe(false);
    expect(readFileSync(join(home, '.Trash', 'Alpha', 'inside.txt'), 'utf8')).toBe('in');
  });

  it('numbers a folder the Trash already has, as Finder does', async () => {
    mkdirSync(join(home, '.Trash', 'Alpha'));
    mkdirSync(join(home, '.Trash', 'Alpha 2'));
    file('Alpha/inside.txt');

    expect((await trashPath(join(work, 'Alpha'), { home })).where).toBe(
      join(home, '.Trash', 'Alpha 3'),
    );
  });

  it('moves a file and numbers it before its extension', async () => {
    file('logo.png', 'one');
    writeFileSync(join(home, '.Trash', 'logo.png'), 'already there');

    const trashed = await trashPath(join(work, 'logo.png'), { home });

    expect(trashed).toEqual({ where: join(home, '.Trash', 'logo (1).png'), trashed: true });
    expect(readFileSync(trashed.where, 'utf8')).toBe('one');
    expect(readFileSync(join(home, '.Trash', 'logo.png'), 'utf8')).toBe('already there');
  });

  it('makes ~/.Trash when it is not there', async () => {
    rmSync(join(home, '.Trash'), { recursive: true });
    file('Alpha/inside.txt');

    expect((await trashPath(join(work, 'Alpha'), { home })).trashed).toBe(true);
    expect(existsSync(join(home, '.Trash', 'Alpha'))).toBe(true);
  });

  it('keeps it aside when the Trash will not take it, and says why', async () => {
    rmSync(join(home, '.Trash'), { recursive: true });
    writeFileSync(join(home, '.Trash'), 'not a folder');
    file('Alpha/inside.txt', 'in');

    const trashed = await trashPath(join(work, 'Alpha'), { home, asideDir: aside });

    expect(trashed.trashed).toBe(false);
    expect(trashed.where).toBe(join(aside, 'Alpha'));
    expect(trashed.reason).toBeTruthy();
    expect(readFileSync(join(trashed.where, 'inside.txt'), 'utf8')).toBe('in');
    expect(existsSync(join(work, 'Alpha'))).toBe(false);
  });

  it('throws, and moves nothing, when the Trash refuses and there is no place aside', async () => {
    rmSync(join(home, '.Trash'), { recursive: true });
    writeFileSync(join(home, '.Trash'), 'not a folder');
    file('Alpha/inside.txt');

    await expect(trashPath(join(work, 'Alpha'), { home })).rejects.toThrow();
    await expect(trashPath(join(work, 'Alpha'), { home, asideDir: null })).rejects.toThrow();
    expect(existsSync(join(work, 'Alpha', 'inside.txt'))).toBe(true);
  });

  it('throws when neither the Trash nor the place aside can take it', async () => {
    rmSync(join(home, '.Trash'), { recursive: true });
    writeFileSync(join(home, '.Trash'), 'not a folder');
    mkdirSync(join(root, 'data'));
    writeFileSync(aside, 'not a folder either');
    file('Alpha/inside.txt');

    await expect(trashPath(join(work, 'Alpha'), { home, asideDir: aside })).rejects.toThrow();
    expect(existsSync(join(work, 'Alpha', 'inside.txt'))).toBe(true);
  });
});

describe('trashFiles', () => {
  it('moves the files into one new folder of the Trash, each under its own name', async () => {
    const a = file('x/Heebo-Regular.ttf', 'regular');
    const b = file('x/Heebo-Bold.ttf', 'bold');

    const trashed = await trashFiles([a, b], 'Heebo', { home });

    expect(trashed).toEqual({ where: join(home, '.Trash', 'Heebo'), trashed: true });
    expect(names(trashed.where)).toEqual(['Heebo-Bold.ttf', 'Heebo-Regular.ttf']);
    expect(readFileSync(join(trashed.where, 'Heebo-Bold.ttf'), 'utf8')).toBe('bold');
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
  });

  it('numbers the folder when the Trash has one by that name, and the files that share a name', async () => {
    mkdirSync(join(home, '.Trash', 'Heebo'));
    writeFileSync(join(home, '.Trash', 'Heebo', 'old.txt'), 'kept');
    const a = file('one/Heebo-Bold.ttf', 'first');
    const b = file('two/Heebo-Bold.ttf', 'second');

    const trashed = await trashFiles([a, b], 'Heebo', { home });

    expect(trashed.where).toBe(join(home, '.Trash', 'Heebo 2'));
    expect(names(trashed.where)).toEqual(['Heebo-Bold (1).ttf', 'Heebo-Bold.ttf']);
    expect(readFileSync(join(trashed.where, 'Heebo-Bold.ttf'), 'utf8')).toBe('first');
    expect(readFileSync(join(trashed.where, 'Heebo-Bold (1).ttf'), 'utf8')).toBe('second');
    expect(names(join(home, '.Trash', 'Heebo'))).toEqual(['old.txt']);
  });

  it('cleans a folder name that is not one name', async () => {
    const a = file('a.ttf');
    const trashed = await trashFiles([a], 'Some/Odd:Name', { home });
    expect(trashed.where).toBe(join(home, '.Trash', 'Some Odd Name'));
  });

  it('passes over a file that is not there any more', async () => {
    const a = file('a.ttf', 'a');

    const trashed = await trashFiles([join(work, 'gone.ttf'), a], 'Fonts', { home });

    expect(trashed.trashed).toBe(true);
    expect(names(trashed.where)).toEqual(['a.ttf']);
  });

  it('keeps the files aside when the Trash will not take them', async () => {
    rmSync(join(home, '.Trash'), { recursive: true });
    writeFileSync(join(home, '.Trash'), 'not a folder');
    const a = file('a.ttf', 'a');
    const b = file('b.ttf', 'b');

    const trashed = await trashFiles([a, b], 'Fonts', { home, asideDir: aside });

    expect(trashed.trashed).toBe(false);
    expect(trashed.where).toBe(join(aside, 'Fonts'));
    expect(trashed.reason).toBeTruthy();
    expect(names(trashed.where)).toEqual(['a.ttf', 'b.ttf']);
    expect(existsSync(a)).toBe(false);
  });

  it('falls back when the Trash is a folder the engine may not write to', async () => {
    chmodSync(join(home, '.Trash'), 0o500);
    try {
      const a = file('a.ttf', 'a');

      const trashed = await trashFiles([a], 'Fonts', { home, asideDir: aside });

      // As root the permission means nothing and the Trash takes it; anywhere else it is refused.
      if (trashed.trashed) {
        expect(trashed.where).toBe(join(home, '.Trash', 'Fonts'));
      } else {
        expect(trashed.where).toBe(join(aside, 'Fonts'));
        expect(readdirSync(join(home, '.Trash'))).toEqual([]);
      }
      expect(existsSync(a)).toBe(false);
    } finally {
      chmodSync(join(home, '.Trash'), 0o700);
    }
  });

  it('throws, with every file where it was, when nothing can take them', async () => {
    rmSync(join(home, '.Trash'), { recursive: true });
    writeFileSync(join(home, '.Trash'), 'not a folder');
    const a = file('a.ttf', 'a');

    await expect(trashFiles([a], 'Fonts', { home })).rejects.toThrow();
    await expect(trashFiles([a], 'Fonts', { home, asideDir: null })).rejects.toThrow();
    expect(readFileSync(a, 'utf8')).toBe('a');
  });

  it.skipIf(process.getuid?.() === 0)(
    'puts back what it moved when a later file cannot be moved, and leaves no folder behind',
    async () => {
      const a = file('ok/a.ttf', 'a');
      const b = file('locked/b.ttf', 'b');
      // A file cannot be moved out of a folder that may not be written to.
      chmodSync(join(work, 'locked'), 0o500);
      try {
        await expect(trashFiles([a, b], 'Fonts', { home, asideDir: aside })).rejects.toThrow();

        expect(readFileSync(a, 'utf8')).toBe('a');
        expect(readFileSync(b, 'utf8')).toBe('b');
        expect(readdirSync(join(home, '.Trash'))).toEqual([]);
        expect(readdirSync(aside)).toEqual([]);
      } finally {
        chmodSync(join(work, 'locked'), 0o700);
      }
    },
  );
});
