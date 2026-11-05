// The keys of the @ picker (board LUReview). They are pressed in the textarea, never in the list,
// so the focus stays where the typing is. Pure, like review/notes-logic.ts.

export interface PickerKeyEvent {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  /** An IME composition is running (or its confirming key press, `keyCode` 229). */
  isComposing: boolean;
}

export type PickerKeyAction = 'next' | 'prev' | 'insert' | 'close';

/**
 * What a key does while the picker is open, or `null` (the textarea gets it as usual). Esc always
 * closes. ↓ ↑ move, and Enter or Tab (no Shift, Meta or Ctrl, so Cmd/Ctrl+Enter still adds the
 * note) insert the highlighted item; those four need a row to act on, and with the "no match"
 * panel showing (`count` 0) they are left to the textarea. A key during an IME composition belongs
 * to the composition. The caller calls `preventDefault` exactly when this answers an action.
 */
export function pickerKeyAction(event: PickerKeyEvent, count: number): PickerKeyAction | null {
  if (event.isComposing) return null;
  if (event.key === 'Escape') return 'close';
  if (count <= 0) return null;
  if (event.key === 'ArrowDown') return 'next';
  if (event.key === 'ArrowUp') return 'prev';
  if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) return 'insert';
  if (event.key === 'Tab' && !event.shiftKey) return 'insert';
  return null;
}
