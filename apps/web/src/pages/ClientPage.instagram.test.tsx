// Clients × Instagram (IG9): the client page's header gets the Instagram handle, the followers and
// the bio, and an Instagram section sits above the jobs. With the switch off, before the answer, or
// for a client with no account, the page is exactly as it was.

import { type ClientInstagram, noClientInstagram } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ClientPhotosProvider } from '@/components/ClientPhotosProvider';
import { CLIENTS_KEY } from '@/data/clients-query';
import { HEALTH_KEY } from '@/data/health-query';
import { clientInstagramKey } from '@/data/instagram-cache';
import { JOBS_KEY } from '@/data/jobs-cache';
import { createTestQueryClient } from '@/data/test-utils';
import { falconInstagram } from '@/features/clients/instagram/test-instagram';
import { CLIENT_BOARD_JOBS, clientRowsOf } from '@/features/clients/test-clients';
import { CLIENT_IDS } from '@/features/jobs/test-jobs';
import {
  FAQ_SERIES_ID,
  HEALTH,
  SERIES_CLIENT,
  SERIES_JOBS,
  seriesWorld,
} from '@/features/series/test-series';
import { renderApp, renderAt } from '@/lib/test-router';
import { jobsUiStore } from '@/stores/jobs-ui';
import { ClientPage } from './ClientPage';

beforeAll(() => {
  // zustand's server render reads the store's initial state; point it at the current one.
  jobsUiStore.getInitialState = () => jobsUiStore.getState();
});
afterEach(() => {
  jobsUiStore.getState().setShowArchived(false);
});

const ARC = CLIENT_IDS['Arc Fitness'];
const PATH = `/clients/${ARC}`;

interface WorldOptions {
  /** The Clients × Instagram switch; `undefined` leaves the health answer out altogether. */
  on?: boolean;
  /** What the engine answered for the client; `undefined` leaves it unanswered. */
  data?: ClientInstagram;
}

/** The app's query client, as the server would have filled it. */
function world({ on, data }: WorldOptions = {}): QueryClient {
  const client = createTestQueryClient();
  client.setQueryData(JOBS_KEY, CLIENT_BOARD_JOBS);
  client.setQueryData(CLIENTS_KEY, clientRowsOf(CLIENT_BOARD_JOBS));
  if (on !== undefined)
    client.setQueryData(HEALTH_KEY, { ...HEALTH, series: false, instagram: on });
  if (data !== undefined) client.setQueryData(clientInstagramKey(ARC, 'since'), data);
  return client;
}

/** The page's own part: what is inside <main>. */
const main = (markup: string) => markup.slice(markup.indexOf('<main'));

const page = async (options?: WorldOptions) => main(await renderApp(PATH, world(options)));

/** The page as it is today: no health answer and no Instagram data. */
const asToday = () => page();

