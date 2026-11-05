import type { ClientStyleResponse } from '@studio/shared';
import type { StyleSessionState } from './style-session';
import { fileCountText } from './style-text';

/** The one line above the document (or in the empty state's drop zone) that says what is going on. */
export type StyleStatus =
  /** Bytes are on their way. */
  | { kind: 'uploading'; text: string; percent: number }
  /** A style run is working. `job` is the job's name inside `text` (it needs its own direction). */
  | { kind: 'busy'; text: string; job?: string }
  | { kind: 'done'; text: string }
  /** Said once and left: the last upload was turned away because the engine is busy. */
  | { kind: 'info'; text: string }
  /** `retry`: the style run failed and Retry runs it again. */
  | { kind: 'error'; text: string; retry: boolean };

/** What a failed run says when the server gave no reason. */
export const FAILED_TEXT = "The style couldn't be made.";

function busyStatus(pass: ClientStyleResponse['pass']): StyleStatus {
  if (pass?.kind === 'learn') {
    return pass.job === null
      ? { kind: 'busy', text: 'Learning the style from a finished job.' }
      : { kind: 'busy', text: `Learning the style from ${pass.job}.`, job: pass.job };
  }
  const count = pass?.fileCount ?? 0;
  return {
    kind: 'busy',
    text: `Analysing ${count > 0 ? fileCountText(count) : 'the files'}. style.md updates when it’s done.`,
  };
}

/**
 * What the status line says, most pressing first: bytes on their way, the last upload turned away,
 * a failed run (with Retry), a run in progress, and last the notice that the files were added. `null` when there is nothing to say.
 */
export function styleStatus(
  style: Pick<ClientStyleResponse, 'state' | 'error' | 'pass'>,
  { upload, notice }: Pick<StyleSessionState, 'upload' | 'notice'>,
): StyleStatus | null {
  if (upload !== null) {
    const percent = Math.round(upload.percent);
    return {
      kind: 'uploading',
      text: `Uploading ${fileCountText(upload.names.length)}… ${percent}%`,
      percent,
    };
  }
  if (notice?.tone === 'error') return { kind: 'error', text: notice.text, retry: false };
  if (notice?.tone === 'info') return { kind: 'info', text: notice.text };
  if (style.state === 'failed') {
    return { kind: 'error', text: style.error ?? FAILED_TEXT, retry: true };
  }
  if (style.state === 'analysing') return busyStatus(style.pass);
  if (notice?.tone === 'done') return { kind: 'done', text: notice.text };
  return null;
}
