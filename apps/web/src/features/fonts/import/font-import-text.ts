// The words of the Import fonts dialog, the page-wide drop and the toast, copied from the boards
// FOPage and FOStates, and the small formats they use (a count of fonts, items and files).

import { FONT_LIMITS, FONT_MESSAGES, fontFilesWord } from '@studio/shared';

export const FONT_IMPORT_TEXT = {
  title: 'Import fonts',
  /** Under the title at step 1. */
  pick: 'Pick the files. Fonts are checked before they are added.',
  /** Under the title while the files go up and are checked, and while they are copied. */
  working: 'Please wait. This takes a few seconds.',
  /** The zone's two lines (board FOStates 3). */
  dropTitle: 'Drop .ttf, .otf, .woff or .woff2 files here',
  dropHint: 'One file, a whole family’s folder, or your entire fonts folder',
  chooseFiles: 'Choose files…',
  chooseFolder: 'Choose a folder…',
  /** Footer, small and dim. */
  footer:
    'Copied into _Fonts in your Studio Inbox, sorted into Hebrew + English or English only, so the originals can move.',
  cancel: 'Cancel',
  /** The filled button when nothing can be imported yet. */
  importIdle: 'Import',
  /** The filled button while the fonts are copied. */
  importing: 'Importing…',
  retry: 'Try again',
  /** The engine did not answer: nothing reached it, so nothing was added. */
  unreachable: 'Couldn’t reach the engine. Nothing was added.',
  /** The zone and the buttons are off while the engine cannot be reached. */
  offline: 'Importing waits until the engine is back.',
  /** A folder (picked or dropped) with no font file in it. */
  emptyFolder: 'There are no .ttf, .otf, .woff or .woff2 files in there.',
  overlayTitle: 'Drop to import',
  overlayHint: '.ttf, .otf, .woff or .woff2 files, or a folder of them',
  listLabel: 'Fonts to import',
  /** The tags at the end of a row (board FOPage). */
  tagNew: 'New',
  tagSame: 'Already here',
  tagBad: 'Can’t import',
  tooMany: FONT_MESSAGES.tooManyFiles,
  maxFiles: FONT_LIMITS.filesPerImport,
} as const;

/** "1 font" / "2 fonts". */
export function fontsText(count: number): string {
  return `${count} ${count === 1 ? 'font' : 'fonts'}`;
}

/** "1 item" / "4 items": what the list holds (a family, or a file that is not a font). */
export function itemsText(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

/** "Adds 2": the tag of a family that is here and gains weights. */
export function addsTag(weights: number): string {
  return `Adds ${weights}`;
}

/** Under the title once the check is back (board FOStates 4). */
export function pickedSubline(count: number): string {
  return `${itemsText(count)} picked. Families are read from inside the files, so file and folder names don’t matter.`;
}

/** Under the title after an upload that did not go through: the files stay, nothing was added. */
export function failedSubline(files: number): string {
  return `${fontFilesWord(files)} picked. Nothing was added.`;
}

/** "Checking 237 files…" while the upload goes up and is read. */
export function checkingText(files: number): string {
  return `Checking ${fontFilesWord(files)}…`;
}

/** "Checking and copying 2 fonts…" (board FOStates 5). */
export function copyingText(count: number): string {
  return `Checking and copying ${fontsText(count)}…`;
}

/** The label of the filled button: "Import 2 fonts". */
export function importLabel(count: number): string {
  return count > 0 ? `Import ${fontsText(count)}` : FONT_IMPORT_TEXT.importIdle;
}
