import type { HealthResponse } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { graphicKey } from '@/data/graphics-query';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient, makeGraphicDetail } from '@/data/test-utils';
import { textOf } from '@/features/graphics/studio/test-helpers';
import { renderApp } from '@/lib/test-router';

// The Graphics pages in the real app frame, with the switch off (the default: as if they did not
// exist) and on (the sidebar item, both routes and their stubs).

const health: HealthResponse = {
  ok: true,
  version: '0.17.1',
  settleMs: 60_000,
  series: false,
  jobSheet: false,
  analytics: false,
  phone: false,
  graphics: false,
  graphicsInEdits: false,
  music: false,
  luts: false,
  lutsInEdits: false,
  fonts: false,
  fontsInNotes: false,
  quickFixes: false,
};

function clientWith(graphics: boolean | null) {
  const queryClient = createTestQueryClient();
  if (graphics !== null) queryClient.setQueryData(HEALTH_KEY, { ...health, graphics });
  return queryClient;
}

const ID = '3f9a1c2b7d4e';
const PATHS = ['/graphics', '/graphics/new', `/graphics/${ID}`];

describe('the Graphics pages with the switch off', () => {
  it('are Not found, and the sidebar has no Graphics item', async () => {
    for (const path of PATHS) {
      const html = await renderApp(path, clientWith(false));
      expect(html, path).toContain('No such page.');
      expect(html, path).not.toContain('data-slot="graphics-list"');
      expect(html, path).not.toContain('data-slot="graphic-studio"');
      expect(html, path).not.toContain('href="/graphics"');
    }
  });

  it('leave the other pages as they were', async () => {
    const html = await renderApp('/jobs', clientWith(false));
    expect(html).not.toContain('Graphics');
  });

  it('draw nothing until the engine has said whether they exist', async () => {
    const html = await renderApp('/graphics', clientWith(null));
    expect(html).not.toContain('No such page.');
    expect(html).not.toContain('data-slot="graphics-list"');
  });
});

describe('the Graphics pages with the switch on', () => {
  it('show the list at /graphics, with Graphics in the sidebar after Clients and in the trail', async () => {
    const html = await renderApp('/graphics', clientWith(true));
    expect(html).toContain('data-slot="graphics-list"');
    expect(html).toContain('href="/graphics"');
    expect(html.indexOf('href="/clients"')).toBeLessThan(html.indexOf('href="/graphics"'));
    expect(html).not.toContain('No such page.');
  });

  it('show the empty studio at /graphics/new', async () => {
    const html = await renderApp('/graphics/new', clientWith(true));
    expect(html).toContain('data-slot="graphic-studio"');
    expect(html).toContain('data-slot="graphic-preview"');
    expect(html).toContain('New graphic');
  });

  it('show a graphic’s studio at /graphics/<id>, its name in the trail once it is known', async () => {
    const queryClient = clientWith(true);
    queryClient.setQueryData(graphicKey(ID), makeGraphicDetail({ id: ID, name: 'Pill' }));
    const html = await renderApp(`/graphics/${ID}`, queryClient);
    expect(html).toContain(`data-graphic-id="${ID}"`);
    expect(html).toContain('data-slot="graphic-preview"');
    expect(html).toContain('>Pill<');
  });

  it('keep the other pages as they were', async () => {
    const html = await renderApp('/jobs', clientWith(true));
    expect(html).not.toContain('data-slot="graphics-list"');
    expect(html).toContain('href="/graphics"');
  });

  it('draw one toaster for the list and the studio, not one each', async () => {
    const queryClient = clientWith(true);
    queryClient.setQueryData(graphicKey(ID), makeGraphicDetail({ id: ID, name: 'Pill' }));
    for (const path of PATHS) {
      const html = await renderApp(path, queryClient);
      expect(html.split('aria-label="Notifications').length - 1, path).toBe(1);
    }
  });
});

describe('the Used in row of a graphic’s studio', () => {
  // The engine counts only while edits use the library (graphicsInEdits): a page it answers with
  // `usedIn: null` has no row, and one with a count has it.
  async function studio(graphicsInEdits: boolean, usedIn: number | null): Promise<string> {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(HEALTH_KEY, { ...health, graphics: true, graphicsInEdits });
    queryClient.setQueryData(graphicKey(ID), makeGraphicDetail({ id: ID, name: 'Pill', usedIn }));
    return textOf(await renderApp(`/graphics/${ID}`, queryClient));
  }

  it('is not there while edits do not use the library', async () => {
    const text = await studio(false, null);
    expect(text).toContain('Details');
    expect(text).not.toContain('Used in');
  });

  it('says how many videos used the graphic once edits use the library', async () => {
    expect(await studio(true, 3)).toContain('Used in 3 videos');
    expect(await studio(true, 1)).toContain('Used in 1 video');
    expect(await studio(true, 0)).toContain('Used in No videos yet');
  });
});
