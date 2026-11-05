// How files reach the Import fonts dialog, apart from its own buttons, as plain TypeScript so the
// rules are tested without a browser: a drop on the page while the dialog is closed opens it with
// the files at step 2; a drop anywhere while it is open at step 1 counts too; and closing it from
// outside throws an unfinished upload away.

import type { FontImportSession } from './font-import-session';

export interface FontImportIntakeDeps {
  session: Pick<FontImportSession, 'take' | 'cancel'>;
  /** The engine cannot be reached right now: nothing is taken. */
  isOffline: () => boolean;
  /** Asks the page to open the dialog (the page owns whether it is open). */
  onOpenChange: (open: boolean) => void;
}

export interface FontImportIntake {
  /** Files were dropped on the page while the dialog is closed: open it and stage them. */
  dropOnPage(files: readonly File[]): void;
  /** Files were dropped anywhere while the dialog is open: it stages them if it is at step 1. */
  dropInDialog(files: readonly File[]): void;
  /** The dialog's `open` flag, as the page holds it, changed (and once at the start). */
  openChanged(open: boolean): void;
}

export function createFontImportIntake({
  session,
  isOffline,
  onOpenChange,
}: FontImportIntakeDeps): FontImportIntake {
  /** The files that asked for the dialog, until the page has opened it. */
  let waiting: readonly File[] | null = null;

  return {
    dropOnPage(files) {
      if (isOffline()) return;
      waiting = files;
      onOpenChange(true);
    },
    dropInDialog(files) {
      if (!isOffline()) session.take(files);
    },
    openChanged(open) {
      if (!open) {
        // Closed from outside (the page, or a successful import): throw an unfinished upload away.
        waiting = null;
        session.cancel();
        return;
      }
      const files = waiting;
      waiting = null;
      if (files !== null && !isOffline()) session.take(files);
    },
  };
}
