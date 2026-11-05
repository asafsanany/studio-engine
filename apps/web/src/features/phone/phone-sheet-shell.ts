// What the phone's bottom sheets have in common (the job sheet, Mark paid): the shell's classes,
// and the rule that a tap on a message is not a tap on the page behind. Kept apart from the sheets
// so that one sheet can use it without importing another.

/** The app's messages (sonner's toaster): a tap on one does not close a sheet. */
const TOASTER = '[data-sonner-toaster]';

/**
 * The shell of a phone sheet (boards MJobSheet*, MMarkPaid): from the bottom edge, a 16 px top
 * radius, at most 790 px tall (the board's, and never taller than the screen less 54 px), scrolling
 * inside itself, in the card colour, with room for the home indicator under it. It slides in and
 * out in 200 ms with the Sheet's own ease-in-out. It has no padding: the header and the body make
 * their own.
 */
export const PHONE_SHEET_CLASSES =
  'max-h-[min(790px,calc(100dvh-54px))] gap-0 overflow-y-auto overscroll-contain rounded-t-2xl border-t border-white/10 bg-card p-0 pb-[max(34px,var(--safe-bottom))] data-[state=closed]:duration-200 data-[state=open]:duration-200';

/**
 * For a sheet's `onInteractOutside`: a tap on a message (its Undo: "Delivered to RGM · ₪40 counts in
 * October") is not a tap on the page behind, so the sheet stays, as on board MJobSheet, and shows
 * the change.
 */
export function ignoreMessageTaps(event: { target: EventTarget | null; preventDefault(): void }) {
  // Not `instanceof Element`: only an element answers `closest`, and a test can pass a stand-in.
  const target = event.target as Partial<Pick<Element, 'closest'>> | null;
  if (typeof target?.closest === 'function' && target.closest(TOASTER)) event.preventDefault();
}
