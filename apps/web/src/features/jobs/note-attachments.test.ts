import { NOTE_ATTACHMENTS, type NoteAttachment } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  ATTACHMENTS_TEXT,
  attachmentLine,
  createNoteAttachments,
  fileSizeText,
  hasInstagramReelLink,
  isPictureFile,
  type NoteAttachmentsDeps,
  pictureFilesFromClipboard,
  takePastedPictures,
  uploadName,
  wasConverted,
} from './note-attachments';

// The pictures of "Note for the editor" (Songs, SG5): what a file is, what the clipboard holds, and
// the controller that sends, lists, removes and cleans up, with a stand-in for the engine.

const png = (name = 'IMG_4412.PNG', type = 'image/png') =>
  new File([new Uint8Array(16)], name, { type });

/** A picture the note had before the dialog opened. */
const earlierPicture = (name: string): NoteAttachment => ({
  name,
  bytes: 1,
  addedAt: '2026-10-24T10:00:00.000Z',
});

/** A File that says it is `size` bytes without holding them (the 15 MB limit is not worth 15 MB). */
function fileOf(name: string, size: number, type = 'image/png'): File {
  const file = new File([new Uint8Array(4)], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('fileSizeText and attachmentLine', () => {
  it('writes sizes in decimal units, as the board does', () => {
    expect(
      [0, 999, 1_000, 1_234, 45_678, 1_200_000, 12_345_678, 15 * 1024 * 1024].map(fileSizeText),
    ).toEqual(['0 bytes', '999 bytes', '1 KB', '1.2 KB', '46 KB', '1.2 MB', '12 MB', '16 MB']);
  });

  it('says “Screenshot · 1.2 MB · pasted” for a picture of this opening, and no “how” for an earlier one', () => {
    expect(attachmentLine({ bytes: 1_200_000, from: 'pasted' })).toBe(
      'Screenshot · 1.2 MB · pasted',
    );
    expect(attachmentLine({ bytes: 1_200_000, from: 'dropped' })).toBe(
      'Screenshot · 1.2 MB · dropped',
    );
    expect(attachmentLine({ bytes: 1_200_000, from: 'chosen' })).toBe(
      'Screenshot · 1.2 MB · chosen',
    );
    expect(attachmentLine({ bytes: 1_200_000, from: 'earlier' })).toBe('Screenshot · 1.2 MB');
  });
});

describe('hasInstagramReelLink', () => {
  it.each([
    'Yael wants the song from this reel: https://www.instagram.com/reel/DQx7mK2kF9a/',
    'instagram.com/reels/DQx7mK2kF9a',
    'https://instagram.com/yael.cohen/reel/C8abc_12-x/?igsh=abc',
    'תשתמש בשיר מ https://www.INSTAGRAM.com/reel/DQx7mK2kF9a/ בבקשה',
  ])('sees a reel link in %s', (text) => {
    expect(hasInstagramReelLink(text)).toBe(true);
  });

  it.each([
    '',
    'Keep it under 30 seconds.',
    'https://www.instagram.com/yael.cohen/',
    'https://www.instagram.com/reel/',
    'https://example.com/reel/DQx7mK2kF9a',
    'instagram reel',
  ])('does not see one in %j', (text) => {
    expect(hasInstagramReelLink(text)).toBe(false);
  });
});

describe('what a file is', () => {
  it('gives a file without an extension the one its type says, and never an empty name', () => {
    expect(uploadName({ name: 'blob', type: 'image/png' })).toBe('blob.png');
    expect(uploadName({ name: 'photo', type: 'image/jpeg' })).toBe('photo.jpg');
    expect(uploadName({ name: 'IMG_4412.PNG', type: 'image/png' })).toBe('IMG_4412.PNG');
    expect(uploadName({ name: '', type: 'image/png' })).toBe('image.png');
    expect(uploadName({ name: 'notes', type: '' })).toBe('notes');
  });

  it('knows a picture by its extension or its type, and nothing else', () => {
    expect(isPictureFile({ name: 'a.heic', type: '' })).toBe(true);
    expect(isPictureFile({ name: 'blob', type: 'image/webp' })).toBe(true);
    expect(isPictureFile({ name: 'a.pdf', type: 'application/pdf' })).toBe(false);
    expect(isPictureFile({ name: 'a.mp4', type: 'video/mp4' })).toBe(false);
    expect(isPictureFile({ name: 'a', type: '' })).toBe(false);
  });
});

describe('wasConverted', () => {
  it('is true for a HEIC that was kept as another type, whatever the case', () => {
    expect(wasConverted('IMG_4412.HEIC', 'IMG_4412.jpg')).toBe(true);
    expect(wasConverted('a.heic', 'a 2.jpg')).toBe(true);
  });

  it('is false for everything else', () => {
    expect(wasConverted('a.heic', 'a.heic')).toBe(false);
    expect(wasConverted('a.heic', 'a 2.HEIC')).toBe(false);
    expect(wasConverted('a.png', 'a.png')).toBe(false);
    expect(wasConverted('a.jpg', 'a 2.jpg')).toBe(false);
    expect(wasConverted('blob', 'blob.png')).toBe(false);
  });
});

describe('pictureFilesFromClipboard', () => {
  const item = (kind: string, type: string, file: File | null) => ({
    kind,
    type,
    getAsFile: () => file,
  });

  it('takes the pictures among the clipboard’s files', () => {
    const shot = png('image.png');
    expect(pictureFilesFromClipboard({ files: [shot], items: [] })).toEqual([shot]);
  });

  it('takes an image that is only listed as an item (some browsers)', () => {
    const shot = png('image.png');
    expect(
      pictureFilesFromClipboard({
        files: [],
        items: [item('string', 'text/plain', null), item('file', 'image/png', shot)],
      }),
    ).toEqual([shot]);
  });

  it('is empty for text, so a paste of text goes to the box', () => {
    expect(
      pictureFilesFromClipboard({ files: [], items: [item('string', 'text/plain', null)] }),
    ).toEqual([]);
    expect(pictureFilesFromClipboard(null)).toEqual([]);
    expect(pictureFilesFromClipboard({})).toEqual([]);
  });

  it('is empty for a file that is no picture (a copied PDF pastes its name as it did)', () => {
    const pdf = new File(['x'], 'notes.pdf', { type: 'application/pdf' });
    expect(pictureFilesFromClipboard({ files: [pdf], items: [] })).toEqual([]);
  });
});

// --- the controller -------------------------------------------------------------------------------

interface Upload {
  file: File;
  name: string;
  resolve: (kept: NoteAttachment) => void;
  reject: (error: unknown) => void;
}

/** A stand-in engine whose uploads stay on their way until the test lets them land. */
function harness(earlier: NoteAttachment[] = []) {
  const uploads: Upload[] = [];
  const removed: string[] = [];
  const revoked: string[] = [];
  let listing: Promise<readonly NoteAttachment[]> = Promise.resolve(earlier);
  let rejectRemoval: ((name: string) => unknown) | null = null;
  let urls = 0;

  const deps: NoteAttachmentsDeps = {
    list: () => listing,
    upload: (_jobId, file, name) =>
      new Promise<NoteAttachment>((resolve, reject) => {
        uploads.push({ file, name, resolve, reject });
      }),
    remove: async (_jobId, name) => {
      removed.push(name);
      const failure = rejectRemoval?.(name);
      if (failure !== undefined && failure !== null) throw failure;
    },
    urlOf: (jobId, name) => `/api/jobs/${jobId}/note/attachments/${name}`,
    objectUrl: () => {
      urls += 1;
      return `blob:shot-${urls}`;
    },
    revokeUrl: (url) => revoked.push(url),
  };
  const controller = createNoteAttachments(deps);
  const rows = () => controller.store.getState().rows;
  const kept = (name: string, bytes = 100): NoteAttachment => ({
    name,
    bytes,
    addedAt: '2026-10-25T14:03:00.000Z',
  });
  return {
    controller,
    uploads,
    removed,
    revoked,
    rows,
    kept,
    slowList(promise: Promise<readonly NoteAttachment[]>) {
      listing = promise;
    },
    failRemoval(fn: (name: string) => unknown) {
      rejectRemoval = fn;
    },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('adding pictures', () => {
  it('shows a row at once, with a spinner status, and sends the picture with its own name', async () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add([png('IMG_4412.PNG')], 'pasted');

    expect(h.rows()).toMatchObject([
      { name: 'IMG_4412.PNG', from: 'pasted', status: 'uploading', previewUrl: 'blob:shot-1' },
    ]);
    expect(h.uploads.map((upload) => upload.name)).toEqual(['IMG_4412.PNG']);

    h.uploads[0]?.resolve(h.kept('IMG_4412.PNG', 1_234_567));
    await flush();
    expect(h.rows()).toMatchObject([
      { name: 'IMG_4412.PNG', bytes: 1_234_567, status: 'ready', error: null },
    ]);
  });

  it('takes the engine’s name when it numbered it', async () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add([png('image.png')], 'pasted');
    h.uploads[0]?.resolve(h.kept('image 2.png'));
    await flush();
    expect(h.rows()[0]?.name).toBe('image 2.png');
  });

  it('shows a HEIC the engine kept as a JPEG from the engine’s picture, under the JPEG’s name (the phone’s Photos or Files)', async () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add(
      [new File([new Uint8Array(16)], 'IMG_4412.HEIC', { type: 'image/heic' })],
      'chosen',
    );
    expect(h.uploads.map((upload) => upload.name)).toEqual(['IMG_4412.HEIC']);
    expect(h.rows()[0]?.previewUrl).toBe('blob:shot-1');

    h.uploads[0]?.resolve(h.kept('IMG_4412.jpg', 300_000));
    await flush();

    expect(h.rows()).toMatchObject([
      {
        name: 'IMG_4412.jpg',
        bytes: 300_000,
        status: 'ready',
        previewUrl: '/api/jobs/j1/note/attachments/IMG_4412.jpg',
      },
    ]);
    // The browser's own address for the HEIC is let go of when the opening ends.
    h.controller.keep();
    expect(h.revoked).toEqual(['blob:shot-1']);
  });

  it('keeps showing the file itself for a picture the engine kept as it came', async () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add([png('IMG_4412.PNG')], 'chosen');
    h.uploads[0]?.resolve(h.kept('IMG_4412 2.PNG'));
    await flush();
    expect(h.rows()[0]?.previewUrl).toBe('blob:shot-1');
  });

  it('records how each came: pasted, dropped, chosen', () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add([png('a.png')], 'pasted');
    h.controller.add([png('b.png'), png('c.png')], 'dropped');
    h.controller.add([png('d.png')], 'chosen');
    expect(h.rows().map((row) => row.from)).toEqual(['pasted', 'dropped', 'dropped', 'chosen']);
  });

  it('adds nothing while no dialog is open', () => {
    const h = harness();
    h.controller.add([png()], 'pasted');
    expect(h.rows()).toEqual([]);
    expect(h.uploads).toEqual([]);
  });

  it('shows a picture the engine refuses as a failed row with the engine’s words', async () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add([png('a.png')], 'chosen');
    h.uploads[0]?.reject(new Error('Cannot edit the note of a job that is editing.'));
    await flush();
    expect(h.rows()).toMatchObject([
      { status: 'failed', error: 'Cannot edit the note of a job that is editing.' },
    ]);
  });

  it('refuses a file that is not a picture, an empty one and one over 15 MB without asking the engine', () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add(
      [
        new File(['x'], 'notes.pdf', { type: 'application/pdf' }),
        fileOf('empty.png', 0),
        fileOf('big.png', NOTE_ATTACHMENTS.maxBytes + 1),
      ],
      'dropped',
    );
    expect(h.rows().map((row) => [row.name, row.status, row.error])).toEqual([
      ['notes.pdf', 'failed', ATTACHMENTS_TEXT.notAPicture],
      ['empty.png', 'failed', ATTACHMENTS_TEXT.empty],
      ['big.png', 'failed', ATTACHMENTS_TEXT.tooBig],
    ]);
    expect(h.uploads).toEqual([]);
  });

  it('takes a picture of exactly 15 MB', () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add([fileOf('limit.png', NOTE_ATTACHMENTS.maxBytes)], 'chosen');
    expect(h.rows()[0]?.status).toBe('uploading');
  });

  it('stops at six, counting the earlier pictures, and a failed row does not count', () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add([new File(['x'], 'notes.pdf', { type: 'application/pdf' })], 'dropped');
    h.controller.add(
      Array.from({ length: 7 }, (_, n) => png(`shot-${n}.png`)),
      'dropped',
    );
    const statuses = h.rows().map((row) => row.status);
    expect(statuses.filter((status) => status === 'uploading')).toHaveLength(6);
    expect(h.rows().at(-1)).toMatchObject({ status: 'failed', error: ATTACHMENTS_TEXT.tooMany });
    expect(h.uploads).toHaveLength(6);
  });
});