describe("a client's page: the header with an Instagram account", () => {
  it('shows the handle as a link to Instagram, the followers, the jobs and the last job', async () => {
    const markup = await page({ on: true, data: falconInstagram() });
    expect(markup).toMatch(
      /<a href="https:\/\/www\.instagram\.com\/falcon\.fpv\/" target="_blank" rel="noreferrer" aria-label="@falcon\.fpv on Instagram"[^>]*>@falcon\.fpv<svg/,
    );
    expect(markup).toContain('· 12,480 followers · 3 jobs · last job <time');
  });

  it('puts the bio under the line, in its own direction', async () => {
    const markup = await page({ on: true, data: falconInstagram() });
    const line = markup.indexOf('12,480 followers');
    const bio = markup.indexOf('FPV drone pilot. Bookings in DM.');
    expect(line).toBeGreaterThan(-1);
    expect(bio).toBeGreaterThan(line);
    expect(markup).toMatch(
      /<p dir="auto"[^>]*title="FPV drone pilot[^"]*"[^>]*>FPV drone pilot\. Bookings in DM\.<\/p>/,
    );
  });

  it('lets a Hebrew bio read right to left: dir="auto", placed at the start of its own direction', async () => {
    const hebrew = 'ההוא עם הבלורית שמטיס זבובים.\n🚁🎥FPV | נדל״ן | אירועים | חתונות';
    const data = falconInstagram();
    data.account = {
      ...(data.account as NonNullable<ClientInstagram['account']>),
      bio: hebrew,
    };
    const markup = await page({ on: true, data });
    const bio = markup.match(/<p dir="([^"]*)" class="([^"]*)" title="ההוא עם[^"]*">ההוא עם/);
    expect(bio?.[1]).toBe('auto');
    // `.bidi` is flush left for names; the bio's `text-start` follows its own direction.
    expect(bio?.[2]).toContain('text-start');
    // One line, cut at its end (the whole bio is the title), so a long one never pushes Style and
    // the ⋯ under the name: the name's side takes only the room the buttons leave.
    expect(bio?.[2]).toContain('truncate');
    expect(markup).toContain('class="flex min-w-0 flex-1 items-center gap-3"');
    expect(markup).toContain('class="flex shrink-0 items-center gap-2"');
  });

  it('keeps the avatar, the name and the Style button', async () => {
    const markup = await page({ on: true, data: falconInstagram() });
    expect(markup).toMatch(/<h1[^>]*>Arc Fitness<\/h1>/);
    expect(markup).toContain('data-size="lg"');
    expect(markup).toContain(`href="/clients/${ARC}/style"`);
  });

  it('leaves the followers and the bio out before a scan has read the profile', async () => {
    const data = {
      ...falconInstagram(),
      numbers: null,
      lastScan: null,
      account: {
        ...(falconInstagram().account as NonNullable<ClientInstagram['account']>),
        bio: null,
      },
    };
    const markup = await page({ on: true, data });
    expect(markup).toContain('>@falcon.fpv<svg');
    expect(markup).toContain('</a> · 3 jobs · last job');
    expect(markup).not.toContain('followers');
  });
});

