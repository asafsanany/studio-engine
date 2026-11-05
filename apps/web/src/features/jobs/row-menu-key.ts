/** Shift+F10 and the keyboard's menu key: the two keys that ask for the context menu. */
export function isContextMenuKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
}

/** A box on the screen, as `getBoundingClientRect` gives it (only what the point needs). */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
  bottom: number;
}

/** How far in from a row's left edge its menu opens when the row itself has the focus. */
const ROW_MENU_INSET = 48;

/**
 * Where the menu opens when it is asked for by key: under the focused control's left edge, like
 * the browser does where it supports the key. When the row itself is focused (there is no control
 * to point at) it opens near the row's left edge, halfway down it.
 */
export function keyboardMenuPoint(row: Box, focused: Box | null): { x: number; y: number } {
  if (focused === null) return { x: row.left + ROW_MENU_INSET, y: row.top + row.height / 2 };
  return { x: focused.left, y: focused.bottom };
}

/**
 * Opens the row's menu from the keyboard. Chrome on Windows and Linux turns Shift+F10 and the menu
 * key into a `contextmenu` event itself; on a Mac it does nothing, so the row asks for the same
 * event, at the focused control, and Radix opens the menu as it does for a right-click. (A browser
 * that also sends its own just moves the open menu to where this one was.)
 */
export function openMenuFromKeyboard(row: HTMLElement, target: Element): void {
  const focused = target === row ? null : target.getBoundingClientRect();
  const { x, y } = keyboardMenuPoint(row.getBoundingClientRect(), focused);
  target.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 2,
    }),
  );
}