describe('earlier pictures', () => {
  it('lists the ones the note already has, before the new ones, shown from the engine', async () => {
    const h = harness([{ name: 'old.png', bytes: 2_000, addedAt: '2026-10-24T10:00:00.000Z' }]);
    h.controller.open('j1');
    expect(h.controller.store.getState().loading).toBe(true);
    await flush();

    expect(h.controller.store.getState().loading).toBe(false);
    expect(h.rows()).toMatchObject([
      {
        name: 'old.png',
        from: 'earlier',
        status: 'ready',
        previewUrl: '/api/jobs/j1/note/attachments/old.png',
      },
    ]);
  });

  it('keeps a picture added before the list came back, in its place after the earlier ones', async () => {
    const h = harness();
    let land: (list: readonly NoteAttachment[]) => void = () => {};
    h.slowList(new Promise((resolve) => (land = resolve)));
    h.controller.open('j1');
    h.controller.add([png('new.png')], 'pasted');

    land([h.kept('old.png')]);
    await flush();
    expect(h.rows().map((row) => row.name)).toEqual(['old.png', 'new.png']);
  });

  it('still takes pictures when the list cannot be read', async () => {
    const h = harness();
    h.slowList(Promise.reject(new Error('down')));
    h.controller.open('j1');
    await flush();
    expect(h.controller.store.getState().loading).toBe(false);
    h.controller.add([png()], 'pasted');
    expect(h.rows()).toHaveLength(1);
  });

  it('counts them toward the six', async () => {
    const h = harness(Array.from({ length: 5 }, (_, n) => earlierPicture(`old-${n}.png`)));
    h.controller.open('j1');
    await flush();
    h.controller.add([png('a.png'), png('b.png')], 'chosen');
    expect(h.rows().map((row) => row.status)).toEqual([
      'ready',
      'ready',
      'ready',
      'ready',
      'ready',
      'uploading',
      'failed',
    ]);
  });
});

