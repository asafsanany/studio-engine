import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { StatusTab } from '@/stores/jobs-ui';
import { EngineSummary } from './EngineSummary';

const board = [
  { state: 'editing', delivery: null },
  { state: 'queued', delivery: null },
  { state: 'queued', delivery: null },
  { state: 'review', delivery: null },
  { state: 'held', delivery: null },
  { state: 'failed', delivery: null },
  { state: 'cancelled', delivery: null },
  { state: 'ready', delivery: null },
] as const;

/** Text of the rendered summary with tags removed, e.g. "1 editing 2 queued 1 in review 3 need attention". */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every element in a (not yet rendered) React tree that has an `onClick`. */
function clickables(node: ReactNode): ReactElement<{ onClick: () => void }>[] {
  const found: ReactElement<{ onClick: () => void }>[] = [];
  const visit = (child: ReactNode) => {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) return;
    if (typeof child.props.onClick === 'function') {
      found.push(child as ReactElement<{ onClick: () => void }>);
    }
    Children.forEach(child.props.children, visit);
  };
  visit(node);
  return found;
}

describe('<EngineSummary>', () => {
  it('shows the live counts with their labels', () => {
    const html = renderToStaticMarkup(<EngineSummary jobs={[...board]} onSelectTab={() => {}} />);
    expect(text(html)).toBe('1 editing 2 queued 1 in review 3 need attention');
  });

  it('says "needs attention" for a single job and shows zeros for none', () => {
    const one = renderToStaticMarkup(
      <EngineSummary jobs={[{ state: 'failed', delivery: null }]} onSelectTab={() => {}} />,
    );
    expect(text(one)).toBe('0 editing 0 queued 0 in review 1 needs attention');
    const none = renderToStaticMarkup(<EngineSummary jobs={[]} onSelectTab={() => {}} />);
    expect(text(none)).toBe('0 editing 0 queued 0 in review 0 need attention');
  });

  it('shows nothing without a list: no zeros while loading or when the engine cannot be reached', () => {
    const html = renderToStaticMarkup(<EngineSummary jobs={undefined} onSelectTab={() => {}} />);
    expect(html).toBe('');
    expect(html).not.toContain('0');
  });

  it('shows real zeros once an empty list has loaded', () => {
    const html = renderToStaticMarkup(<EngineSummary jobs={[]} onSelectTab={() => {}} />);
    expect(text(html)).toBe('0 editing 0 queued 0 in review 0 need attention');
  });

  it('renders four buttons in a labelled group, with decorative dots', () => {
    const html = renderToStaticMarkup(<EngineSummary jobs={[]} onSelectTab={() => {}} />);
    expect(html).toContain('aria-label="Engine summary"');
    expect(html.match(/<button/g)).toHaveLength(4);
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(4);
    expect(html).toContain('bg-status-editing');
    expect(html).toContain('bg-status-neutral');
    expect(html).toContain('bg-status-review');
    expect(html).toContain('bg-status-failed');
  });

  it('switches editing and queued to In progress, review to Review and attention to Needs attention', () => {
    const picked: StatusTab[] = [];
    const tree = EngineSummary({ jobs: [...board], onSelectTab: (tab) => picked.push(tab) });
    const buttons = clickables(tree);
    expect(buttons).toHaveLength(4);
    for (const button of buttons) button.props.onClick();
    expect(picked).toEqual(['progress', 'progress', 'review', 'attention']);
  });

  it('selects the Review tab when the review counter is clicked', () => {
    const onSelectTab = vi.fn();
    const buttons = clickables(
      EngineSummary({ jobs: [{ state: 'review', delivery: null }], onSelectTab }),
    );
    buttons[2]?.props.onClick();
    expect(onSelectTab).toHaveBeenCalledExactlyOnceWith('review');
  });

  it('reports each click once', () => {
    const onSelectTab = vi.fn();
    const [editing] = clickables(EngineSummary({ jobs: [], onSelectTab }));
    editing?.props.onClick();
    expect(onSelectTab).toHaveBeenCalledTimes(1);
    expect(onSelectTab).toHaveBeenCalledWith('progress');
  });
});
