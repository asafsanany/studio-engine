import { spawnSync } from 'node:child_process';
import {
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
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isZipName,
  UNZIP_MAX_BYTES,
  UNZIP_MAX_FILES,
  UNZIPPED_PATH,
  UnzipError,
  unpackJobArchives,
} from './brief-unzip.js';
import { buildZip, type ZipEntrySpec } from './zip/test-utils.js';

// The zip reader on real temp folders, with archives built byte by byte (zip/test-utils.ts) so the
// tests can make the ones real tools refuse to write: `../x`, absolute paths, links, bombs.

let jobDir: string;

beforeEach(() => {
  jobDir = mkdtempSync(join(tmpdir(), 'studio-unzip-'));
});

afterEach(() => {
  rmSync(jobDir, { recursive: true, force: true });
});

/** Writes a zip into the job folder and answers the candidate the scanner would list. */
function zipAt(relPath: string, entries: readonly ZipEntrySpec[]) {
  const absPath = join(jobDir, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, buildZip(entries));
  return { relPath, absPath };
}

const unpacked = (relPath: string) => join(jobDir, UNZIPPED_PATH, relPath);

async function failure(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(UnzipError);
    return (error as Error).message;
  }
  throw new Error('expected the unzip to be refused');
}

describe('isZipName', () => {
  it('is any file called .zip, in any case', () => {
    expect(isZipName('refs.zip')).toBe(true);
    expect(isZipName('REFS.ZIP')).toBe(true);
    expect(isZipName('refs.zip.mp4')).toBe(false);
    expect(isZipName('zip')).toBe(false);
  });
});

describe('unpackJobArchives: what comes out', () => {
  it('unpacks stored and deflated files, nested folders and odd names into edit/brief/unzipped/<zip name>/', async () => {
    const zip = zipAt('pinewood-references.zip', [
      { name: 'WhatsApp Image 2026-10-15 at 15.12.21.jpeg', data: Buffer.alloc(300, 7) },
      { name: 'machine/', data: '' },
      {
        name: 'machine/squeegee.png',
        data: 'squeegee squeegee squeegee squeegee',
        method: 'store',
      },
      { name: 'תסריט/סצנה ראשונה.txt', data: 'שלום' },
      { name: 'empty.txt', data: '' },
    ]);

    const result = await unpackJobArchives(jobDir, [zip]);

    expect(result.zips).toEqual(['pinewood-references.zip']);
    expect(result.files.map((file) => file.relPath)).toEqual([
      'edit/brief/unzipped/pinewood-references/WhatsApp Image 2026-10-15 at 15.12.21.jpeg',
      'edit/brief/unzipped/pinewood-references/empty.txt',
      'edit/brief/unzipped/pinewood-references/machine/squeegee.png',
      'edit/brief/unzipped/pinewood-references/תסריט/סצנה ראשונה.txt',
    ]);
    expect(result.files.every((file) => file.fromZip === 'pinewood-references.zip')).toBe(true);
    expect(readFileSync(unpacked('pinewood-references/machine/squeegee.png'), 'utf8')).toBe(
      'squeegee squeegee squeegee squeegee',
    );
    expect(readFileSync(unpacked('pinewood-references/תסריט/סצנה ראשונה.txt'), 'utf8')).toBe(
      'שלום',
    );
    expect(readFileSync(unpacked('pinewood-references/empty.txt'), 'utf8')).toBe('');
    expect(
      readFileSync(unpacked('pinewood-references/WhatsApp Image 2026-10-15 at 15.12.21.jpeg')),
    ).toEqual(Buffer.alloc(300, 7));
    // The folder holds the files and the marker, nothing else.
    expect(readdirSync(unpacked('pinewood-references')).sort()).toEqual([
      '.unzipped.json',
      'WhatsApp Image 2026-10-15 at 15.12.21.jpeg',
      'empty.txt',
      'machine',
      'תסריט',
    ]);
    // The job folder itself is untouched: only edit/ was written.
    expect(readdirSync(jobDir).sort()).toEqual(['edit', 'pinewood-references.zip']);
  });

  it('gives each file its size, the CRC-32 of its content (8 hex digits), the entry date and its zip', async () => {
    const zip = zipAt('refs.zip', [
      { name: 'a.txt', data: 'hello', date: new Date(2026, 9, 15, 15, 12, 20) },
    ]);
    const { files } = await unpackJobArchives(jobDir, [zip]);

    expect(files).toEqual([
      {
        relPath: 'edit/brief/unzipped/refs/a.txt',
        absPath: unpacked('refs/a.txt'),
        size: 5,
        crc: crc32(Buffer.from('hello')).toString(16).padStart(8, '0'),
        mtimeMs: new Date(2026, 9, 15, 15, 12, 20).getTime(),
        fromZip: 'refs.zip',
      },
    ]);
    // The unpacked file carries the entry's date, so "newest wins" has something to compare.
    expect(statSync(unpacked('refs/a.txt')).mtimeMs).toBe(
      new Date(2026, 9, 15, 15, 12, 20).getTime(),
    );
  });

  it('unpacks a zip in a subfolder too, and gives two zips of one name two folders', async () => {
    const first = zipAt('refs.zip', [{ name: 'a.txt', data: 'one' }]);
    const second = zipAt('more/refs.zip', [{ name: 'a.txt', data: 'two' }]);

    const { files } = await unpackJobArchives(jobDir, [second, first]);

    expect(files.map((file) => [file.relPath, file.fromZip])).toEqual([
      ['edit/brief/unzipped/refs 2/a.txt', 'refs.zip'],
      ['edit/brief/unzipped/refs/a.txt', 'more/refs.zip'],
    ]);
    // The zips go in the order of their paths, so `more/refs.zip` is the first and gets `refs`.
    expect(readFileSync(unpacked('refs/a.txt'), 'utf8')).toBe('two');
    expect(readFileSync(unpacked('refs 2/a.txt'), 'utf8')).toBe('one');
  });

  it('leaves a job without a zip alone, and removes a folder left by a zip that is gone', async () => {
    const zip = zipAt('refs.zip', [{ name: 'a.txt', data: 'one' }]);
    await unpackJobArchives(jobDir, [zip]);
    expect(existsSync(unpacked('refs/a.txt'))).toBe(true);

    rmSync(zip.absPath);
    expect(await unpackJobArchives(jobDir, [])).toEqual({ zips: [], files: [] });
    expect(existsSync(join(jobDir, UNZIPPED_PATH))).toBe(false);
    // Nothing else was made either.
    expect(
      await unpackJobArchives(jobDir, [
        { relPath: 'notes.txt', absPath: join(jobDir, 'notes.txt') },
      ]),
    ).toEqual({
      zips: [],
      files: [],
    });
  });
});

