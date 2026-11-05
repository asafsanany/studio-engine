import { isValidElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { UnreachableRow } from './JobsTableStates';

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

describe('<UnreachableRow>', () => {
  it('runs the retry when its link is clicked', () => {
    const onRetry = vi.fn();
    const button = findWithProp(UnreachableRow({ columnCount: 8, onRetry }), 'onClick');
    if (!button) throw new Error('no clickable element in the row');
    (button.props.onClick as () => void)();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('is a plain button (type="button"), not a link to nowhere', () => {
    const button = findWithProp(UnreachableRow({ columnCount: 8, onRetry: () => {} }), 'onClick');
    expect(button?.props.type).toBe('button');
    expect(button?.props.variant).toBe('link');
  });
});
