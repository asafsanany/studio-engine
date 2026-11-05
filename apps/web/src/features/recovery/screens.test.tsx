import { createMemoryHistory } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '@/router';
import {
  CONNECTING_LABEL_MS,
  CONNECTING_SLOW_MS,
  ConnectingView,
  connectingStage,
} from './ConnectingScreen';
import { ErrorScreen, ErrorView, errorDetail } from './ErrorScreen';
import { RootErrorBoundary } from './RootErrorBoundary';

describe('<ErrorView>', () => {
  const html = renderToStaticMarkup(<ErrorView detail="boom" onReload={vi.fn()} />);

  it('says what happened and offers a Reload button, as an alert', () => {
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/<h1[^>]*>Something went wrong<\/h1>/);
    expect(html).toMatch(/<button[^>]*>Reload<\/button>/);
    expect(html).toContain('boom');
  });

  it('covers the whole screen on the dark page, readable on it', () => {
    expect(html).toContain('fixed inset-0');
    expect(html).toContain('bg-background');
    expect(html).toContain('text-foreground');
  });

  it('leaves out the detail line when there is none', () => {
    const bare = renderToStaticMarkup(<ErrorView detail="" onReload={vi.fn()} />);
    expect(bare).not.toContain('font-mono');
  });
});

describe('errorDetail', () => {
  it('is the error’s message, cut at 200 characters, and empty for nothing', () => {
    expect(errorDetail(new Error('bad'))).toBe('bad');
    expect(errorDetail('plain')).toBe('plain');
    expect(errorDetail(undefined)).toBe('');
    expect(errorDetail(new Error('x'.repeat(300)))).toHaveLength(201);
  });
});

describe('<RootErrorBoundary>', () => {
  it('draws its children while nothing threw', () => {
    const boundary = new RootErrorBoundary({ children: <p>the app</p> });
    expect(renderToStaticMarkup(boundary.render())).toBe('<p>the app</p>');
  });

  it('draws the Something went wrong screen, with the error, once a child threw', () => {
    const boundary = new RootErrorBoundary({ children: <p>the app</p> });
    boundary.state = RootErrorBoundary.getDerivedStateFromError(new Error('render blew up'));
    const html = renderToStaticMarkup(boundary.render());
    expect(html).toContain('Something went wrong');
    expect(html).toContain('render blew up');
    expect(html).toMatch(/<button[^>]*>Reload<\/button>/);
    expect(html).not.toContain('the app');
  });

  it('is what an <ErrorScreen> without an error looks like too', () => {
    expect(renderToStaticMarkup(<ErrorScreen />)).toContain('Something went wrong');
  });
});

describe('the router’s error screens', () => {
  it('has one for every page and one on the root route (the app frame itself)', () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/jobs'] }));
    expect(router.options.defaultErrorComponent).toBeTypeOf('function');
    expect(router.routeTree.options.errorComponent).toBeTypeOf('function');
    const Screen = router.options.defaultErrorComponent as (props: { error: unknown }) => never;
    expect(renderToStaticMarkup(<Screen error={new Error('page failed')} />)).toContain(
      'page failed',
    );
  });
});

describe('connectingStage', () => {
  it('stays quiet for half a second, says Connecting…, then offers Reload after 6 s', () => {
    expect(connectingStage(0)).toBe('quiet');
    expect(connectingStage(CONNECTING_LABEL_MS - 1)).toBe('quiet');
    expect(connectingStage(CONNECTING_LABEL_MS)).toBe('label');
    expect(connectingStage(CONNECTING_SLOW_MS - 1)).toBe('label');
    expect(connectingStage(CONNECTING_SLOW_MS)).toBe('slow');
  });
});

describe('<ConnectingView>', () => {
  const view = (stage: 'quiet' | 'label' | 'slow') =>
    renderToStaticMarkup(<ConnectingView stage={stage} onReload={vi.fn()} />);

  it('is the dark page and nothing else at first (the layout-pending slot stays for the e2e)', () => {
    const html = view('quiet');
    expect(html).toContain('data-slot="layout-pending"');
    expect(html).toContain('bg-background');
    expect(html).not.toContain('Connecting');
  });

  it('says Connecting… without a button, then adds the hint and Reload when it is slow', () => {
    expect(view('label')).toContain('Connecting…');
    expect(view('label')).not.toContain('<button');
    const slow = view('slow');
    expect(slow).toContain('Connecting…');
    expect(slow).toContain('Tailscale');
    expect(slow).toMatch(/<button[^>]*>Reload<\/button>/);
  });
});