describe('unpackJobArchives: junk is skipped', () => {
  it('skips __MACOSX, .DS_Store, AppleDouble files and other dot-names, and they do not count', async () => {
    const entries: ZipEntrySpec[] = [
      { name: 'logo.png', data: 'png' },
      { name: '__MACOSX/', data: '' },
      { name: '__MACOSX/._logo.png', data: 'junk' },
      { name: '.DS_Store', data: 'junk' },
      { name: 'machine/.DS_Store', data: 'junk' },
      { name: '._logo.png', data: 'junk' },
      { name: '.hidden/secret.txt', data: 'junk' },
      { name: 'photo.jpg.crdownload', data: 'junk' },
    ];
    const zip = zipAt('refs.zip', entries);

    const { files } = await unpackJobArchives(jobDir, [zip]);

    expect(files.map((file) => file.relPath)).toEqual(['edit/brief/unzipped/refs/logo.png']);
    expect(readdirSync(unpacked('refs')).sort()).toEqual(['.unzipped.json', 'logo.png']);
  });

  it('does not count junk toward the caps', async () => {
    const entries: ZipEntrySpec[] = [
      { name: 'a.txt', data: 'a' },
      ...Array.from(
        { length: UNZIP_MAX_FILES + 20 },
        (_, i): ZipEntrySpec => ({
          name: `__MACOSX/._${i}.txt`,
          data: 'x',
        }),
      ),
    ];
    const { files } = await unpackJobArchives(jobDir, [zipAt('refs.zip', entries)]);
    expect(files).toHaveLength(1);
  });
});

