import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  EmptyJobs,
  LoadingJobRows,
  NoMatchingJobs,
  SKELETON_ROW_COUNT,
  UnreachableJobs,
} from './JobsListStates';

/** The first element in a React element tree whose props include `name`. */
function findWithProp(
  node: ReactNode,
  name: string,
): { props: Record<string, unknown> } | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findWithProp(child, name);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (name in node.props) return node;
  return findWithProp(node.props.children as ReactNode, name);
}

describe('<UnreachableJobs>', () => {
  it('runs the retry when its link is clicked', () => {
    const onRetry = vi.fn();
    const button = findWithProp(UnreachableJobs({ onRetry }), 'onClick');
    if (!button) throw new Error('no clickable element in the block');
    (button.props.onClick as () => void)();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('is a plain button (type="button"), not a link to nowhere', () => {
    const button = findWithProp(UnreachableJobs({ onRetry: () => {} }), 'onClick');
    expect(button?.props.type).toBe('button');
    expect(button?.props.variant).toBe('link');
  });

  it('says it as an alert, centred in a 96 px block with no border', () => {
    const markup = renderToStaticMarkup(<UnreachableJobs onRetry={() => {}} />);
    expect(markup).toMatch(/<span role="alert">Can&#x27;t reach the engine\.<\/span>/);
    expect(markup).toMatch(/<div class="[^"]*\bh-24\b[^"]*\bjustify-center\b[^"]*"/);
    // The block has no border (the button's focus ring class is not one).
    expect(markup.match(/^<div class="([^"]*)"/)?.[1]).not.toContain('border');
  });
});

describe('<EmptyJobs>', () => {
  const markup = renderToStaticMarkup(<EmptyJobs />);

  it('says "No jobs yet." and where to drop a folder, centred in a 160 px block with no border', () => {
    expect(markup).toContain('No jobs yet.');
    expect(markup).toContain('Drop a folder into');
    expect(markup).toContain('Studio Inbox/&lt;Client&gt;/&lt;Job&gt;');
    expect(markup).toContain('to start.');
    expect(markup).toMatch(/<div class="[^"]*\bh-40\b[^"]*\bjustify-center\b[^"]*\btext-center\b/);
    expect(markup.match(/^<div class="([^"]*)"/)?.[1]).not.toContain('border');
  });

  it('shows the folder pattern in monospace, as code', () => {
    expect(markup).toMatch(
      /<code class="[^"]*font-mono[^"]*">Studio Inbox\/&lt;Client&gt;\/&lt;Job&gt;<\/code>/,
    );
  });
});

describe('<NoMatchingJobs>', () => {
  it('says "No matching jobs." muted and centred in a 96 px block with no border', () => {
    const markup = renderToStaticMarkup(<NoMatchingJobs />);
    expect(markup).toContain('No matching jobs.');
    expect(markup).toMatch(/<div class="[^"]*\bh-24\b[^"]*\bjustify-center\b[^"]*"/);
    expect(markup).toContain('text-muted-foreground');
    expect(markup).not.toContain('border');
  });
});

describe('<LoadingJobRows>', () => {
  const markup = renderToStaticMarkup(<ul>{LoadingJobRows()}</ul>);
  const rows = markup.match(/<li [\s\S]*?<\/li>/g) ?? [];

  it('has ten rows', () => {
    expect(SKELETON_ROW_COUNT).toBe(10);
    expect(rows).toHaveLength(10);
  });

  it('shapes each row like a job row: a 44 px grid with an icon, a name, a detail, a time and a button', () => {
    for (const row of rows) {
      expect(row).toContain('data-skeleton-row');
      expect(row).toContain('h-11');
      expect(row).toContain('grid-cols-[16px_minmax(0,1fr)_auto_80px_32px]');
      expect((row.match(/data-slot="skeleton"/g) ?? []).length).toBe(5);
      expect(row).toContain('size-4 rounded-full');
      expect(row).toContain('w-24');
      expect(row).toContain('w-14');
      expect(row).toContain('size-8 rounded-lg');
    }
  });

  it('varies the width of the name bar from row to row', () => {
    const nameBars = rows.map((row) => row.match(/\b(w-(?:40|32|44|36))\b/)?.[1]);
    expect(nameBars.slice(0, 4)).toEqual(['w-40', 'w-32', 'w-44', 'w-36']);
    expect(new Set(nameBars).size).toBe(4);
  });

  it('stands still for people who asked for less motion', () => {
    for (const row of rows) {
      const bones = row.match(/<div[^>]*data-slot="skeleton"[^>]*>/g) ?? [];
      expect(bones).toHaveLength(5);
      for (const bone of bones) expect(bone).toContain('motion-reduce:animate-none');
    }
  });

  it('tells screen readers once', () => {
    expect((markup.match(/Loading jobs…/g) ?? []).length).toBe(1);
    expect(markup).toContain('<span role="status" class="sr-only">Loading jobs…</span>');
  });
});
