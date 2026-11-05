// The phone Review's Effort sheet (board MReviewEffort, and "Effort with Auto" with Quick fixes on).
// A sheet is portaled and has no DOM here, so the element tree the component returns is read
// instead: the rows are plain buttons with their props.

import type { Effort } from '@studio/shared';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { effortIcon, gaugeIcon } from '@/components/effort-gauge';
import { PhoneEffortSheet } from './PhoneEffortSheet';

type Props = Record<string, unknown> & { children?: ReactNode };

/** Every element in `node`, depth first. */
function elements(node: ReactNode): ReactElement<Props>[] {
  const found: ReactElement<Props>[] = [];
  for (const child of Children.toArray(node)) {
    if (!isValidElement<Props>(child)) continue;
    found.push(child, ...elements(child.props.children));
  }
  return found;
}

/** The sheet's tree, with the rows (`data-option`) and the description and title it holds. */
function sheet(effort: Effort | null, auto: boolean) {
  const onChange = vi.fn();
  const onOpenChange = vi.fn();
  const tree = PhoneEffortSheet({ open: true, onOpenChange, effort, onChange, auto });
  const all = elements(tree);
  const rows = all.filter((element) => element.props['data-option'] !== undefined);
  const row = (id: string) => {
    const found = rows.find((element) => element.props['data-option'] === id);
    if (found === undefined) throw new Error(`no row ${id}`);
    return found;
  };
  /** The text a row (or any element) draws, in order, icons left out. */
  const words = (element: ReactElement<Props>): string[] =>
    elements(element.props.children)
      .flatMap((child) => (typeof child.props.children === 'string' ? [child.props.children] : []))
      .filter((text) => text !== '');
  const description = all.find((element) => String(element.type).includes('Description'));
  return { tree, rows, row, words, onChange, onOpenChange, all, description };
}

describe('<PhoneEffortSheet> with Quick fixes off', () => {
  it('has Default and the three levels with their hints, and no Auto', () => {
    const { rows, words } = sheet(null, false);
    expect(rows.map((row) => row.props['data-option'])).toEqual([
      'default',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(words(rows[0] as ReactElement<Props>)).toEqual(['Default', 'Extra high']);
    expect(words(rows[1] as ReactElement<Props>)).toEqual(['Medium', 'quickest']);
  });

  it('checks the job’s level and writes null for Default, then closes', () => {
    const { rows, row, onChange, onOpenChange } = sheet('high', false);
    expect(rows.map((r) => r.props['aria-checked'])).toEqual([false, false, true, false]);
    (row('default').props.onClick as () => void)();
    expect(onChange).toHaveBeenCalledWith(null);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('<PhoneEffortSheet> with Quick fixes on', () => {
  it('has Auto, then Medium, High and Extra high, each waiting for Send', () => {
    const { rows, words } = sheet(null, true);
    expect(rows.map((row) => row.props['data-option'])).toEqual([
      'auto',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(words(rows[0] as ReactElement<Props>)).toEqual([
      'Auto',
      'Text, font and title notes are fixed here at once. The rest runs at the level it needs.',
      'Default',
    ]);
    for (const row of rows.slice(1)) {
      expect(words(row).at(-1)).toBe('waits for Send');
    }
  });

  it('draws sparkles on Auto and a gauge on each level', () => {
    const { rows } = sheet(null, true);
    const iconOf = (row: ReactElement<Props>) =>
      elements(row.props.children).find((child) => child.props['aria-hidden'] === 'true')?.type;
    expect(rows.map(iconOf)).toEqual([
      effortIcon('auto'),
      gaugeIcon('medium'),
      gaugeIcon('high'),
      gaugeIcon('xhigh'),
    ]);
  });

  it('checks Auto for null, or the job’s level', () => {
    expect(sheet(null, true).rows.map((row) => row.props['aria-checked'])).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(sheet('xhigh', true).rows.map((row) => row.props['aria-checked'])).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it('makes Auto’s row taller for its line of help, and no other', () => {
    const { rows } = sheet(null, true);
    expect(String(rows[0]?.props.className)).toContain('min-h-[52px]');
    expect(String(rows[1]?.props.className)).not.toContain('min-h-[52px]');
  });

  it('writes null for Auto and the level for a level, then closes', () => {
    const { row, onChange, onOpenChange } = sheet('high', true);
    (row('auto').props.onClick as () => void)();
    (row('medium').props.onClick as () => void)();
    expect(onChange.mock.calls).toEqual([[null], ['medium']]);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('has no visible line under the title, only one for screen readers', () => {
    const { description } = sheet(null, true);
    expect(String(description?.props.className)).toContain('sr-only');
    expect(description?.props.children).toBe(
      'Auto picks the level for each note. A level you choose holds every note for Send.',
    );
    const off = sheet(null, false).description;
    expect(String(off?.props.className)).not.toContain('sr-only');
    expect(off?.props.children).toBe('Your notes are fixed at this level. Approve takes no level.');
  });
});
