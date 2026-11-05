import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTE_ATTACHMENTS } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { makeTempDir } from '../test-temp.js';
import type { HeicToJpeg } from './heic-to-jpeg.js';
import { sipsHeicToJpeg } from './heic-to-jpeg.js';
import {
  jpegNameOf,
  NOTE_ATTACHMENT_MESSAGES,
  NoteAttachmentError,
  noteAttachmentsDir,
  saveNoteAttachment,
} from './note-attachments.js';

// A HEIC attached to a note is kept as a JPEG (Songs, SG6): the Brief run reads pictures with
// Claude's Read tool, which does not take HEIC. The converter is injected; one test runs the real
// `sips` on a tiny HEIC it makes itself (and is skipped where there is no `sips`).

const HEIC = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9, 0xff, 0xd9]);

/** A converter that writes `jpeg` and remembers what it was given. */
function fakeConverter(jpeg: Uint8Array = JPEG) {
  const seen: { from: string; to: string; fromBytes: Uint8Array }[] = [];
  const convert = vi.fn<HeicToJpeg>(async (from, to) => {
    seen.push({ from, to, fromBytes: new Uint8Array(readFileSync(from)) });
    writeFileSync(to, jpeg);
  });
  return { convert, seen };
}

const folder = (jobDir: string) => noteAttachmentsDir(jobDir);

describe('jpegNameOf', () => {
  it('swaps the extension, whatever its case, and keeps the rest of the name', () => {
    expect(jpegNameOf('IMG_4412.HEIC')).toBe('IMG_4412.jpg');
    expect(jpegNameOf('shot.heic')).toBe('shot.jpg');
    expect(jpegNameOf('צילום מסך.HEIC')).toBe('צילום מסך.jpg');
    expect(jpegNameOf('a.b.heic')).toBe('a.b.jpg');
  });
});

describe('saveNoteAttachment with a HEIC', () => {
  it('keeps the JPEG the converter made, under the name with .jpg', async () => {
    const jobDir = makeTempDir('studio-heic-');
    const { convert, seen } = fakeConverter();

    const kept = await saveNoteAttachment(
      jobDir,
      { name: 'IMG_4412.HEIC', bytes: HEIC },
      { heicToJpeg: convert },
    );

    expect(kept).toMatchObject({ name: 'IMG_4412.jpg', bytes: JPEG.length });
    expect(new Uint8Array(readFileSync(join(folder(jobDir), 'IMG_4412.jpg')))).toEqual(JPEG);
    // The converter was handed the HEIC as it came, in two dot files of the picture folder.
    expect(convert).toHaveBeenCalledOnce();
    expect(seen[0]?.fromBytes).toEqual(HEIC);
    expect(seen[0]?.from.startsWith(folder(jobDir))).toBe(true);
    expect(seen[0]?.to.startsWith(folder(jobDir))).toBe(true);
    // Nothing is left behind: not the HEIC, not the JPEG it was made into, not the partial file.
    expect(readdirSync(folder(jobDir))).toEqual(['IMG_4412.jpg']);
  });

  it('numbers the JPEG’s name when it is taken, as for any other picture', async () => {
    const jobDir = makeTempDir('studio-heic-');
    const { convert } = fakeConverter();
    await saveNoteAttachment(jobDir, { name: 'shot.png', bytes: JPEG });
    await saveNoteAttachment(jobDir, { name: 'shot.jpg', bytes: JPEG });
    const kept = await saveNoteAttachment(
      jobDir,
      { name: 'shot.heic', bytes: HEIC },
      { heicToJpeg: convert },
    );
    expect(kept.name).toBe('shot 2.jpg');
  });

  it('does not convert a picture that is not a HEIC', async () => {
    const jobDir = makeTempDir('studio-heic-');
    const { convert } = fakeConverter();
    for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.webp', 'e.gif']) {
      await saveNoteAttachment(jobDir, { name, bytes: JPEG }, { heicToJpeg: convert });
    }
    expect(convert).not.toHaveBeenCalled();
    expect(readdirSync(folder(jobDir)).sort()).toEqual([
      'a.png',
      'b.JPG',
      'c.jpeg',
      'd.webp',
      'e.gif',
    ]);
  });

  it('keeps a HEIC as it came when it has no converter (the tests’ harness)', async () => {
    const jobDir = makeTempDir('studio-heic-');
    const kept = await saveNoteAttachment(jobDir, { name: 'IMG.heic', bytes: HEIC });
    expect(kept.name).toBe('IMG.heic');
    expect(new Uint8Array(readFileSync(join(folder(jobDir), 'IMG.heic')))).toEqual(HEIC);
  });

  it('refuses a HEIC the converter cannot read, and keeps nothing', async () => {
    const jobDir = makeTempDir('studio-heic-');
    const convert = vi.fn<HeicToJpeg>(async () => {
      throw new Error('Cannot extract image from file.');
    });
    const failed = saveNoteAttachment(
      jobDir,
      { name: 'IMG.heic', bytes: HEIC },
      { heicToJpeg: convert },
    );
    await expect(failed).rejects.toBeInstanceOf(NoteAttachmentError);
    await expect(failed).rejects.toMatchObject({
      status: 400,
      message: NOTE_ATTACHMENT_MESSAGES.unreadable,
    });
    expect(readdirSync(folder(jobDir))).toEqual([]);
  });

  it('refuses one the converter “converted” into nothing', async () => {
    const jobDir = makeTempDir('studio-heic-');
    const { convert } = fakeConverter(new Uint8Array());
    await expect(
      saveNoteAttachment(jobDir, { name: 'IMG.heic', bytes: HEIC }, { heicToJpeg: convert }),
    ).rejects.toMatchObject({ status: 400, message: NOTE_ATTACHMENT_MESSAGES.unreadable });
    expect(readdirSync(folder(jobDir))).toEqual([]);
  });

  it('refuses a JPEG that comes out over the size limit', async () => {
    const jobDir = makeTempDir('studio-heic-');
    const { convert } = fakeConverter(new Uint8Array(NOTE_ATTACHMENTS.maxBytes + 1));
    await expect(
      saveNoteAttachment(jobDir, { name: 'IMG.heic', bytes: HEIC }, { heicToJpeg: convert }),
    ).rejects.toMatchObject({ status: 400, message: NOTE_ATTACHMENT_MESSAGES.tooBig });
    expect(readdirSync(folder(jobDir))).toEqual([]);
  });

  it('does not convert a seventh picture: the limit comes first', async () => {
    const jobDir = makeTempDir('studio-heic-');
    const { convert } = fakeConverter();
    for (let n = 0; n < NOTE_ATTACHMENTS.maxFiles; n += 1) {
      await saveNoteAttachment(jobDir, { name: `p${n}.png`, bytes: JPEG });
    }
    await expect(
      saveNoteAttachment(jobDir, { name: 'IMG.heic', bytes: HEIC }, { heicToJpeg: convert }),
    ).rejects.toMatchObject({ message: NOTE_ATTACHMENT_MESSAGES.tooMany });
    expect(convert).not.toHaveBeenCalled();
  });
});

