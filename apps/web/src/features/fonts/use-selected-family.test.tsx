import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateFontsSearch } from './font-address';
import { type SelectedFamily, useSelectedFamily } from './use-selected-family';

// The hook the Fonts list and pane share, on a router that has the Fonts page's address.

afterEach(() => {
  vi.unstubAllGlobals();
});

async function open(path: string) {
  let hook: SelectedFamily | undefined;
  function Probe() {
    hook = useSelectedFamily();
    return <p>{hook.selected ?? 'none'}</p>;
  }
  const rootRoute = createRootRoute();
  const fontsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/fonts',
    component: Probe,
    validateSearch: validateFontsSearch,
  });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree: rootRoute.addChildren([fontsRoute]), history });
  await router.load();
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  if (hook === undefined) throw new Error('the probe did not render');
  return { html, hook, history, router };
}

/**
 * Makes the router behave as it does in the browser: one built outside a browser takes itself for
 * a server and ignores `navigate`. That takes a `window` with an origin, which the router reads
 * once. Called after the page is rendered, so the render stays a server render.
 */
function inBrowser(router: Awaited<ReturnType<typeof open>>['router']): void {
  vi.stubGlobal('window', { origin: 'http://studio.test' });
  router.update({ isServer: false, scrollRestoration: false });
}

describe('useSelectedFamily', () => {
  it('reads the family the address names', async () => {
    const { html, hook } = await open('/fonts?family=heebo');
    expect(html).toBe('<p>heebo</p>');
    expect(hook.selected).toBe('heebo');
  });

  it('says null when the address names none, or names nothing usable', async () => {
    expect((await open('/fonts')).hook.selected).toBeNull();
    expect((await open('/fonts?family=')).hook.selected).toBeNull();
  });

  it('sets the family in the address, replacing the history entry', async () => {
    const { hook, history, router } = await open('/fonts');
    inBrowser(router);
    const entries = history.length;

    hook.setSelected('rubik');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(history.location.pathname).toBe('/fonts');
    expect(history.location.search).toBe('?family=rubik');
    expect(history.length).toBe(entries);
  });

  it('changes the family, and takes it out with null', async () => {
    const { hook, history, router } = await open('/fonts?family=heebo');
    inBrowser(router);

    hook.setSelected('outfit');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(history.location.search).toBe('?family=outfit');

    hook.setSelected(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(history.location.search).toBe('');
  });
});
