import type { Effort } from '@studio/shared';
import { DropdownMenu } from 'radix-ui';
import { isValidElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ReviewEffortList, ReviewEffortMenu } from './ReviewEffortMenu';
import { renderReview, tagWith } from './test-helpers';

const menu = (effort: Parameters<typeof ReviewEffortMenu>[0]['effort'], disabled = false) =>
  renderReview(<ReviewEffortMenu effort={effort} onChange={() => {}} disabled={disabled} />);

describe('<ReviewEffortMenu>', () => {
  it('is an outline button that opens a menu, 36 px tall, named "Effort: Default" for a job on Default', () => {
    const html = menu(null);
    const button = tagWith(html, 'data-slot="review-effort"');
    expect(button).toContain('type="button"');
    expect(button).toContain('aria-haspopup="menu"');
    expect(button).toContain('h-9');
    expect(button).toContain('border');
    expect(html).toContain('Effort: Default');
  });

  it.each([
    ['medium', 'Effort: Medium', 'M12 14 6.6 12.3'],
    ['high', 'Effort: High', 'M12 14V8.3'],
    ['xhigh', 'Effort: Extra high', 'M12 14 17.4 12.3'],
  ] as const)('shows %s as "%s", with the gauge at its place', (effort, text, needle) => {
    const html = menu(effort);
    expect(html).toContain(text);
    expect(html).toContain('lucide-gauge');
    expect(html).toContain(`d="${needle}"`);
  });

  it('shows Default with the needle of the level it runs at (Extra high)', () => {
    const html = menu(null);
    expect(html).toContain('Effort: Default');
    expect(html).toContain('d="M12 14 17.4 12.3"');
  });

  it('has the gauge and the arrow as decoration', () => {
    const html = menu('high');
    expect(html).toMatch(/<svg[^>]*lucide-gauge[^>]*aria-hidden="true"/);
    expect(html).toMatch(/<svg[^>]*lucide-chevron-down[^>]*aria-hidden="true"/);
  });

  it('is off while Send is on its way', () => {
    expect(tagWith(menu('xhigh', true), 'data-slot="review-effort"')).toContain('disabled=""');
    expect(tagWith(menu('xhigh', false), 'data-slot="review-effort"')).not.toContain('disabled=""');
  });

  it('keeps its list closed until it is opened', () => {
    expect(menu('xhigh')).not.toContain('role="menu"');
  });
});

// --- with Quick fixes on: Auto (board "Effort with Auto") ----------------------------------------

const autoMenu = (effort: Effort | null, disabled = false) =>
  renderReview(<ReviewEffortMenu effort={effort} onChange={() => {}} disabled={disabled} auto />);

/** The list, open, as the menu draws it (its content is not portaled here). */
const openList = (effort: Effort | null, auto: boolean) =>
  renderReview(
    <DropdownMenu.Root open>
      <DropdownMenu.Trigger>Effort</DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <ReviewEffortList effort={effort} onChange={() => {}} auto={auto} />
      </DropdownMenu.Content>
    </DropdownMenu.Root>,
  );

interface Drawn {
  checked: boolean;
  /** The words of the item, in order: label, hint and Auto's line of help. */
  words: string[];
}

/** The radio items of an open list: whether each is checked and what it says. */
function drawn(html: string): Drawn[] {
  const starts = [...html.matchAll(/<div role="menuitemradio" aria-checked="(true|false)"/g)];
  return starts.map((match, index) => {
    const from = match.index ?? 0;
    const to = starts[index + 1]?.index ?? html.length;
    const inner = html
      .slice(from, to)
      .replace(/<svg.*?<\/svg>/gs, '')
      .replace(/<div role="separator".*$/s, '');
    return {
      checked: match[1] === 'true',
      words: inner
        .split(/<[^>]*>/)
        .map((text) => text.trim())
        .filter((text) => text !== ''),
    };
  });
}

/** The first element in `node` that has the prop `name`, looking through components' children and fragments. */
function findProp(node: ReactNode, name: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findProp(child as ReactNode, name);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (name in node.props) return node.props;
  return findProp(node.props.children as ReactNode, name);
}