// The real thing, on this Mac's own `sips`. The picture is a 24 × 40 PNG, written here and turned
// into a HEIC by sips itself; where sips cannot make one (not a Mac), the test has nothing to do.
const PNG_24X40 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAoCAIAAABrb60CAAAACXBIWXMAAAABAAAAAQBPJcTWAAAALElEQVR4nGM0SD3JQA3AQhVTRg0aNWjUoFGDRg0aNWjUoFGDRg0aNWhYGAQAJngB/ASjVbEAAAAASUVORK5CYII=',
  'base64',
);

function makeRealHeic(dir: string): Uint8Array | null {
  const png = join(dir, 'in.png');
  const heic = join(dir, 'out.heic');
  writeFileSync(png, PNG_24X40);
  try {
    execFileSync('sips', ['-s', 'format', 'heic', png, '--out', heic], { stdio: 'ignore' });
  } catch {
    return null;
  }
  return existsSync(heic) ? new Uint8Array(readFileSync(heic)) : null;
}

describe('sipsHeicToJpeg (the real converter)', () => {
  const work = makeTempDir('studio-heic-real-');
  const heic = makeRealHeic(work);

  it.skipIf(heic === null)('turns a real HEIC into a JPEG that is kept', async () => {
    const jobDir = makeTempDir('studio-heic-');
    const kept = await saveNoteAttachment(
      jobDir,
      { name: 'IMG_0001.HEIC', bytes: heic as Uint8Array },
      { heicToJpeg: sipsHeicToJpeg },
    );
    expect(kept.name).toBe('IMG_0001.jpg');
    const bytes = readFileSync(join(folder(jobDir), 'IMG_0001.jpg'));
    // A JPEG starts FF D8 FF.
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(readdirSync(folder(jobDir))).toEqual(['IMG_0001.jpg']);
  });

  it.skipIf(heic === null)('refuses bytes that are no picture at all', async () => {
    const jobDir = makeTempDir('studio-heic-');
    await expect(
      saveNoteAttachment(
        jobDir,
        { name: 'notes.heic', bytes: new TextEncoder().encode('just some words') },
        { heicToJpeg: sipsHeicToJpeg },
      ),
    ).rejects.toMatchObject({ status: 400, message: NOTE_ATTACHMENT_MESSAGES.unreadable });
    expect(readdirSync(folder(jobDir))).toEqual([]);
  });
});