describe('unpackJobArchives: what is refused', () => {
  it('refuses a name that climbs out of the folder, and writes nothing', async () => {
    const zip = zipAt('refs.zip', [
      { name: 'ok.txt', data: 'ok' },
      { name: '../../outside.txt', data: 'gotcha' },
    ]);
    const message = await failure(unpackJobArchives(jobDir, [zip]));
    expect(message).toBe(
      'the zip “refs.zip” has a file that would land outside its folder (“../../outside.txt”).',
    );
    expect(existsSync(join(jobDir, 'outside.txt'))).toBe(false);
    expect(existsSync(join(dirname(jobDir), 'outside.txt'))).toBe(false);
    // Not even the file before it: no half-unpacked zip.
    expect(existsSync(join(jobDir, UNZIPPED_PATH))).toBe(false);
  });

  it('refuses climbing in the middle of a path and with backslashes', async () => {
    for (const name of ['a/../../x.txt', 'a\\..\\..\\x.txt', '..', 'a/b/../../../x.txt']) {
      const zip = zipAt('refs.zip', [{ name, data: 'x' }]);
      expect(await failure(unpackJobArchives(jobDir, [zip])), name).toContain(
        'land outside its folder',
      );
    }
  });

  it('refuses an absolute path, a drive letter, and a name with a NUL', async () => {
    for (const name of ['/etc/passwd', '/tmp/x.txt', 'C:\\Windows\\x.txt', 'C:/x.txt']) {
      const zip = zipAt('refs.zip', [{ name, data: 'x' }]);
      expect(await failure(unpackJobArchives(jobDir, [zip])), name).toBe(
        `the zip “refs.zip” has a file with an absolute path (“${name}”).`,
      );
    }
    const nul = zipAt('refs.zip', [{ name: 'a\0b.txt', data: 'x' }]);
    expect(await failure(unpackJobArchives(jobDir, [nul]))).toContain('a name that can’t be used');
  });

  it('refuses a symlink, and any file that is not a plain file', async () => {
    const link = zipAt('refs.zip', [{ name: 'passwd', data: '/etc/passwd', mode: 0o120755 }]);
    expect(await failure(unpackJobArchives(jobDir, [link]))).toBe(
      'the zip “refs.zip” has a link inside (“passwd”), which isn’t unpacked.',
    );
    const fifo = zipAt('refs.zip', [{ name: 'pipe', data: '', mode: 0o010644 }]);
    expect(await failure(unpackJobArchives(jobDir, [fifo]))).toContain(
      'something that isn’t a plain file',
    );
    expect(existsSync(unpacked('refs'))).toBe(false);
  });

  it('refuses a link even inside a junk folder', async () => {
    const zip = zipAt('refs.zip', [{ name: '__MACOSX/link', data: 'x', mode: 0o120755 }]);
    expect(await failure(unpackJobArchives(jobDir, [zip]))).toContain('has a link inside');
  });

  it('refuses a password-protected entry, a compression it cannot read, and the same file twice', async () => {
    expect(
      await failure(
        unpackJobArchives(jobDir, [zipAt('a.zip', [{ name: 'x.txt', data: 'x', flags: 1 }])]),
      ),
    ).toBe('the zip “a.zip” is password protected.');
    expect(
      await failure(
        unpackJobArchives(jobDir, [
          zipAt('a.zip', [{ name: 'x.txt', data: 'x', methodNumber: 99 }]),
        ]),
      ),
    ).toBe('the zip “a.zip” uses a compression this app can’t unpack (“x.txt”).');
    expect(
      await failure(
        unpackJobArchives(jobDir, [
          zipAt('a.zip', [
            { name: 'Photo.jpg', data: 'x' },
            { name: 'photo.JPG', data: 'y' },
          ]),
        ]),
      ),
    ).toBe('the zip “a.zip” has the file “photo.JPG” twice.');
  });

  it('refuses a file that is not a zip, a cut-off zip and a zip with a lying header', async () => {
    writeFileSync(join(jobDir, 'fake.zip'), 'this is not a zip at all, just words in a file');
    expect(
      await failure(
        unpackJobArchives(jobDir, [{ relPath: 'fake.zip', absPath: join(jobDir, 'fake.zip') }]),
      ),
    ).toBe('the zip “fake.zip” is damaged or isn’t a zip.');

    const whole = buildZip([{ name: 'a.txt', data: 'hello hello hello hello' }]);
    writeFileSync(join(jobDir, 'cut.zip'), whole.subarray(0, whole.length - 30));
    expect(
      await failure(
        unpackJobArchives(jobDir, [{ relPath: 'cut.zip', absPath: join(jobDir, 'cut.zip') }]),
      ),
    ).toBe('the zip “cut.zip” is damaged or isn’t a zip.');
  });

  it('stops an entry that inflates past the size it declared (a zip bomb) and cleans up', async () => {
    const zip = zipAt('bomb.zip', [
      { name: 'big.bin', data: Buffer.alloc(5_000_000, 0), claimedSize: 10 },
    ]);
    expect(await failure(unpackJobArchives(jobDir, [zip]))).toBe('the zip “bomb.zip” is damaged.');
    expect(readdirSync(join(jobDir, UNZIPPED_PATH))).toEqual([]);
  });

  it('refuses an entry whose bytes do not match its CRC', async () => {
    const good = buildZip([{ name: 'a.txt', data: 'hello', method: 'store' }]);
    const bad = Buffer.from(good);
    bad[bad.indexOf('hello')] = 'J'.charCodeAt(0); // "Jello": the stored bytes changed, the CRC did not
    writeFileSync(join(jobDir, 'bad.zip'), bad);
    expect(
      await failure(
        unpackJobArchives(jobDir, [{ relPath: 'bad.zip', absPath: join(jobDir, 'bad.zip') }]),
      ),
    ).toBe('the zip “bad.zip” is damaged.');
  });
});

