// The words of the Import LUTs dialog, the page-wide drop and the toast, copied from the boards
// LUPage and LUStates, and the small formats they use (a file's size, a count of LUTs).

import { LUT_LIMITS, LUT_MESSAGES } from '@studio/shared';

export const LUT_IMPORT_TEXT = {
  title: 'Import LUTs',
  /** Under the title at step 1. */
  pick: 'Pick the files. LUTs are checked before they are added.',
  /** Under the title while the files go up and are checked, and while they are copied. */
  working: 'Please wait. This takes a few seconds.',
  /** Under the title when no file in the list can be imported (all failed their check). */
  noneGood: 'None of these files can be imported.',
  dropTitle: 'Drop .cube or .3dl files here',
  dropHint: 'One file, or a whole folder of them',
  chooseFiles: 'Choose files…',
  chooseFolder: 'Choose a folder…',
  /** Footer, small and dim. */
  footer: 'Copied into _LUTs in your Studio Inbox, so the originals can move.',
  cancel: 'Cancel',
  /** The filled button when nothing can be imported yet. */
  importIdle: 'Import',
  retry: 'Try again',
  /** The engine did not answer: nothing reached it, so nothing was added. */
  unreachable: "Couldn't reach the engine. Nothing was added.",
  /** The zone and the buttons are off while the engine cannot be reached. */
  offline: 'Importing waits until the engine is back.',
  /** A folder (picked or dropped) with no .cube or .3dl file in it. */
  emptyFolder: 'There are no .cube or .3dl files in there.',
  overlayTitle: 'Drop to import',
  overlayHint: '.cube or .3dl files, or a folder of them',
  filesLabel: 'Files to import',
  kindLabel: 'What is it?',
  tooMany: LUT_MESSAGES.tooManyFiles,
  maxFiles: LUT_LIMITS.filesPerImport,
} as const;

/** "1 file" / "2 files". */
export function filesText(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}

/** "1 LUT" / "2 LUTs". */
export function lutsText(count: number): string {
  return `${count} ${count === 1 ? 'LUT' : 'LUTs'}`;
}

/** Under the title once files are picked. */
export function pickedSubline(count: number): string {
  return `${filesText(count)} picked. Say what each one is, so the grade uses it the right way.`;
}

/** The size of a file as a row says it: "812 B", "96 KB", "1.4 MB" (binary units). */
export function lutBytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "Checking and copying 2 LUTs…" */
export function copyingText(count: number): string {
  return `Checking and copying ${lutsText(count)}…`;
}

/** The label of the filled button: "Import 2 LUTs". */
export function importLabel(count: number): string {
  return count > 0 ? `Import ${lutsText(count)}` : LUT_IMPORT_TEXT.importIdle;
}