describe('taking a picture off', () => {
  it('deletes a picture added in this opening at once', async () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add([png('a.png')], 'pasted');
    h.uploads[0]?.resolve(h.kept('a.png'));
    await flush();

    h.controller.remove(h.rows()[0]?.key ?? '');

    expect(h.rows()).toEqual([]);
    expect(h.removed).toEqual(['a.png']);
    expect(h.revoked).toEqual(['blob:shot-1']);
  });

  it('deletes a picture whose upload was still on its way when it lands', async () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add([png('a.png')], 'pasted');
    h.controller.remove(h.rows()[0]?.key ?? '');
    expect(h.rows()).toEqual([]);
    expect(h.removed).toEqual([]);

    h.uploads[0]?.resolve(h.kept('a.png'));
    await flush();
    expect(h.removed).toEqual(['a.png']);
    expect(h.rows()).toEqual([]);
  });

  it('only clears a failed row: there is nothing on the engine to delete', async () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add([new File(['x'], 'notes.pdf', { type: 'application/pdf' })], 'dropped');
    h.controller.remove(h.rows()[0]?.key ?? '');
    expect(h.rows()).toEqual([]);
    expect(h.removed).toEqual([]);
  });

  it('leaves an earlier picture on the note until Save', async () => {
    const h = harness([earlierPicture('old.png')]);
    h.controller.open('j1');
    await flush();

    h.controller.remove(h.rows()[0]?.key ?? '');
    expect(h.rows()).toEqual([]);
    expect(h.removed).toEqual([]);

    expect(await h.controller.settle()).toBeNull();
    expect(h.removed).toEqual(['old.png']);
  });
});

