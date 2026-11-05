// When a click on a row opens (or closes) the job under it. A click anywhere on the row does,
// except where the click is meant for something else: a link or button in the row (the client's
// name, the next-step button), a mark that shows a tooltip (the note and the effort), the open
// job's panel, or a drag that selected some text.

/** The panel of the open job, under its row and inside it (`JobRowPanel`). */
export const ROW_PANEL = '[data-slot="job-row-panel"]';

/**
 * What in a row does its own thing when clicked: links, buttons, form controls, the Action cell,
 * the marks (a span with a tooltip that takes the keyboard's focus) and the open job's panel. The
 * status icon is an image with no focus of its own, so a click on it opens the job.
 */
export const ROW_CONTROLS = `a, button, input, select, textarea, [role="button"], [role="img"][tabindex], [data-row-actions], ${ROW_PANEL}`;

/** What the check reads of a click. */
export interface RowClick {
  /** Where the click landed. */
  target: { closest(selector: string): unknown } | null;
  /** The row that got the click. */
  row: { contains(other: unknown): boolean };
  /** 0 is the main button. */
  button: number;
  /** Ctrl and click is a right-click on a Mac. */
  ctrlKey: boolean;
  /** The text selected on the page right now ('' for none). */
  selectedText: string;
}

/**
 * Whether a click opens (or closes) the job under its row. A click that only passes through the
 * row on its way up does not: one in a menu the panel drew outside the row (⋯) is the menu's.
 */
export function opensSheetOnClick({
  target,
  row,
  button,
  ctrlKey,
  selectedText,
}: RowClick): boolean {
  if (button !== 0 || ctrlKey || selectedText !== '') return false;
  if (target !== null && !row.contains(target)) return false;
  const control = target?.closest(ROW_CONTROLS) ?? null;
  // A control around the row (there is none today) is not one of the row's.
  return control === null || !row.contains(control);
}