describe('unpackJobArchives: the caps', () => {
  const many = (count: number): ZipEntrySpec[] =>
    Array.from({ length: count }, (_, i) => ({ name: `f${i}.txt`, data: `file ${i}` }));

  it(`takes ${UNZIP_MAX_FILES} files and refuses ${UNZIP_MAX_FILES + 1}`, async () => {
    const ok = await unpackJobArchives(jobDir, [zipAt('refs.zip', many(UNZIP_MAX_FILES))]);
    expect(ok.files).toHaveLength(UNZIP_MAX_FILES);

    const message = await failure(
      unpackJobArchives(jobDir, [zipAt('big.zip', many(UNZIP_MAX_FILES + 1))]),
    );
    expect(message).toBe('the zip “big.zip” has more than 500 files (500 is the most).');
    // The refusal leaves nothing from this zip behind.
    expect(existsSync(unpacked('big'))).toBe(false);
  });

  it('counts the files of all the zips together', async () => {
    const a = zipAt('a.zip', many(300));
    const b = zipAt('b.zip', many(201));
    expect(await failure(unpackJobArchives(jobDir, [a, b]))).toBe(
      'the zips in this folder have more than 500 files together (500 is the most).',
    );
  });

  it('refuses more than 200 MB once unpacked, from the headers, before it writes anything', async () => {
    const zip = zipAt('big.zip', [
      { name: 'a.mp4', data: 'x', claimedSize: UNZIP_MAX_BYTES - 5, method: 'store' },
      { name: 'b.mp4', data: 'y', claimedSize: 6, method: 'store' },
    ]);
    expect(await failure(unpackJobArchives(jobDir, [zip]))).toBe(
      'the zip “big.zip” is bigger than 200 MB once unpacked (200 MB is the most).',
    );
    expect(existsSync(join(jobDir, UNZIPPED_PATH))).toBe(false);
  });

  it('counts the bytes of all the zips together', async () => {
    const a = zipAt('a.zip', [
      { name: 'a.mp4', data: 'x', claimedSize: 150_000_000, method: 'store' },
    ]);
    const b = zipAt('b.zip', [
      { name: 'b.mp4', data: 'y', claimedSize: 60_000_000, method: 'store' },
    ]);
    expect(await failure(unpackJobArchives(jobDir, [a, b]))).toBe(
      'the zips in this folder are bigger than 200 MB once unpacked together (200 MB is the most).',
    );
  });
});