describe('Save: settle and keep', () => {
  it('waits for the uploads still on their way', async () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add([png('a.png'), png('b.png')], 'dropped');
    let settled: string | null | undefined;
    void h.controller.settle().then((result) => {
      settled = result;
    });

    await flush();
    expect(settled).toBeUndefined();
    h.uploads[0]?.resolve(h.kept('a.png'));
    await flush();
    expect(settled).toBeUndefined();
    h.uploads[1]?.resolve(h.kept('b.png'));
    await flush();
    expect(settled).toBeNull();
    expect(h.rows().map((row) => row.status)).toEqual(['ready', 'ready']);
  });

  it('stops the save, in words, when a picture did not attach', async () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add([png('a.png')], 'dropped');
    const settling = h.controller.settle();
    h.uploads[0]?.reject(new Error('That picture is over 15 MB.'));
    expect(await settling).toBe(ATTACHMENTS_TEXT.failed);
  });

  it('says the engine’s words when it refuses to take an earlier picture off, and keeps the row’s deletion for a retry', async () => {
    const h = harness([earlierPicture('old.png')]);
    h.controller.open('j1');
    await flush();
    h.controller.remove(h.rows()[0]?.key ?? '');
    h.failRemoval(() =>
      Object.assign(new Error('Cannot edit the note of a job that is editing.'), { status: 409 }),
    );

    expect(await h.controller.settle()).toBe('Cannot edit the note of a job that is editing.');

    h.failRemoval(() => null);
    expect(await h.controller.settle()).toBeNull();
    expect(h.removed).toEqual(['old.png', 'old.png']);
  });

  it('counts a picture that is already gone (404) as removed', async () => {
    const h = harness([earlierPicture('old.png')]);
    h.controller.open('j1');
    await flush();
    h.controller.remove(h.rows()[0]?.key ?? '');
    h.failRemoval(() => Object.assign(new Error('gone'), { status: 404 }));
    expect(await h.controller.settle()).toBeNull();
  });

  it('tries again at Save to delete a picture of this opening whose delete failed', async () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add([png('a.png')], 'pasted');
    h.uploads[0]?.resolve(h.kept('a.png'));
    await flush();
    h.failRemoval(() => new Error('The engine didn’t answer.'));
    h.controller.remove(h.rows()[0]?.key ?? '');
    await flush();

    h.failRemoval(() => null);
    expect(await h.controller.settle()).toBeNull();
    expect(h.removed).toEqual(['a.png', 'a.png']);
  });

  it('keep ends the opening and leaves every picture where it is', async () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add([png('a.png')], 'pasted');
    h.uploads[0]?.resolve(h.kept('a.png'));
    await flush();

    h.controller.keep();

    expect(h.removed).toEqual([]);
    expect(h.rows()).toEqual([]);
    expect(h.controller.store.getState().jobId).toBeNull();
    expect(h.revoked).toEqual(['blob:shot-1']);
  });
});

