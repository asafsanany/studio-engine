import type { Job } from '@studio/shared';
import { type ComponentType, useEffect, useRef, useState } from 'react';
import type { StoreApi } from 'zustand';
import { useJobAction, useSaveNote, useSongsEnabled } from '@/data';
import { createDropTarget } from '@/features/style/drop-target';
import {
  type NoteAttachments,
  noteAttachments,
  useNoteAttachmentsState,
} from '../note-attachments';
import {
  dismissNoteDialog,
  isNoteDialogOpen,
  type NoteDialogDeps,
  type NoteDialogState,
  noteDialogStore,
  saveNoteDialog,
  startNoteDialog,
  useNoteDialog,
} from '../note-dialog';
import { announceRefusal } from '../RefusedActionsHost';
import { rowFocusTarget } from '../row-focus';
import { NoteDialog, type NoteDialogProps } from './NoteDialog';

export interface NoteDialogHostProps {
  /** The full job list from `useJobs()`: `undefined` until the first load. */
  jobs: readonly Job[] | undefined;
  /** Where the dialog's state lives. Tests pass their own; the page uses the shared one. */
  store?: StoreApi<NoteDialogState>;
  /** The `@` picker in the box (when `lutsInEdits` is on). The phone's sheet passes `false`. */
  libraryPicker?: boolean;
  /**
   * Pictures for the note (Songs, SG5): while the Songs switch is on the dialog takes a screenshot
   * by paste, drop or Choose a file (on the phone: Add photo, SG6). `false` turns them off.
   */
  pictures?: boolean;
  /** Where the pictures' state lives. Tests pass their own; the page uses the shared one. */
  attachments?: NoteAttachments;
  /**
   * What draws the note: the Mac's dialog by default; the phone passes its bottom sheet
   * (`PhoneNoteSheet`). It gets the same props, so the rules (the hold, Save waiting for the
   * pictures, Cancel throwing them away) stay in one place.
   */
  view?: ComponentType<NoteDialogProps>;
}

/**
 * The "Note for the editor" dialog for the whole Jobs page. A row's Add note… / Edit note… menu
 * item only asks (`askForNote`); this host starts the dialog (holding the job first when it is
 * arriving or queued), shows it, and sends Save, Release and Cancel, one level above the table, so
 * they survive the row moving to another page or off the list. See `note-dialog.ts` for the rules.
 *
 * - A Hold or Release the server refuses is said as a toast (the dialog is not open to say it).
 * - A refused Save (the job has started editing, the engine is out of reach) is said inside the
 *   dialog, which keeps the text.
 * - Closing gives focus to the row's action button, or to the row itself, when the row is on the
 *   page (there is no trigger element to give it back to).
 * - Leaving the page with the dialog open puts a job it was holding back in line.
 * - With the Songs switch on it also takes pictures for the note (paste, drop, Choose a file; on
 *   the phone, Add photo): their state is `note-attachments.ts`'s, and Save, Cancel and leaving
 *   the page treat them as `note-dialog.ts` says. One controller serves the Mac's dialog and the
 *   phone's sheet; neither holds the pictures' state.
 *
 * Mount it once, on the page, next to `RefusedActionsHost` (which draws the toasts). Renders
 * nothing while no dialog is open.
 */
export function NoteDialogHost({
  jobs,
  store = noteDialogStore,
  libraryPicker = true,
  pictures = true,
  attachments = noteAttachments,
  view: View = NoteDialog,
}: NoteDialogHostProps) {
  const state = useNoteDialog(store);
  const withPictures = useSongsEnabled() && pictures;
  const picturesState = useNoteAttachmentsState(attachments);
  const [dragging, setDragging] = useState(false);
  const hold = useJobAction('hold');
  // The dialog holds a job while the person writes; letting it go puts a queued job back in its place.
  const release = useJobAction('release', { restorePlace: true });
  const save = useSaveNote();

  // The latest list, for the job's name in a refusal, without making `deps` new on every change.
  const latestJobs = useRef(jobs);
  useEffect(() => {
    latestJobs.current = jobs;
  });

  const deps: NoteDialogDeps = {
    hold: hold.mutateAsync,
    release: release.mutateAsync,
    save: (id, note) => save.mutateAsync({ id, note }),
    refused: (action, jobId, message) =>
      announceRefusal(
        { action, jobId, message },
        latestJobs.current?.find((job) => job.id === jobId),
      ),
    // Waited for on Save, thrown away on Cancel (note-dialog.ts).
    ...(withPictures ? { attachments } : {}),
  };
  // What the effects below run with: the newest `deps`, not the one of the render that set them up.
  const latestDeps = useRef(deps);
  useEffect(() => {
    latestDeps.current = deps;
  });

  // A row asked: start the dialog once. (`takeAsked` forgets the request, so a second run of the
  // effect finds nothing.)
  const { asked } = state;
  useEffect(() => {
    if (asked === null) return;
    const job = store.getState().takeAsked();
    if (job !== null) void startNoteDialog(job, latestDeps.current, store);
  }, [asked, store]);

  // The dialog opened for a job: its pictures are listed and new ones are taken. The opening ends
  // with Save (`keep`) or Cancel (`discard`), which the flows in note-dialog.ts call.
  const open = isNoteDialogOpen(state);
  const openJobId = state.job?.id ?? null;
  useEffect(() => {
    if (withPictures && open && openJobId !== null) attachments.open(openJobId);
  }, [withPictures, open, openJobId, attachments]);

  // A file dropped anywhere while the dialog is open is attached, and the browser never opens it:
  // the listeners are the window's, so a drop that just misses the dialog does no harm.
  useEffect(() => {
    if (!withPictures || !open) return;
    const target = createDropTarget({
      onFiles: (files) => {
        if (store.getState().phase === 'writing') attachments.add(files, 'dropped');
      },
      onDragging: setDragging,
    });
    const listeners = [
      ['dragenter', target.dragenter],
      ['dragover', target.dragover],
      ['dragleave', target.dragleave],
      ['drop', target.drop],
    ] as const;
    for (const [type, listener] of listeners) window.addEventListener(type, listener);
    return () => {
      for (const [type, listener] of listeners) window.removeEventListener(type, listener);
      setDragging(false);
    };
  }, [withPictures, open, attachments, store]);

  // Leaving the page closes the dialog; the shared store must not bring it back on the next visit,
  // and a job the dialog was holding goes back in line.
  useEffect(
    () => () => {
      void dismissNoteDialog(latestDeps.current, store);
      store.getState().reset();
    },
    [store],
  );

  return (
    <View
      libraryPicker={libraryPicker}
      pictures={
        withPictures
          ? {
              rows: picturesState.rows,
              dragging,
              onFiles: (files, source) => {
                if (store.getState().phase === 'writing') attachments.add(files, source);
              },
              onRemove: attachments.remove,
            }
          : null
      }
      open={open}
      jobName={state.job?.name ?? ''}
      client={state.job?.client ?? ''}
      text={state.text}
      onTextChange={state.setText}
      held={state.held}
      saving={state.phase === 'saving'}
      error={state.error}
      onSave={() => void saveNoteDialog(deps, store)}
      onOpenChange={(open) => {
        if (!open) void dismissNoteDialog(deps, store);
      }}
      onCloseAutoFocus={(event) => {
        // There is no trigger element to give focus back to (the dialog is asked for from the row's
        // right-click menu); the row's own button gets it, or the row.
        event.preventDefault();
        const id = store.getState().job?.id;
        if (id !== undefined) rowFocusTarget(id)?.focus();
      }}
    />
  );
}
