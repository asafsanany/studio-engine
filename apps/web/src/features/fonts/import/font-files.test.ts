import { describe, expect, it } from 'vitest';
import { fontStageForm } from '@/data/fonts-api';
import { type EntryLike, fontFilesOf, isFontFileName, readDroppedFiles } from './font-files';

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

describe('isFontFileName', () => {
  it('takes the four formats and a collection, in any case, and nothing else', () => {
    for (const name of ['A.ttf', 'A.OTF', 'A.woff', 'A.WOFF2', 'Helvetica.ttc', 'A.otc']) {
      expect(isFontFileName(name)).toBe(true);
    }
    for (const name of ['README.md', 'OFL.txt', '.DS_Store', 'ttf', 'Heebo.ttf.zip']) {
      expect(isFontFileName(name)).toBe(false);
    }
  });
});

describe('fontFilesOf', () => {
  it('keeps the fonts of a folder and drops the licence, the .DS_Store and the ._ copies beside them', () => {
    const files = [
      file('Heebo-Bold.ttf'),
      file('OFL.txt'),
      file('Heebo-Light.otf'),
      file('.DS_Store'),
      file('._Heebo-Bold.ttf'),
    ];
    expect(fontFilesOf(files).map((one) => one.name)).toEqual([
      'Heebo-Bold.ttf',
      'Heebo-Light.otf',
    ]);
  });
});

describe('readDroppedFiles', () => {
  it('opens a dropped folder, flattening what is below it and keeping only the fonts', async () => {
    const transfer = {
      types: ['Files'],
      files: [file('Fonts')],
      items: [
        item(
          folderEntry(
            'Fonts',
            [
              fileEntry('Heebo-Bold.ttf'),
              fileEntry('OFL.txt'),
              folderEntry('Rubik', [fileEntry('Rubik-Light.woff2')]),
            ],
            [fileEntry('Karantina-Bold.OTF')],
          ),
        ),
      ],
    };
    const dropped = await readDroppedFiles(transfer);
    expect(dropped.files.map((one) => one.name)).toEqual([
      'Fonts/Heebo-Bold.ttf',
      'Fonts/Rubik/Rubik-Light.woff2',
      'Fonts/Karantina-Bold.OTF',
    ]);
    expect(dropped.sawFolder).toBe(true);
  });

  it('names a file of a folder by its path, so two Regular.ttf of two families stay apart', async () => {
    const transfer = {
      types: ['Files'],
      files: [file('Fonts')],
      items: [
        item(
          folderEntry('Fonts', [
            folderEntry('Heebo', [fileEntry('Regular.ttf')]),
            folderEntry('Rubik', [fileEntry('Regular.ttf')]),
          ]),
        ),
      ],
    };
    const dropped = await readDroppedFiles(transfer);
    expect(dropped.files.map((one) => one.name)).toEqual([
      'Fonts/Heebo/Regular.ttf',
      'Fonts/Rubik/Regular.ttf',
    ]);
    // The upload sends that name, like a picked folder's relative path.
    const sent = fontStageForm(dropped.files).getAll('files[]') as File[];
    expect(sent.map((one) => one.name)).toEqual([
      'Fonts/Heebo/Regular.ttf',
      'Fonts/Rubik/Regular.ttf',
    ]);
  });

  it('keeps the bytes of a file it renames', async () => {
    const heebo = new File(['abc'], 'Heebo-Bold.ttf', { lastModified: 1_700_000_000_000 });
    const entry: EntryLike = {
      isFile: true,
      isDirectory: false,
      name: 'Heebo-Bold.ttf',
      file: (success) => success(heebo),
    };
    const transfer = {
      types: ['Files'],
      files: [file('Fonts')],
      items: [item(folderEntry('Fonts', [entry]))],
    };
    const [renamed] = (await readDroppedFiles(transfer)).files;
    expect(renamed?.name).toBe('Fonts/Heebo-Bold.ttf');
    expect(renamed?.size).toBe(3);
    expect(renamed?.lastModified).toBe(1_700_000_000_000);
    expect(await renamed?.text()).toBe('abc');
  });

  it('keeps every file dropped one by one, so the engine can say why a .txt is no font', async () => {
    const transfer = {
      types: ['Files'],
      files: [file('Heebo-Bold.ttf'), file('notes.txt')],
      items: [item(fileEntry('Heebo-Bold.ttf')), item(fileEntry('notes.txt'))],
    };
    const dropped = await readDroppedFiles(transfer);
    expect(dropped.files.map((one) => one.name)).toEqual(['Heebo-Bold.ttf', 'notes.txt']);
    expect(dropped.sawFolder).toBe(false);
  });

  it('mixes files and folders in the order they were dropped', async () => {
    const transfer = {
      types: ['Files'],
      files: [file('Heebo-Bold.ttf'), file('Rubik')],
      items: [
        item(fileEntry('Heebo-Bold.ttf')),
        item(folderEntry('Rubik', [fileEntry('Rubik-Bold.ttf')])),
      ],
    };
    const dropped = await readDroppedFiles(transfer);
    expect(dropped.files.map((one) => one.name)).toEqual([
      'Heebo-Bold.ttf',
      'Rubik/Rubik-Bold.ttf',
    ]);
  });

  it('is empty, and saw a folder, for a folder with no fonts in it', async () => {
    const transfer = {
      types: ['Files'],
      files: [file('Docs')],
      items: [item(folderEntry('Docs', [fileEntry('README.md')]))],
    };
    expect(await readDroppedFiles(transfer)).toEqual({ files: [], sawFolder: true });
  });

  it('falls back to the plain file list when the entries cannot be read', async () => {
    const files = [file('A.ttf'), file('B.ttf')];
    expect((await readDroppedFiles({ types: ['Files'], files })).files).toEqual(files);
    const noEntries = { types: ['Files'], files, items: [item(null), item(null)] };
    expect((await readDroppedFiles(noEntries)).files).toEqual(files);
  });

  it('skips a file that cannot be read', async () => {
    const broken: EntryLike = {
      isFile: true,
      isDirectory: false,
      name: 'A.ttf',
      file: (_success, failure) => failure?.(new Error('gone')),
    };
    const transfer = { types: ['Files'], files: [file('A.ttf')], items: [item(broken)] };
    expect((await readDroppedFiles(transfer)).files).toEqual([]);
  });
});