describe('Cancel: discard', () => {
  it('deletes the pictures this opening added, and only those', async () => {
    const h = harness([earlierPicture('old.png')]);
    h.controller.open('j1');
    await flush();
    h.controller.add([png('a.png'), png('b.png')], 'dropped');
    h.uploads[0]?.resolve(h.kept('a.png'));
    h.uploads[1]?.resolve(h.kept('b.png'));
    await flush();

    await h.controller.discard();

    expect(h.removed.sort()).toEqual(['a.png', 'b.png']);
    expect(h.rows()).toEqual([]);
    expect(h.revoked.sort()).toEqual(['blob:shot-1', 'blob:shot-2']);
  });

  it('does not take an earlier picture off, even one the person had clicked ×', async () => {
    const h = harness([earlierPicture('old.png')]);
    h.controller.open('j1');
    await flush();
    h.controller.remove(h.rows()[0]?.key ?? '');

    await h.controller.discard();

    expect(h.removed).toEqual([]);
  });

  it('deletes an upload that lands after the dialog was cancelled', async () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add([png('a.png')], 'pasted');
    await h.controller.discard();
    expect(h.removed).toEqual([]);

    h.uploads[0]?.resolve(h.kept('a.png'));
    await flush();
    expect(h.removed).toEqual(['a.png']);
    expect(h.rows()).toEqual([]);
  });

  it('does not let a late answer of one opening into the next', async () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add([png('a.png')], 'pasted');
    await h.controller.discard();

    h.controller.open('j2');
    h.controller.add([png('b.png')], 'pasted');
    h.uploads[0]?.resolve(h.kept('a.png'));
    await flush();

    expect(h.rows().map((row) => [row.name, row.status])).toEqual([['b.png', 'uploading']]);
    expect(h.removed).toEqual(['a.png']);
  });

  it('keeps deleting the rest when one delete fails', async () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add([png('a.png'), png('b.png')], 'dropped');
    h.uploads[0]?.resolve(h.kept('a.png'));
    h.uploads[1]?.resolve(h.kept('b.png'));
    await flush();
    h.failRemoval((name) => (name === 'a.png' ? new Error('down') : null));

    await expect(h.controller.discard()).resolves.toBeUndefined();
    expect(h.removed.sort()).toEqual(['a.png', 'b.png']);
  });
});

