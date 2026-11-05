// The Style page's side of adding files: from the files being chosen (the picker and a drop both
// call `take`) to the line of text that says how it went. Plain TypeScript with no React or
// network of its own, so the rules are tested without a browser; `useStyleSession` shows it.
//
//   take(files) ─▶ a style.md exists? ─ yes ─▶ the Add / Replace dialog ─ confirm ─┐
//                                      └ no ──────────────────────────────────────┤
//                                                                                 ▼
//                     upload (progress) ─▶ accepted: the style is analysing, `started` remembers
//                     what was sent ─▶ `observe` sees it ready (a newer version) ─▶ the done
//                     notice, for 10 s. A refusal is a notice too (a 409 for 10 s, the rest until
//                     the next upload).
//
// What the server is doing (analysing, failed) is not kept here: that is the style query's.

import type { ClientStyle } from '@studio/shared';
import { ApiError, type StyleUpload, type StyleUploadMode } from '@/data';
import { fileCountText } from './style-text';

/** How long the "done" and "still working" notices stay up. */
export const NOTICE_MS = 10_000;

/** The 409 of an upload sent while the last files are still being analysed. */
export const STILL_WORKING_TEXT = 'Still working on the last files.';

/** Said when an upload fails with something that is not the server's answer. */
export const UPLOAD_FAILED_TEXT = "Couldn't send the files.";

/**
 * What the last upload came to: `done` (the files are in the style), `info` (the engine is busy
 * with the last files: not a failure) or `error`.
 */
export interface StyleNotice {
  tone: 'done' | 'info' | 'error';
  text: string;
}

/** The files waiting in the Add / Replace dialog, and what the person has chosen for them. */
export interface StyleDialogState {
  files: readonly File[];
  mode: StyleUploadMode;
}

/** An upload the server accepted: what was sent, so the done notice can say so when the run ends. */
export interface StartedUpload {
  /** The style's version when the upload was accepted; the run ending makes it higher. */
  fromVersion: number;
  names: readonly string[];
  mode: StyleUploadMode;
  /** There was a style.md to add to or replace; false when the files made the first one. */
  hadStyle: boolean;
}

export interface StyleSessionState {
  /** The Add / Replace dialog, open while it has files. */
  dialog: StyleDialogState | null;
  /** Bytes on their way. */
  upload: { names: readonly string[]; percent: number } | null;
  /** The last upload the server accepted, until its run has ended. */
  started: StartedUpload | null;
  notice: StyleNotice | null;
}

/** The part of the cached style the session reads. */
export interface SessionStyle {
  state: string;
  version: number;
  markdown: string | null;
}

export interface StyleSessionDeps {
  /** The client's style as it is cached right now; `undefined` before it has loaded. */
  getStyle: () => SessionStyle | undefined;
  /** Sends the files (`api.uploadStyleFiles`); resolves with the style, now analysing. */
  upload: (upload: Pick<StyleUpload, 'files' | 'mode' | 'onProgress'>) => Promise<ClientStyle>;
  /** The server accepted the files: the style (analysing) is to be put in the cache. */
  onUploaded?: (style: ClientStyle) => void;
}

export interface StyleSession {
  getState(): StyleSessionState;
  subscribe(listener: () => void): () => void;
  /** Files were chosen, by the picker or a drop. One entry point, so both do the same. */
  take(files: readonly File[]): void;
  /** The dialog's radio: add to the style, or replace it. */
  chooseMode(mode: StyleUploadMode): void;
  /** The dialog's confirm button. */
  confirm(): void;
  /** The dialog's Cancel, Escape or a click outside. */
  cancel(): void;
  /** Looks at the cached style: when the run of the started upload has ended, says so. */
  observe(): void;
  /** Stops the notice's timer. An upload in flight carries on. */
  dispose(): void;
}

const IDLE: StyleSessionState = { dialog: null, upload: null, started: null, notice: null };

/** "Added 3 files to the style." and its two siblings. */
export function doneText({ names, mode, hadStyle }: StartedUpload): string {
  const files = fileCountText(names.length);
  if (!hadStyle) return `Wrote style.md from ${files}.`;
  return mode === 'replace'
    ? `Replaced the style with ${files}. The old style.md is in history.`
    : `Added ${files} to the style.`;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function createStyleSession(deps: StyleSessionDeps): StyleSession {
  let state = IDLE;
  const listeners = new Set<() => void>();
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;

  function change(next: Partial<StyleSessionState>): void {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  }

  /** Shows `notice` (or clears it); one that `expiresMs` is given for goes away by itself. */
  function setNotice(notice: StyleNotice | null, expiresMs?: number): void {
    if (noticeTimer !== undefined) clearTimeout(noticeTimer);
    noticeTimer = undefined;
    change({ notice });
    if (notice !== null && expiresMs !== undefined) {
      noticeTimer = setTimeout(() => {
        noticeTimer = undefined;
        change({ notice: null });
      }, expiresMs);
    }
  }

  async function send(files: readonly File[], mode: StyleUploadMode): Promise<void> {
    const names = files.map((file) => file.name);
    const hadStyle = deps.getStyle()?.markdown != null;
    setNotice(null);
    change({ dialog: null, upload: { names, percent: 0 } });
    try {
      const style = await deps.upload({
        files,
        mode,
        onProgress: (percent) => {
          if (state.upload !== null && state.upload.percent !== percent) {
            change({ upload: { ...state.upload, percent } });
          }
        },
      });
      deps.onUploaded?.(style);
      change({ upload: null, started: { fromVersion: style.version, names, mode, hadStyle } });
    } catch (error) {
      change({ upload: null });
      if (isAbort(error)) return;
      if (error instanceof ApiError && error.status === 409) {
        setNotice({ tone: 'info', text: STILL_WORKING_TEXT }, NOTICE_MS);
      } else {
        const text = error instanceof ApiError ? error.message : UPLOAD_FAILED_TEXT;
        setNotice({ tone: 'error', text });
      }
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    take(files) {
      // Nothing chosen, a dialog already asking, or bytes already on their way: this one is dropped.
      if (files.length === 0 || state.dialog !== null || state.upload !== null) return;
      if (deps.getStyle()?.markdown != null) change({ dialog: { files, mode: 'add' } });
      else void send(files, 'add');
    },
    chooseMode(mode) {
      if (state.dialog !== null) change({ dialog: { ...state.dialog, mode } });
    },
    confirm() {
      if (state.dialog !== null) void send(state.dialog.files, state.dialog.mode);
    },
    cancel() {
      change({ dialog: null });
    },
    observe() {
      const { started } = state;
      const style = deps.getStyle();
      if (started === null || style === undefined) return;
      // A failed run keeps `started`: Retry may still end it, and then the files were added.
      if (style.state === 'ready' && style.version > started.fromVersion) {
        change({ started: null });
        setNotice({ tone: 'done', text: doneText(started) }, NOTICE_MS);
      }
    },
    dispose() {
      if (noticeTimer !== undefined) clearTimeout(noticeTimer);
      noticeTimer = undefined;
    },
  };
}