describe('unpackJobArchives: again, on Retry and Resume', () => {
  it('does not unpack a zip a second time, and gives the same files back', async () => {
    const zip = zipAt('refs.zip', [
      { name: 'a.txt', data: 'aaaa' },
      { name: 'b.txt', data: 'bbbb' },
    ]);
    const first = await unpackJobArchives(jobDir, [zip]);

    // Same size, other bytes: proof that nothing was written again.
    writeFileSync(unpacked('refs/a.txt'), 'ZZZZ');
    const second = await unpackJobArchives(jobDir, [zip]);

    expect(second).toEqual(first);
    expect(readFileSync(unpacked('refs/a.txt'), 'utf8')).toBe('ZZZZ');
  });

  it('unpacks again when an unpacked file is gone or has another size', async () => {
    const zip = zipAt('refs.zip', [{ name: 'a.txt', data: 'aaaa' }]);
    await unpackJobArchives(jobDir, [zip]);

    rmSync(unpacked('refs/a.txt'));
    await unpackJobArchives(jobDir, [zip]);
    expect(readFileSync(unpacked('refs/a.txt'), 'utf8')).toBe('aaaa');

    writeFileSync(unpacked('refs/a.txt'), 'much longer than before');
    await unpackJobArchives(jobDir, [zip]);
    expect(readFileSync(unpacked('refs/a.txt'), 'utf8')).toBe('aaaa');
  });

  it('unpacks again when the zip changed to the same size and date: the CRCs in it say so', async () => {
    const date = new Date(2026, 9, 25, 12, 52, 0);
    const zip = zipAt('refs.zip', [{ name: 'a.txt', data: 'aaaa', date, method: 'store' }]);
    const before = await unpackJobArchives(jobDir, [zip]);
    const stamp = statSync(zip.absPath);

    // Other bytes, same length, same date: nothing a size-and-date check could tell apart.
    zipAt('refs.zip', [{ name: 'a.txt', data: 'bbbb', date, method: 'store' }]);
    utimesSync(zip.absPath, stamp.atime, stamp.mtime);
    expect(statSync(zip.absPath).size).toBe(stamp.size);
    expect(Math.abs(statSync(zip.absPath).mtimeMs - stamp.mtimeMs)).toBeLessThan(2);

    const after = await unpackJobArchives(jobDir, [zip]);

    expect(readFileSync(unpacked('refs/a.txt'), 'utf8')).toBe('bbbb');
    expect(after.files[0]).toMatchObject({ relPath: before.files[0]?.relPath, size: 4 });
    expect(after.files[0]?.crc).not.toBe(before.files[0]?.crc);
  });

  it('removes the staging folder a stopped run left behind', async () => {
    mkdirSync(join(jobDir, UNZIPPED_PATH, '.refs.unzipping'), { recursive: true });
    writeFileSync(join(jobDir, UNZIPPED_PATH, '.refs.unzipping', 'half.txt'), 'half');
    const zip = zipAt('refs.zip', [{ name: 'a.txt', data: 'aaaa' }]);
    await unpackJobArchives(jobDir, [zip]);
    expect(readdirSync(join(jobDir, UNZIPPED_PATH))).toEqual(['refs']);
  });
});

// The zips real tools make: Info-ZIP's `zip` (what most people use) and macOS' `ditto`, which is
// what Finder's Compress does and which adds __MACOSX entries.
const hasZip = existsSync('/usr/bin/zip');
const hasDitto = existsSync('/usr/bin/ditto');

describe.skipIf(!hasZip)('unpackJobArchives: a zip made by /usr/bin/zip', () => {
  it('unpacks it, folders and Hebrew names included', async () => {
    const source = mkdtempSync(join(tmpdir(), 'studio-unzip-src-'));
    try {
      mkdirSync(join(source, 'machine'), { recursive: true });
      writeFileSync(join(source, 'machine', 'squeegee.txt'), 'squeegee '.repeat(200));
      writeFileSync(join(source, 'תסריט.txt'), 'שלום עולם');
      writeFileSync(join(source, '.DS_Store'), 'junk');
      const made = spawnSync('/usr/bin/zip', ['-qr', join(jobDir, 'real.zip'), '.'], {
        cwd: source,
      });
      expect(made.status).toBe(0);

      const { files } = await unpackJobArchives(jobDir, [
        { relPath: 'real.zip', absPath: join(jobDir, 'real.zip') },
      ]);
      expect(files.map((file) => file.relPath).sort()).toEqual([
        'edit/brief/unzipped/real/machine/squeegee.txt',
        'edit/brief/unzipped/real/תסריט.txt',
      ]);
      expect(readFileSync(unpacked('real/machine/squeegee.txt'), 'utf8')).toBe(
        'squeegee '.repeat(200),
      );
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasDitto)(
  'unpackJobArchives: a zip made by macOS ditto (Finder → Compress)',
  () => {
    it('skips the __MACOSX entries and unpacks the files', async () => {
      const source = mkdtempSync(join(tmpdir(), 'studio-unzip-src-'));
      try {
        mkdirSync(join(source, 'refs'), { recursive: true });
        writeFileSync(join(source, 'refs', 'logo.png'), 'png '.repeat(100));
        const made = spawnSync('/usr/bin/ditto', [
          '-c',
          '-k',
          '--sequesterRsrc',
          '--keepParent',
          join(source, 'refs'),
          join(jobDir, 'Archive.zip'),
        ]);
        expect(made.status).toBe(0);

        const { files } = await unpackJobArchives(jobDir, [
          { relPath: 'Archive.zip', absPath: join(jobDir, 'Archive.zip') },
        ]);
        expect(files.map((file) => file.relPath)).toEqual([
          'edit/brief/unzipped/Archive/refs/logo.png',
        ]);
      } finally {
        rmSync(source, { recursive: true, force: true });
      }
    });
  },
);
