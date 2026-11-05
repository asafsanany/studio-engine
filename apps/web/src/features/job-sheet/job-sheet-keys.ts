// Whether a key belongs to a field or control rather than to the open job: Esc in the job under its
// row closes it, except where a field or a control is reading the keys itself.

/** Fields and controls that read the arrow keys or text themselves. */
const FIELD_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="radiogroup"]',
  '[role="tablist"]',
  '[role="menu"]',
  '[role="menubar"]',
].join(', ');

/** Whether a key pressed on `target` is for the control, not for the open job. */
export function inTypingField(target: { closest(selector: string): unknown } | null): boolean {
  return target !== null && target.closest(FIELD_SELECTOR) !== null;
}
