import { findRelease, RELEASES } from '@studio/shared';
import { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { whatsNewStore } from '@/components/whats-new/whats-new-store';
import { APP_VERSION, APP_VERSION_LABEL } from '@/lib/version';
import { SidebarVersion } from './SidebarVersion';

describe('<SidebarVersion>', () => {
  const html = renderToStaticMarkup(<SidebarVersion />);

  it('is a ghost button showing the version', () => {
    expect(html).toMatch(/^<button\b/);
    expect(html).toContain('type="button"');
    expect(html).toContain('data-variant="ghost"');
    expect(html).toContain(`>${APP_VERSION_LABEL}</button>`);
  });

  it('says what it opens', () => {
    expect(html).toContain(`aria-label="What&#x27;s new in version ${APP_VERSION}"`);
  });

  it('is 12 px muted text, 28 px tall, and hidden when the sidebar is collapsed', () => {
    expect(html).toContain('text-xs');
    expect(html).toContain('text-muted-foreground');
    expect(html).toContain('h-7');
    expect(html).toContain('tabular-nums');
    expect(html).toContain('group-data-[collapsible=icon]:hidden');
  });

  it('opens the notes of the running version, alone, when clicked', () => {
    // The page may already have queued its first-open dialog; close it first.
    whatsNewStore.getState().close();
    expect(whatsNewStore.getState().open).toBe(false);

    const button = SidebarVersion();
    expect(isValidElement<{ onClick: () => void }>(button)).toBe(true);
    (button as { props: { onClick: () => void } }).props.onClick();

    expect(whatsNewStore.getState().open).toBe(true);
    expect(whatsNewStore.getState().releases).toEqual([findRelease(RELEASES, APP_VERSION)]);
    whatsNewStore.getState().close();
    expect(whatsNewStore.getState().open).toBe(false);
  });
});
