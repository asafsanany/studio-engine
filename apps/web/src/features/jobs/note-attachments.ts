// The pictures attached to a note in "Note for the editor" (Songs, SG5): the state of one opening of
// the dialog and the requests behind it. It is deliberately not part of the Mac dialog's component:
// the phone's Add photo (SG6) adds pictures to the same note through the same controller.
//
// What happens, in the person's terms:
//   - A picture added (pasted, dropped or chosen) is sent to the engine at once, and shows as a row
//     with a small spinner until it is kept. A picture that cannot be attached (not a picture, too
//     big, a seventh, or the engine says no) shows as a row that says why; its × clears it.
//   - Pictures already on the note from an earlier opening are listed when the dialog opens, so they
//     can be seen and taken off. Taking one off only counts when the note is saved: Cancel leaves
//     the note exactly as it was.
//   - A picture added in this opening and taken off again is deleted at once.
//   - Save waits for the uploads still on their way, then removes the earlier pictures that were
//     taken off. A picture that did not attach stops Save, and says so.
//   - Cancel, Escape and a click outside delete the pictures added in this opening, and only those;
//     an upload that is still on its way is deleted when it lands.
//
// The state is a small store, like `note-dialog.ts`'s: requests run on it, not in a component, so a
// late answer lands even if the dialog has gone. Each opening is a "session"; an answer that comes
// back for an earlier session never touches the rows of the new one (and a picture it kept is
// deleted: that opening was cancelled).

import { NOTE_ATTACHMENTS, type NoteAttachment, noteAttachmentType } from '@studio/shared';
import { createStore, type StoreApi, useStore } from 'zustand';
import { noteAttachmentsApi, noteAttachmentUrl } from '@/data/note-attachments-api';

/** How a picture came into the dialog. */
export type AttachmentSource = 'pasted' | 'dropped' | 'chosen';

export type AttachmentStatus = 'uploading' | 'ready' | 'failed';

/** One row of the dialog's list. */
export interface AttachmentRow {
  /** Stable for the row's life (its name can change when the engine numbers it). */
  key: string;
  /** The file's own name while it is sent; the engine's once it is kept. */
  name: string;
  bytes: number;
  /** How it came; `earlier` for a picture the note already had when the dialog opened. */
  from: AttachmentSource | 'earlier';
  status: AttachmentStatus;
  /** Why a `failed` row failed, in words to show; `null` otherwise. */
  error: string | null;
  /** What the thumbnail shows: an object URL of the file, or the engine's URL for an earlier picture. */
  previewUrl: string | null;
}

/** The words of the pictures part of the dialog (design canvas, Songs: "Note for the editor"). */
export const ATTACHMENTS_TEXT = {
  attached: 'Attached',
  drop: 'Drop a screenshot here or paste one (⌘V). Links go in the note.',
  choose: 'Choose a file',
  addAnother: 'Add another',
  reads:
    'The brief reads the song off it: the name under the reel, and “sped up” or “remix” when it says so.',
  /** The phone's row says it short (board SGPhone); the Mac's `reads` says what it looks for. */
  readsShort: 'The brief reads the song off it.',
  linkTitle: 'An Instagram reel link',
  link: 'The editor takes the song from that reel, and the exact part it uses.',
  dropOverlay: 'Drop to attach',
  uploading: 'Attaching…',
  notAPicture: 'That isn’t a picture. Attach a PNG, JPG, HEIC, WEBP or GIF.',
  empty: 'That picture is empty.',
  tooBig: `That picture is over ${NOTE_ATTACHMENTS.maxBytes / (1024 * 1024)} MB.`,
  tooMany: `A note takes at most ${NOTE_ATTACHMENTS.maxFiles} pictures.`,
  /** Save is stopped while a row failed. */
  failed: 'A picture didn’t attach. Take it off to save the note.',
} as const;

/** "1.2 MB": decimal units, one decimal only under 10, like the Brief's file list. */
export function fileSizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1000)
    return `${Math.max(0, Math.trunc(bytes) || 0)} bytes`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 999.5 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const text = value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value));
  return `${text} ${units[unit]}`;
}

/** The second line of a row: "Screenshot · 1.2 MB · pasted". An earlier picture has no "how". */
export function attachmentLine(row: Pick<AttachmentRow, 'bytes' | 'from'>): string {
  const parts = ['Screenshot', fileSizeText(row.bytes)];
  if (row.from !== 'earlier') parts.push(row.from);
  return parts.join(' · ');
}