describe('opening again', () => {
  it('starts clean: the rows and the temporary addresses of the last opening are gone', async () => {
    const h = harness();
    h.controller.open('j1');
    h.controller.add([png('a.png')], 'pasted');
    h.controller.open('j2');
    expect(h.rows()).toEqual([]);
    expect(h.controller.store.getState().jobId).toBe('j2');
    expect(h.revoked).toEqual(['blob:shot-1']);
  });
});

describe('takePastedPictures', () => {
  const clipboard = (files: File[]) => ({ files, items: [] });

  it('attaches a pasted image as “pasted” and cancels the paste', () => {
    const attach = vi.fn();
    const event = { clipboardData: clipboard([png('image.png')]), preventDefault: vi.fn() };

    expect(takePastedPictures(event, attach)).toBe(true);

    expect(attach).toHaveBeenCalledWith([expect.objectContaining({ name: 'image.png' })], 'pasted');
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('leaves a paste of text to the text box', () => {
    const attach = vi.fn();
    const event = {
      clipboardData: {
        files: [],
        items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
      },
      preventDefault: vi.fn(),
    };

    expect(takePastedPictures(event, attach)).toBe(false);

    expect(attach).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('leaves a paste with no clipboard data alone', () => {
    const event = { clipboardData: null, preventDefault: vi.fn() };
    expect(takePastedPictures(event, vi.fn())).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
