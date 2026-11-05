import { describe, expect, it } from 'vitest';
import { type EntryLike, isLutFileName, lutFilesOf, readDroppedFiles } from './lut-files';

const file = (name: string) => new File(['x'], name);

/** A dropped file as `webkitGetAsEntry` gives it. */
const fileEntry = (name: string): EntryLike => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (success) => success(file(name)),
});

/** A dropped folder whose reader hands out `batches` one `readEntries` call at a time. */
const folderEntry = (name: string, ...batches: EntryLike[][]): EntryLike => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    const queue = [...batches];
    return { readEntries: (success) => success(queue.shift() ?? []) };
  },
});

const item = (entry: EntryLike | null) => ({ webkitGetAsEntry: () => entry });

describe('isLutFileName', () => {
  it('takes .cube and .3dl in any case, and nothing else', () => {
    expect(isLutFileName('Golden.cube')).toBe(true);
    expect(isLutFileName('GOLDEN.CUBE')).toBe(true);
    expect(isLutFileName('film.3dl')).toBe(true);
    expect(isLutFileName('README.md')).toBe(false);
    expect(isLutFileName('.DS_Store')).toBe(false);
    expect(isLutFileName('cube')).toBe(false);
  });
});

describe('lutFilesOf', () => {
  it('keeps the LUTs of a folder and drops the READMEs beside them', () => {
    const files = [file('a.cube'), file('README.md'), file('b.3dl'), file('.DS_Store')];
    expect(lutFilesOf(files).map((one) => one.name)).toEqual(['a.cube', 'b.3dl']);
  });
});

describe('readDroppedFiles', () => {
  it('opens a dropped folder, flattening what is below it and keeping only the LUTs', async () => {
    const transfer = {
      types: ['Files'],
      files: [file('Looks')],
      items: [
        item(
          folderEntry(
            'Looks',
            [
              fileEntry('a.cube'),
              fileEntry('README.md'),
              folderEntry('Camera', [fileEntry('b.3dl')]),
            ],
            [fileEntry('c.CUBE')],
          ),
        ),
      ],
    };
    const dropped = await readDroppedFiles(transfer);
    expect(dropped.files.map((one) => one.name)).toEqual(['a.cube', 'b.3dl', 'c.CUBE']);
    expect(dropped.sawFolder).toBe(true);
  });

  it('keeps every file dropped one by one, so the engine can say why a .txt is no LUT', async () => {
    const transfer = {
      types: ['Files'],
      files: [file('a.cube'), file('notes.txt')],
      items: [item(fileEntry('a.cube')), item(fileEntry('notes.txt'))],
    };
    const dropped = await readDroppedFiles(transfer);
    expect(dropped.files.map((one) => one.name)).toEqual(['a.cube', 'notes.txt']);
    expect(dropped.sawFolder).toBe(false);
  });

  it('mixes files and folders in the order they were dropped', async () => {
    const transfer = {
      types: ['Files'],
      files: [file('a.cube'), file('Looks')],
      items: [item(fileEntry('a.cube')), item(folderEntry('Looks', [fileEntry('b.cube')]))],
    };
    const dropped = await readDroppedFiles(transfer);
    expect(dropped.files.map((one) => one.name)).toEqual(['a.cube', 'b.cube']);
  });

  it('is empty, and saw a folder, for a folder with no LUTs in it', async () => {
    const transfer = {
      types: ['Files'],
      files: [file('Docs')],
      items: [item(folderEntry('Docs', [fileEntry('README.md')]))],
    };
    expect(await readDroppedFiles(transfer)).toEqual({ files: [], sawFolder: true });
  });

  it('falls back to the plain file list when the entries cannot be read', async () => {
    const files = [file('a.cube'), file('b.cube')];
    expect((await readDroppedFiles({ types: ['Files'], files })).files).toEqual(files);
    const noEntries = { types: ['Files'], files, items: [item(null), item(null)] };
    expect((await readDroppedFiles(noEntries)).files).toEqual(files);
  });

  it('skips a file that cannot be read', async () => {
    const broken: EntryLike = {
      isFile: true,
      isDirectory: false,
      name: 'a.cube',
      file: (_success, failure) => failure?.(new Error('gone')),
    };
    const transfer = { types: ['Files'], files: [file('a.cube')], items: [item(broken)] };
    expect((await readDroppedFiles(transfer)).files).toEqual([]);
  });
});
