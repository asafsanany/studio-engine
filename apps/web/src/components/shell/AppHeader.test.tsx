import { describe, expect, it } from 'vitest';
import { SidebarProvider } from '@/components/ui/sidebar';
import { renderAt } from '@/lib/test-router';
import { AppHeader } from './AppHeader';

function render(
  jobs: Parameters<typeof AppHeader>[0]['jobs'],
  reconnecting?: boolean,
): Promise<string> {
  return renderAt(
    '/jobs',
    <SidebarProvider>
      <AppHeader crumbs={[{ label: 'Jobs' }]} jobs={jobs} reconnecting={reconnecting} />
    </SidebarProvider>,
  );
}

describe('<AppHeader>', () => {
  it('shows the breadcrumb and the engine summary once the list has loaded', async () => {
    const html = await render([
      { state: 'editing', delivery: null },
      { state: 'queued', delivery: null },
      { state: 'failed', delivery: null },
    ]);
    expect(html).toContain('Jobs');
    expect(html).toContain('aria-label="Engine summary"');
  });

  it('keeps the engine summary out until there is a list (loading, or the engine unreachable)', async () => {
    const html = await render(undefined);
    expect(html).toContain('Jobs');
    expect(html).not.toContain('Engine summary');
    expect(html).not.toContain('editing');
  });

  it('has no notice and keeps the summary while the engine is reachable', async () => {
    const html = await render([{ state: 'editing', delivery: null }], false);
    expect(html).toContain('aria-label="Engine summary"');
    expect(html).not.toContain('Reconnecting');
    expect(html).toContain('role="status"'); // the (empty) region a screen reader listens to
  });

  it('puts "Reconnecting to the engine…" in place of the summary once a list is on screen', async () => {
    const html = await render(
      [
        { state: 'editing', delivery: null },
        { state: 'queued', delivery: null },
      ],
      true,
    );
    expect(html).toContain('Reconnecting to the engine…');
    expect(html).toContain('Jobs');
    // The counts are as last known; they are not shown as if they were live.
    expect(html).not.toContain('Engine summary');
    expect(html).not.toContain('editing');
  });

  it('shows the notice for an empty list too (the list is loaded, only stale)', async () => {
    const html = await render([], true);
    expect(html).toContain('Reconnecting to the engine…');
    expect(html).not.toContain('Engine summary');
  });

  it('says nothing without a list: the page body already says "Can\'t reach the engine."', async () => {
    const html = await render(undefined, true);
    expect(html).not.toContain('Reconnecting');
    expect(html).not.toContain('Engine summary');
  });
});