/**
 * Whether the text holds a link to an Instagram reel (`instagram.com/reel/…`, `/reels/…`, or the
 * account's own `instagram.com/<account>/reel/…`): the dialog then says what the editor does with
 * it.
 */
export function hasInstagramReelLink(text: string): boolean {
  return /instagram\.com\/(?:[\w.]+\/)?reels?\/[\w-]+/i.test(text);
}

// --- what a file is ------------------------------------------------------------------------------

const EXTENSION_OF_TYPE: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** The type the browser gives, without parameters, in lower case ('' when it gives none). */
function mimeOf(file: Pick<File, 'type'>): string {
  return (file.type.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * The name to send for a file: its own, or, for one that comes without an extension (a pasted
 * image can be called just "blob"), with the one its type gives. Never empty.
 */
export function uploadName(file: Pick<File, 'name' | 'type'>): string {
  const name = file.name.trim() === '' ? 'image' : file.name;
  if (noteAttachmentType(name) !== null) return name;
  const extension = EXTENSION_OF_TYPE[mimeOf(file)];
  return extension === undefined ? name : `${name}.${extension}`;
}

/** Whether a file is a picture the note can take: by its extension, or by its type. */
export function isPictureFile(file: Pick<File, 'name' | 'type'>): boolean {
  return noteAttachmentType(file.name) !== null || EXTENSION_OF_TYPE[mimeOf(file)] !== undefined;
}

/**
 * Whether the engine kept a picture as another type than it came in: a HEIC from the phone's
 * Photos or Files is kept as a JPEG (the Brief run cannot read HEIC).
 */
export function wasConverted(sentName: string, keptName: string): boolean {
  return noteAttachmentType(sentName) === 'heic' && noteAttachmentType(keptName) !== 'heic';
}

/** The part of a clipboard (`DataTransfer`) a paste is read from. */
export interface ClipboardLike {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }> | null;
}

/**
 * The pictures on the clipboard: its files that are pictures, or, where the browser lists them only
 * as items (some do), the items of kind file whose type is an image. Empty for text and everything
 * else, so a paste of text goes to the text box as it always did.
 */
export function pictureFilesFromClipboard(data: ClipboardLike | null | undefined): File[] {
  if (data === null || data === undefined) return [];
  const files = Array.from(data.files ?? []).filter(isPictureFile);
  if (files.length > 0) return files;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

/**
 * What a paste into the dialog does. A paste that holds pictures attaches them and is cancelled
 * (so the name of a file copied in Finder is not typed into the note); every other paste, text
 * above all, is left alone for the text box. Answers whether it took the paste.
 */
export function takePastedPictures(
  event: { clipboardData: ClipboardLike | null; preventDefault(): void },
  attach: (files: File[], source: AttachmentSource) => void,
): boolean {
  const files = pictureFilesFromClipboard(event.clipboardData);
  if (files.length === 0) return false;
  event.preventDefault();
  attach(files, 'pasted');
  return true;
}

// --- the controller -----------------------------------------------------------------------------

/** What the controller needs from the outside: the engine, and object URLs for thumbnails. */
export interface NoteAttachmentsDeps {
  /** The pictures the job's note has now (`GET …/note`). */
  list: (jobId: string) => Promise<readonly NoteAttachment[]>;
  /** `POST …/note/attachments`; rejects with the engine's words. */
  upload: (jobId: string, file: File, name: string) => Promise<NoteAttachment>;
  /** `DELETE …/note/attachments/:name`; rejects with the engine's words (404: already gone). */
  remove: (jobId: string, name: string) => Promise<unknown>;
  /** Where an earlier picture is shown from. */
  urlOf: (jobId: string, name: string) => string;
  /** A temporary address for a file's thumbnail; `null` when the browser cannot make one. */
  objectUrl: (file: Blob) => string | null;
  /** Lets go of one. */
  revokeUrl: (url: string) => void;
}

export interface NoteAttachmentsState {
  /** The job of the open dialog, or `null` when none is open. */
  jobId: string | null;
  rows: AttachmentRow[];
  /** The list of earlier pictures is on its way. */
  loading: boolean;
}

/**
 * What the dialog's flows (`note-dialog.ts`) ask of the pictures: wait for them, keep them, or
 * throw away what this opening added. Kept to three methods so the note's own rules do not depend
 * on how the pictures are shown.
 */
export interface NoteAttachmentsSession {
  /**
   * Save: waits for the uploads still on their way and removes the earlier pictures that were taken
   * off. Resolves `null` when the note can be saved, or the words to show when it cannot (a picture
   * that did not attach, or the engine refusing a removal). Never rejects.
   */
  settle: () => Promise<string | null>;
  /** Saved: the opening ends and the pictures stay on the note. */
  keep: () => void;
  /** Cancel: the opening ends and the pictures it added are deleted (and only those). */
  discard: () => Promise<void>;
}

export interface NoteAttachments extends NoteAttachmentsSession {
  store: StoreApi<NoteAttachmentsState>;
  /** The dialog opened for this job: its earlier pictures are listed and new ones are taken. */
  open: (jobId: string) => void;
  /** Pictures came in. One row each; a file that cannot be attached shows as a failed row. */
  add: (files: readonly File[], source: AttachmentSource) => void;
  /** The × of a row. */
  remove: (key: string) => void;
  /** The page is gone: forget everything without any request. */
  reset: () => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404;
}

/** A name taken off the note when the dialog is saved (an earlier picture), or retried (one just added). */
interface Stray {
  name: string;
  /** It was on the note before this opening, so Cancel must leave it alone. */
  earlier: boolean;
}

export function createNoteAttachments(deps: NoteAttachmentsDeps): NoteAttachments {
  const store = createStore<NoteAttachmentsState>()(() => ({
    jobId: null,
    rows: [],
    loading: false,
  }));

  let session = 0;
  let keys = 0;
  const nextKey = (prefix: string): string => {
    keys += 1;
    return `${prefix}-${keys}`;
  };
  /** Uploads and deletes of this session that are on their way. */
  const pending = new Set<Promise<void>>();
  /** Rows taken off while their upload was on its way: the picture is deleted when it lands. */
  const cancelled = new Set<string>();
  const strays: Stray[] = [];
  /** The object URLs made in this session, to let go of. */
  const made = new Set<string>();

  const patchRow = (key: string, patch: Partial<AttachmentRow>) =>
    store.setState((state) => ({
      rows: state.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    }));

  const track = (work: Promise<void>): void => {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };

  function endSession(): void {
    session += 1;
    for (const url of made) deps.revokeUrl(url);
    made.clear();
    pending.clear();
    cancelled.clear();
    strays.length = 0;
    store.setState({ jobId: null, rows: [], loading: false });
  }

  const deleteQuietly = (jobId: string, name: string): Promise<void> =>
    Promise.resolve(deps.remove(jobId, name)).then(
      () => undefined,
      () => undefined,
    );

  /** Why a file cannot be attached, or `null`. */
  function problemWith(file: File, rows: readonly AttachmentRow[]): string | null {
    if (!isPictureFile(file)) return ATTACHMENTS_TEXT.notAPicture;
    if (file.size === 0) return ATTACHMENTS_TEXT.empty;
    if (file.size > NOTE_ATTACHMENTS.maxBytes) return ATTACHMENTS_TEXT.tooBig;
    const taking = rows.filter((row) => row.status !== 'failed').length;
    if (taking >= NOTE_ATTACHMENTS.maxFiles) return ATTACHMENTS_TEXT.tooMany;
    return null;
  }

  function upload(
    jobId: string,
    key: string,
    file: File,
    name: string,
    mine: number,
  ): Promise<void> {
    return deps.upload(jobId, file, name).then(
      (kept) => {
        // The dialog was closed or cancelled, or the row taken off, while the picture was on its way.
        if (mine !== session || cancelled.has(key)) {
          cancelled.delete(key);
          return deleteQuietly(jobId, kept.name);
        }
        patchRow(key, {
          name: kept.name,
          bytes: kept.bytes,
          status: 'ready',
          error: null,
          // A HEIC is kept as a JPEG: the engine's picture is one every browser can show.
          ...(wasConverted(name, kept.name) ? { previewUrl: deps.urlOf(jobId, kept.name) } : {}),
        });
        return undefined;
      },
      (error: unknown) => {
        if (mine !== session || cancelled.has(key)) return;
        patchRow(key, { status: 'failed', error: messageOf(error) });
      },
    );
  }

  return {
    store,

    open(jobId) {
      endSession();
      const mine = session;
      store.setState({ jobId, rows: [], loading: true });
      void Promise.resolve()
        .then(() => deps.list(jobId))
        .then(
          (attachments) => {
            if (mine !== session) return;
            const earlier: AttachmentRow[] = attachments.map((picture) => ({
              key: nextKey('earlier'),
              name: picture.name,
              bytes: picture.bytes,
              from: 'earlier',
              status: 'ready',
              error: null,
              previewUrl: deps.urlOf(jobId, picture.name),
            }));
            store.setState((state) => {
              // A picture added before the list came back may be in it already.
              const known = new Set(state.rows.map((row) => row.name));
              return {
                loading: false,
                rows: [...earlier.filter((row) => !known.has(row.name)), ...state.rows],
              };
            });
          },
          () => {
            // Without the list the dialog still takes new pictures; the engine keeps the limits.
            if (mine === session) store.setState({ loading: false });
          },
        );
    },

    add(files, source) {
      const { jobId } = store.getState();
      if (jobId === null) return;
      const mine = session;
      for (const file of files) {
        const key = nextKey('new');
        const name = uploadName(file);
        const problem = problemWith(file, store.getState().rows);
        if (problem !== null) {
          store.setState((state) => ({
            rows: [
              ...state.rows,
              {
                key,
                name,
                bytes: file.size,
                from: source,
                status: 'failed',
                error: problem,
                previewUrl: null,
              },
            ],
          }));
          continue;
        }
        const previewUrl = deps.objectUrl(file);
        if (previewUrl !== null) made.add(previewUrl);
        store.setState((state) => ({
          rows: [
            ...state.rows,
            {
              key,
              name,
              bytes: file.size,
              from: source,
              status: 'uploading',
              error: null,
              previewUrl,
            },
          ],
        }));
        track(upload(jobId, key, file, name, mine));
      }
    },

    remove(key) {
      const { jobId, rows } = store.getState();
      const row = rows.find((candidate) => candidate.key === key);
      if (jobId === null || row === undefined) return;
      store.setState({ rows: rows.filter((candidate) => candidate.key !== key) });
      if (row.previewUrl !== null && made.delete(row.previewUrl)) deps.revokeUrl(row.previewUrl);

      if (row.status === 'uploading') {
        cancelled.add(key);
      } else if (row.status === 'ready') {
        if (row.from === 'earlier') {
          // Only a Save takes an earlier picture off the note.
          strays.push({ name: row.name, earlier: true });
        } else {
          const mine = session;
          track(
            Promise.resolve(deps.remove(jobId, row.name)).then(
              () => undefined,
              (error: unknown) => {
                // Already gone is as good as deleted; anything else is tried again at Save.
                if (mine === session && !isNotFound(error)) {
                  strays.push({ name: row.name, earlier: false });
                }
              },
            ),
          );
        }
      }
    },

    async settle() {
      const { jobId } = store.getState();
      if (jobId === null) return null;
      while (pending.size > 0) await Promise.allSettled([...pending]);
      if (store.getState().rows.some((row) => row.status === 'failed')) {
        return ATTACHMENTS_TEXT.failed;
      }
      for (const stray of [...strays]) {
        try {
          await deps.remove(jobId, stray.name);
        } catch (error) {
          if (!isNotFound(error)) return messageOf(error);
        }
        strays.splice(strays.indexOf(stray), 1);
      }
      return null;
    },

    keep() {
      endSession();
    },

    async discard() {
      const { jobId, rows } = store.getState();
      const names = [
        ...rows
          .filter((row) => row.from !== 'earlier' && row.status === 'ready')
          .map((r) => r.name),
        ...strays.filter((stray) => !stray.earlier).map((stray) => stray.name),
      ];
      // Uploads still on their way are deleted when they land: the session is over by then.
      endSession();
      if (jobId === null) return;
      await Promise.all(names.map((name) => deleteQuietly(jobId, name)));
    },

    reset() {
      endSession();
    },
  };
}

// --- the app's controller and its hook --------------------------------------------------------

/** The controller's dependencies on the real engine and the browser. */
export const browserDeps: NoteAttachmentsDeps = {
  list: async (jobId) => (await noteAttachmentsApi.getNoteView(jobId)).attachments,
  upload: (jobId, file, name) => noteAttachmentsApi.addNoteAttachment(jobId, file, name),
  remove: (jobId, name) => noteAttachmentsApi.deleteNoteAttachment(jobId, name),
  urlOf: (jobId, name) => noteAttachmentUrl(jobId, name),
  objectUrl: (file) =>
    typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(file)
      : null,
  revokeUrl: (url) => {
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(url);
    }
  },
};

/**
 * The app's pictures controller: one dialog is open at a time, so one controller. The Mac dialog
 * and the phone's Add photo (SG6) both use it. Tests build their own with `createNoteAttachments`.
 */
export const noteAttachments: NoteAttachments = createNoteAttachments(browserDeps);

/** The controller's state, for a component. */
export function useNoteAttachmentsState(controller: Pick<NoteAttachments, 'store'>) {
  return useStore(controller.store, (state) => state);
}
