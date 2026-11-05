import { describe, expect, it } from 'vitest';
import { inTypingField } from './job-sheet-keys';

describe('inTypingField', () => {
  it('is whether the target is, or is inside, a field or a control that reads the arrow keys', () => {
    const asks: string[] = [];
    const target = {
      closest(selector: string) {
        asks.push(selector);
        return {};
      },
    };
    expect(inTypingField(target)).toBe(true);
    expect(inTypingField({ closest: () => null })).toBe(false);
    expect(inTypingField(null)).toBe(false);
    // The selector covers fields, menus and the like.
    const selector = asks[0] ?? '';
    for (const part of [
      'input',
      'textarea',
      'select',
      '[contenteditable="true"]',
      '[role="menu"]',
    ]) {
      expect(selector).toContain(part);
    }
  });
});