describe('<ReviewEffortMenu> with Quick fixes on', () => {
  it('shows "Effort: Auto" with sparkles for a job on Auto (null), not a gauge', () => {
    const html = autoMenu(null);
    expect(html).toContain('Effort: Auto');
    expect(html).toMatch(/<svg[^>]*lucide-sparkles[^>]*aria-hidden="true"/);
    expect(html).not.toContain('lucide-gauge');
    expect(html).not.toContain('Default');
  });

  it.each([
    ['medium', 'Effort: Medium', 'M12 14 6.6 12.3'],
    ['high', 'Effort: High', 'M12 14V8.3'],
    ['xhigh', 'Effort: Extra high', 'M12 14 17.4 12.3'],
  ] as const)('shows a chosen level (%s) as "%s" with its gauge', (effort, text, needle) => {
    const html = autoMenu(effort);
    expect(html).toContain(text);
    expect(html).toContain('lucide-gauge');
    expect(html).toContain(`d="${needle}"`);
    expect(html).not.toContain('lucide-sparkles');
  });

  it('is the same outline button, 36 px tall, with the arrow, and off while Send is on its way', () => {
    const button = tagWith(autoMenu(null), 'data-slot="review-effort"');
    expect(button).toContain('aria-haspopup="menu"');
    expect(button).toContain('h-9');
    expect(button).not.toContain('disabled=""');
    expect(tagWith(autoMenu(null, true), 'data-slot="review-effort"')).toContain('disabled=""');
    expect(autoMenu('high')).toMatch(/<svg[^>]*lucide-chevron-down[^>]*aria-hidden="true"/);
  });

  it('keeps its list closed until it is opened', () => {
    expect(autoMenu(null)).not.toContain('role="menu"');
  });

  it('lists the label, Auto with Default and its line of help, a line, then the three levels', () => {
    const html = openList(null, true);
    expect(html).toContain('Effort for the fixes');
    expect(drawn(html)).toEqual([
      {
        checked: true,
        words: [
          'Auto',
          'Default',
          'Text, font and title notes are fixed here at once. The rest runs at the level it needs.',
        ],
      },
      { checked: false, words: ['Medium', 'waits for Send'] },
      { checked: false, words: ['High', 'waits for Send'] },
      { checked: false, words: ['Extra high', 'waits for Send'] },
    ]);
    // The heading's line, then one under Auto, which is the only one in the list.
    expect(html.match(/role="separator"/g)).toHaveLength(2);
    const afterAuto = html.indexOf('Text, font and title notes');
    expect(html.slice(afterAuto)).toContain('role="separator"');
    expect(html.slice(html.indexOf('role="separator"', afterAuto) + 10)).not.toContain(
      'role="separator"',
    );
  });

  it('checks the job’s review effort: Auto for null, else the level', () => {
    const checked = (effort: Effort | null) =>
      drawn(openList(effort, true)).map((item) => item.checked);
    expect(checked(null)).toEqual([true, false, false, false]);
    expect(checked('medium')).toEqual([false, true, false, false]);
    expect(checked('high')).toEqual([false, false, true, false]);
    expect(checked('xhigh')).toEqual([false, false, false, true]);
  });

  it('writes null for Auto and the level for a level', () => {
    const onChange = vi.fn();
    const group = findProp(
      ReviewEffortList({ effort: 'high', onChange, auto: true }),
      'onValueChange',
    );
    const choose = group?.onValueChange as (id: string) => void;
    choose('auto');
    choose('medium');
    choose('xhigh');
    expect(onChange.mock.calls).toEqual([[null], ['medium'], ['xhigh']]);
  });
});

describe('<ReviewEffortMenu> with Quick fixes off', () => {
  it('lists today’s choices: Default (Extra high), a line, then the levels with their hints', () => {
    const html = openList(null, false);
    expect(drawn(html)).toEqual([
      { checked: true, words: ['Default', 'Extra high'] },
      { checked: false, words: ['Medium', 'quickest'] },
      { checked: false, words: ['High', 'slower'] },
      { checked: false, words: ['Extra high', 'slowest'] },
    ]);
    expect(html).not.toContain('Auto');
    expect(html).not.toContain('waits for Send');
  });

  it('keeps the gauge and "Effort: Default" on the button, never sparkles', () => {
    const html = menu(null);
    expect(html).toContain('Effort: Default');
    expect(html).toContain('lucide-gauge');
    expect(html).not.toContain('lucide-sparkles');
  });

  it('writes null for Default, as before', () => {
    const onChange = vi.fn();
    const group = findProp(ReviewEffortList({ effort: 'high', onChange }), 'onValueChange');
    const choose = group?.onValueChange as (id: string) => void;
    choose('default');
    choose('medium');
    expect(onChange.mock.calls).toEqual([[null], ['medium']]);
  });
});
