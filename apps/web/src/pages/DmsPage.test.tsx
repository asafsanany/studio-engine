import type { DmItem, DmsResponse, HealthResponse } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { DMS_KEY } from '@/data/dms-query';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient } from '@/data/test-utils';
import { DMS_TEXT, dmDetail, dmTitle, shortLink } from '@/features/dms/dm-text';
import { renderApp, renderAt } from '@/lib/test-router';
import { DmsPage } from './DmsPage';

const CONNECTED: DmsResponse['connection'] = {
  state: 'connected',
  account: 'studio_account',
  from: ['owner_account'],
  checkedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  error: null,
  everySecs: 60,
};

function item(over: Partial<DmItem>): DmItem {
  return {
    id: 'm1:0',
    messageId: 'm1',
    at: new Date(Date.now() - 5 * 60_000).toISOString(),
    from: 'owner_account',
    kind: 'reel',
    title: 'Gym hook',
    text: null,
    link: null,
    file: null,
    missing: null,
    ...over,
  };
}

function render(answer: DmsResponse): Promise<string> {
  const client = createTestQueryClient();
  client.setQueryData(DMS_KEY, answer);
  return renderAt('/dms', <DmsPage />, client);
}

describe('<DmsPage>', () => {
  it('shows the steps to the key while .env has none, and no Check now', async () => {
    const markup = await render({
      connection: { ...CONNECTED, state: 'off', account: null, checkedAt: null },
      items: [],
    });
    expect(markup).toContain(DMS_TEXT.connectTitle);
    expect(markup).toContain('INSTAGRAM_DM_TOKEN');
    expect(markup).toContain('Allow access to messages');
    expect(markup).toContain('developers.facebook.com/apps');
    expect(markup).toContain('Get started instead of Create app');
    expect(markup).not.toContain(DMS_TEXT.checkNow);
  });

  it('says how to send the first one while nothing has come in', async () => {
    const markup = await render({ connection: CONNECTED, items: [] });
    expect(markup).toContain(DMS_TEXT.empty('@owner_account', '@studio_account'));
    expect(markup).toContain('Checked 2 min ago');
    expect(markup).toContain(DMS_TEXT.checkNow);
  });

  it('lists the items with their kind, their size and the download', async () => {
    const markup = await render({
      connection: CONNECTED,
      items: [
        item({
          file: {
            name: '2026-10-30-reel-0123456789.mp4',
            contentType: 'video/mp4',
            bytes: 4_200_000,
          },
        }),
        item({
          id: 'm2:0',
          kind: 'audio',
          title: null,
          link: 'https://www.instagram.com/reels/audio/1043357377036343/',
        }),
      ],
    });
    expect(markup).toContain('Gym hook');
    expect(markup).toContain('From @owner_account · 4 MB');
    expect(markup).toContain('href="/api/dms/file/2026-10-30-reel-0123456789.mp4"');
    expect(markup).toContain('instagram.com/reels/audio/1043357377036343/');
    expect(markup).toContain('aria-label="Open on Instagram"');
    // The page's clock ticks every 30 s, so the minutes may be one short.
    expect(markup).toMatch(/<time[^>]*>[45] min ago<\/time>/);
  });

  it('says what went wrong when the last check failed', async () => {
    const markup = await render({
      connection: { ...CONNECTED, state: 'failing', error: 'Instagram refused the key: expired' },
      items: [],
    });
    expect(markup).toContain('Instagram refused the key: expired');
  });
});

describe('/dms', () => {
  const HEALTH: HealthResponse = {
    ok: true,
    version: '0.64.0',
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

  it('is the DMs page when the engine has it, and Not found from an engine without it', async () => {
    const withDms = createTestQueryClient();
    withDms.setQueryData(HEALTH_KEY, { ...HEALTH, dms: true });
    withDms.setQueryData(DMS_KEY, { connection: CONNECTED, items: [] });
    expect(await renderApp('/dms', withDms)).toContain(DMS_TEXT.title);

    const without = createTestQueryClient();
    without.setQueryData(HEALTH_KEY, HEALTH);
    expect(await renderApp('/dms', without)).not.toContain(DMS_TEXT.title);
  });
});

describe('dm-text', () => {
  it('names an item by its caption, its words, its link, or its kind', () => {
    expect(dmTitle(item({ title: 'Hook\nsecond line' }))).toBe('Hook');
    expect(dmTitle(item({ title: null, text: '\n for Falcon' }))).toBe('for Falcon');
    expect(dmTitle(item({ title: null, link: 'https://www.instagram.com/p/abc/?igsh=1' }))).toBe(
      'instagram.com/p/abc/',
    );
    expect(dmTitle(item({ title: null, kind: 'photo' }))).toBe('Photo');
    expect(
      dmTitle(item({ title: null, text: 'this sound https://www.instagram.com/reels/audio/1/' })),
    ).toBe('this sound');
    expect(
      dmTitle(
        item({
          title: null,
          kind: 'audio',
          file: { name: 'a.m4a', contentType: 'audio/mp4', bytes: 1 },
        }),
      ),
    ).toBe('Voice note');
    expect(dmTitle(item({ kind: 'unsupported', title: null }))).toBe(
      'Instagram did not pass this message on',
    );
  });

  it('says who sent it, and the size or that it was not downloaded', () => {
    expect(dmDetail(item({}))).toBe('From @owner_account');
    expect(dmDetail(item({ from: 'studio_account', missing: 'gone' }))).toBe(
      'From @studio_account · Not downloaded',
    );
    expect(dmDetail(item({ file: { name: 'a', contentType: 'video/mp4', bytes: 1 } }))).toBe(
      'From @owner_account · < 1 MB',
    );
    expect(shortLink('not a link')).toBe('not a link');
  });
});
