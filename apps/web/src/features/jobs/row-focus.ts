import { ROW_PANEL } from './row-open';

/**
 * Where focus goes when a page-level dialog (Stop this edit?, Note for the editor) closes, if the
 * job's row is on the page right now: the button of its Action cell, or, when it has none (an
 * editing job's Cancel… is in the row's menu), the row. The dialogs are asked for from the row's
 * right-click menu, so there is no trigger element to give focus back to.
 */
export function rowFocusTarget(jobId: string): HTMLElement | null {
  const id = CSS.escape(jobId);
  const button = document
    .querySelector(`[data-row-actions="${id}"]`)
    ?.querySelector<HTMLElement>('a, button');
  return button ?? document.querySelector<HTMLElement>(`[data-job-id="${id}"]`);
}

/**
 * Gives focus to a job's row (not to a control in it), if the row is on the page: where focus goes
 * back to when the job sheet closes. Resolves to whether there was a row to focus.
 */
export function focusJobRow(jobId: string): boolean {
  const row = document.querySelector<HTMLElement>(`[data-job-id="${CSS.escape(jobId)}"]`);
  row?.focus();
  return row !== null;
}

/**
 * The row an arrow key moves to from `currentId` (the id of the row, or of a row with the focus
 * inside it; `null` when focus is on none): ↓ the next row, ↑ the previous, Home the first and End
 * the last. At either end the row stays. `null` for any other key.
 */
export function rowToFocus(
  ids: readonly string[],
  currentId: string | null,
  key: string,
): string | null {
  if (ids.length === 0) return null;
  const at = currentId === null ? -1 : ids.indexOf(currentId);
  switch (key) {
    case 'ArrowDown':
      return ids[Math.min(ids.length - 1, at + 1)] ?? null;
    case 'ArrowUp':
      return ids[Math.max(0, at - 1)] ?? null;
    case 'Home':
      return ids[0] ?? null;
    case 'End':
      return ids[ids.length - 1] ?? null;
    default:
      return null;
  }
}

/** What in a row can take the Tab key: its links, its buttons and the marks that show a tooltip. */
const ROW_TAB_STOPS = 'a[href], button, [tabindex="0"]';

/** Where the original tab index of an element taken out of the Tab order is kept. */
const KEPT_TAB_INDEX = 'data-roving-tabindex';

/**
 * Makes the list one Tab stop: only the row `tabStopId` (and what is inside it) can be reached
 * with Tab. Every other row's controls (client link, marks, next-step button) are taken out of the
 * Tab order, and put back when that row becomes the stop. The rows themselves are `tabIndex` 0 or
 * -1 in the markup; this is for what is inside them. The rows may sit one level down, under their
 * client's header (By client). An open job's panel, inside its row, is left as it is.
 */
export function applyRovingTabStops(list: HTMLElement, tabStopId: string | null): void {
  for (const row of list.querySelectorAll<HTMLElement>('[data-job-id]')) {
    const isStop = row.dataset.jobId === tabStopId;
    for (const element of row.querySelectorAll<HTMLElement>(
      `${ROW_TAB_STOPS}, [${KEPT_TAB_INDEX}]`,
    )) {
      // The open job's panel is not the row's: its buttons stay in the Tab order.
      if (element.closest(ROW_PANEL) !== null) continue;
      const kept = element.getAttribute(KEPT_TAB_INDEX);
      if (isStop) {
        if (kept === null) continue;
        if (kept === '') element.removeAttribute('tabindex');
        else element.setAttribute('tabindex', kept);
        element.removeAttribute(KEPT_TAB_INDEX);
      } else if (kept === null) {
        element.setAttribute(KEPT_TAB_INDEX, element.getAttribute('tabindex') ?? '');
        element.setAttribute('tabindex', '-1');
      }
    }
  }
}