/** The header's avatar, drawn with the Instagram pictures (the app's `ClientPhotosProvider` is in main.tsx). */
async function headerAvatar({ on, photo }: { on: boolean; photo: boolean }): Promise<string> {
  const client = createTestQueryClient();
  client.setQueryData(JOBS_KEY, CLIENT_BOARD_JOBS);
  client.setQueryData(
    CLIENTS_KEY,
    clientRowsOf(CLIENT_BOARD_JOBS).map((row) =>
      row.clientId === ARC && photo
        ? {
            ...row,
            instagram: {
              handle: 'arc.fitness',
              followers: 8_200,
              weekChange: 40,
              oursVsTheirs: 2,
              photoAt: '2026-10-30T10:05:00.000Z',
            },
          }
        : row,
    ),
  );
  client.setQueryData(HEALTH_KEY, { ...HEALTH, series: false, instagram: on });
  const markup = await renderAt(
    PATH,
    <ClientPhotosProvider>
      <ClientPage clientId={ARC} />
    </ClientPhotosProvider>,
    client,
  );
  return (
    markup.match(/<span[^>]*data-slot="avatar"[\s\S]*?<\/span>(?=<div class="flex min-w-0)/)?.[0] ??
    ''
  );
}

describe("a client's page: the header's photo (C92)", () => {
  it('draws the Instagram photo in a 56 px circle, the initials under it the same size', async () => {
    const avatar = await headerAvatar({ on: true, photo: true });
    expect(avatar).toContain('data-slot="client-photo"');
    expect(avatar).toContain('data-[size=lg]:size-14');
    expect(avatar).not.toContain('data-[size=lg]:size-10');
    // The initials are what shows until the picture has loaded, at 16 px in the bigger circle.
    expect(avatar).toMatch(/data-slot="avatar-fallback"[^>]*>AF<\/span>/);
    expect(avatar).toContain('*:text-base!');
  });

  it('keeps the 40 px initials circle for a client with no photo', async () => {
    const avatar = await headerAvatar({ on: true, photo: false });
    expect(avatar).not.toContain('data-slot="client-photo"');
    expect(avatar).toContain('data-[size=lg]:size-10');
    expect(avatar).not.toContain('size-14');
  });

  it('keeps the 40 px initials circle while the switch is off, even for a client with a photo', async () => {
    const avatar = await headerAvatar({ on: false, photo: true });
    expect(avatar).not.toContain('data-slot="client-photo"');
    expect(avatar).toContain('data-[size=lg]:size-10');
    expect(avatar).not.toContain('size-14');
  });
});

describe("a client's page: the Instagram section", () => {
  it('sits between the header and the jobs, under a "Jobs" heading', async () => {
    const markup = await page({ on: true, data: falconInstagram() });
    const header = markup.indexOf('<h1');
    const section = markup.indexOf('id="client-instagram"');
    const jobs = markup.indexOf('id="client-jobs"');
    const list = markup.indexOf('<ul aria-label="Jobs"');
    expect(header).toBeLessThan(section);
    expect(section).toBeLessThan(jobs);
    expect(jobs).toBeLessThan(list);
    expect(markup).toMatch(/<h2[^>]*id="client-jobs"[^>]*>Jobs<\/h2>/);
  });

  it('has the head, the four tiles and the two charts', async () => {
    const markup = await page({ on: true, data: falconInstagram() });
    expect(markup).toMatch(/<h2 id="client-instagram"[^>]*>Instagram<\/h2>/);
    for (const title of [
      'Followers',
      'Plays per reel',
      'Likes per reel',
      'Shares a week',
      'Plays of every reel',
      'Views, likes, comments and shares',
    ]) {
      expect(markup).toContain(`<section aria-label="${title}"`);
    }
    expect(markup).toContain('Scan now');
  });

  it('keeps every job of the client in the list below', async () => {
    const ids = [
      ...(await page({ on: true, data: falconInstagram() })).matchAll(/data-job-id="([^"]+)"/g),
    ].map((m) => m[1]);
    expect(ids).toHaveLength(3);
  });

  it('gives the page 28 px between its parts, as with series', async () => {
    const markup = await page({ on: true, data: falconInstagram() });
    expect(markup).toMatch(
      /<div class="flex flex-col gap-7"><div class="flex items-center justify-between/,
    );
  });
});

describe("a client's page: without Instagram, or with the switch off", () => {
  it('is as it was while the switch is off, even with data in the cache', async () => {
    expect(await page({ on: false, data: falconInstagram() })).toBe(await asToday());
  });

  it('is as it was before the engine has said whether Instagram is on', async () => {
    expect(await page({ data: falconInstagram() })).toBe(await asToday());
  });

  it('is as it was until the Instagram answer has arrived', async () => {
    expect(await page({ on: true })).toBe(await asToday());
  });
});

describe("a client's page: a client with no Instagram account (S8)", () => {
  it('shows Add their Instagram under the header, over a Jobs heading', async () => {
    const markup = await page({ on: true, data: noClientInstagram() });
    expect(markup).toContain('data-slot="instagram-no-account"');
    expect(markup).toContain('Add their Instagram to see how our videos do there.');
    expect(markup).toContain('It’s read once a week, about $0.05.');
    expect(markup).toMatch(/<button[^>]*>[\s\S]*?Add Instagram<\/button>/);
    expect(markup.indexOf('<h1')).toBeLessThan(markup.indexOf('data-slot="instagram-no-account"'));
    expect(markup.indexOf('data-slot="instagram-no-account"')).toBeLessThan(
      markup.indexOf('id="client-jobs"'),
    );
    expect(markup).not.toContain('Scan now');
    expect(markup).not.toContain('instagram.com');
  });

  it('has no Instagram on the page while the switch is off', async () => {
    const markup = await page({ on: false, data: noClientInstagram() });
    expect(markup).toBe(await asToday());
    expect(markup).not.toContain('Add their Instagram');
  });
});

describe("a client's page: Instagram and series together", () => {
  it('shows the Instagram section, then the Series list, then the jobs', async () => {
    const client = seriesWorld();
    client.setQueryData(HEALTH_KEY, { ...HEALTH, series: true, instagram: true });
    client.setQueryData(clientInstagramKey(SERIES_CLIENT.clientId, 'since'), falconInstagram());
    const markup = main(await renderApp(`/clients/${SERIES_CLIENT.clientId}`, client));
    const section = markup.indexOf('id="client-instagram"');
    const series = markup.indexOf('id="client-series"');
    const jobs = markup.indexOf('id="client-jobs"');
    expect(section).toBeGreaterThan(-1);
    expect(section).toBeLessThan(series);
    expect(series).toBeLessThan(jobs);
    expect(markup).toContain('· 12,480 followers · 5 jobs · 2 series · last job');
    expect(markup).toContain(FAQ_SERIES_ID);
    expect(SERIES_JOBS.length).toBeGreaterThan(0);
  });
});
