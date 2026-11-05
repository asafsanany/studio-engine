import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createTestQueryClient } from '@/data/test-utils';
import { createRenameDialogStore } from '../rename-job-dialog';

// Same stand-in for the Radix alert dialog as in the other hosts' tests: a portal does not render
// on a server.
vi.mock('@/components/ui/alert-dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    AlertDialog: ({ open, children }: Props) =>
      open ? h('div', { 'data-open': '' }, children) : null,
    AlertDialogContent: ({ children }: Props) => h('div', { role: 'alertdialog' }, children),
    AlertDialogHeader: ({ children }: Props) => h('header', null, children),
    AlertDialogTitle: ({ children }: Props) => h('h2', null, children),
    AlertDialogDescription: ({ children }: Props) => h('p', null, children),
    AlertDialogFooter: ({ children }: Props) => h('footer', null, children),
    AlertDialogCancel: ({ disabled, children }: Props) =>
      h('button', { 'data-role': 'cancel', disabled }, children),
    AlertDialogAction: ({ disabled, children }: Props) =>
      h('button', { 'data-role': 'confirm', disabled }, children),
  };
});

const { RenameJobDialogHost } = await import('./RenameJobDialogHost');

const TARGET = { id: 'j1', client: 'Kova Coffee', name: 'Spring menu' };

/** A server render reads a store's initial state, so each test builds a store already in its state. */
function host(initial: Parameters<typeof createRenameDialogStore>[0]) {
  return renderToStaticMarkup(
    <QueryClientProvider client={createTestQueryClient()}>
      <RenameJobDialogHost store={createRenameDialogStore(initial)} />
    </QueryClientProvider>,
  );
}

describe('<RenameJobDialogHost>', () => {
  it('shows nothing while no row has asked', () => {
    expect(host({})).toBe('');
  });

  it('asks for the new name with the current one in the box, and says the folder follows', () => {
    const markup = host({ job: TARGET, name: 'Spring menu' });

    expect(markup).toContain('Rename this video');
    expect(markup).toContain('Its folder and its exported file get the new name too.');
    expect(markup).toContain('value="Spring menu"');
    expect(markup).not.toContain('role="alert"');
  });

  it('keeps Rename off until the name is a new one', () => {
    const unchanged = host({ job: TARGET, name: 'Spring menu' });
    const changed = host({ job: TARGET, name: 'Summer menu' });

    expect(unchanged).toMatch(/data-role="confirm" disabled/);
    expect(changed).not.toMatch(/data-role="confirm" disabled/);
  });

  it('says why a name cannot be used, under the input', () => {
    const markup = host({ job: TARGET, name: 'Spring/menu' });

    expect(markup).toContain('A name cannot have a slash or a colon.');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toMatch(/data-role="confirm" disabled/);
  });

  it('shows the server’s refusal under the input', () => {
    const markup = host({
      job: TARGET,
      name: 'Summer menu',
      error: 'There is already a video called “Summer menu” for this client.',
    });

    expect(markup).toContain('There is already a video called “Summer menu” for this client.');
    expect(markup).toContain('role="alert"');
  });

  it('shows the request in flight: a spinner, Renaming…, and nothing to press', () => {
    const markup = host({ job: TARGET, name: 'Summer menu', pending: true });

    expect(markup).toContain('Renaming…');
    expect(markup).toContain('animate-spin');
    expect(markup).toMatch(/data-role="confirm" disabled/);
    expect(markup).toMatch(/data-role="cancel" disabled/);
    expect(markup).toMatch(/<input[^>]* disabled/);
  });
});
