import type { ClientStyleResponse } from '@studio/shared';
import { useRef } from 'react';
import { RelativeTime } from '@/components/jobs/RelativeTime';
import type { StyleUploadMode } from '@/data';
import { AddFilesButton } from './AddFilesButton';
import { AddStyleDialog } from './AddStyleDialog';
import { StyleDocument } from './StyleDocument';
import { StyleDropZone } from './StyleDropZone';
import { StyleStatusLine } from './StyleStatusLine';
import type { StyleDialogState, StyleSessionState } from './style-session';
import { styleStatus } from './style-status';

/** The overlay that says a drop will be taken (board "Style · Kova Coffee": dashed, 12 px inside the page). */
export const DROP_OVERLAY_TEXT = 'Drop files to add them to the style';

/** The dialog's files and choice, kept after it closes so its exit does not empty it out first. */
function useLastDialog(dialog: StyleDialogState | null): StyleDialogState {
  const last = useRef<StyleDialogState>({ files: [], mode: 'add' });
  if (dialog !== null) last.current = dialog;
  return last.current;
}

export interface StyleLayoutProps {
  /** The client's style, as the server has it. */
  style: ClientStyleResponse;
  /** What adding files has come to so far (see style-session.ts). */
  session: StyleSessionState;
  /** Files are being dragged over the window. */
  dragging: boolean;
  /** Retry was pressed and has not been answered. */
  retrying: boolean;
  /** Why the last Retry was refused, in the server's words. */
  retryError: string | null;
  /** Files were chosen: the picker and the drop call the same function. */
  onFiles: (files: File[]) => void;
  onRetry: () => void;
  onChooseMode: (mode: StyleUploadMode) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * What the Style page shows for a loaded style, and everything that adds files to it: style.md in
 * a 680 px column (or, with none, the drop zone), the line that says what is going on, the dashed
 * overlay for a drop, and the Add / Replace dialog. Presentational: `StylePage` owns the state.
 */
export function StyleLayout({
  style,
  session,
  dragging,
  retrying,
  retryError,
  onFiles,
  onRetry,
  onChooseMode,
  onConfirm,
  onCancel,
}: StyleLayoutProps) {
  const dialog = useLastDialog(session.dialog);
  const uploading = session.upload !== null;
  // The page takes a drop unless a dialog is asking or bytes are on their way.
  const dropping = dragging && session.dialog === null && !uploading;
  const names = session.upload?.names ?? session.started?.names ?? [];

  const found = styleStatus(style, session);
  // A Retry the server refused says why in place of the failure it was meant to fix.
  const status =
    found?.kind === 'error' && found.retry && retryError !== null
      ? { ...found, text: retryError }
      : found;
  const line = status && <StyleStatusLine status={status} onRetry={onRetry} retrying={retrying} />;

  return (
    // Tall enough for the drop overlay to cover the page: the screen less the header (3.5rem) and
    // the main area's padding (1.5rem above, 2.5rem below). The board's text reads at 1.6.
    <div className="relative min-h-[calc(100svh-7.5rem)] leading-[1.6]">
      {style.markdown !== null ? (
        <article className="flex max-w-[680px] flex-col gap-3">
          <div className="flex min-h-9 items-center justify-between gap-3">
            <span className="text-[13px] text-muted-foreground">
              style.md
              {style.updatedAt !== null && (
                <>
                  {' · updated '}
                  <RelativeTime
                    iso={style.updatedAt}
                    className="inline-block first-letter:lowercase"
                  />
                </>
              )}
            </span>
            <AddFilesButton onFiles={onFiles} disabled={uploading} icon className="shrink-0">
              Add style files
            </AddFilesButton>
          </div>
          {line}
          <StyleDocument markdown={style.markdown} />
        </article>
      ) : (
        <div className="flex flex-col gap-3">
          {/* While files go up or are analysed the box says so itself, in place of its invitation. */}
          {status?.kind !== 'uploading' && status?.kind !== 'busy' && line}
          <StyleDropZone
            busy={status?.kind === 'uploading' || status?.kind === 'busy' ? status : null}
            names={names}
            dragging={dropping}
            onFiles={onFiles}
          />
        </div>
      )}

      {dropping && style.markdown !== null && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-3 z-10 flex items-center justify-center rounded-[12px] border-2 border-dashed border-foreground/35 bg-background/90 text-base font-medium"
        >
          {DROP_OVERLAY_TEXT}
        </div>
      )}

      <AddStyleDialog
        open={session.dialog !== null}
        client={style.client}
        files={dialog.files}
        mode={dialog.mode}
        onModeChange={onChooseMode}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </div>
  );
}
