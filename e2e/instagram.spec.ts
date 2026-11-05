// CVP-498 (IG13): Clients × Instagram, the whole loop on the built server with the fake runner and the
// Instagram switch on (`STUDIO_INSTAGRAM=1`). The scans are the fake scanner's: with the fake runner
// the engine picks it, and it answers from the sample accounts of
// apps/server/src/instagram/sample-accounts.ts (Falcon FPV's board numbers, a private account, one that
// works once and then times out), so no Apify key is read and nothing is spent. Each run of a scan
// takes 6 s ÷ the fake speed, so "Reading…" and "Scanning…" can be seen. See support/engine.ts.
//
//   no account      the Clients list says "No Instagram yet" with Add Instagram; the client page has the
//                   empty state (S8)
//   add + 1st scan  Add Instagram: the dialog (S1), Save and scan, "Reading @falcon.fpv…" (S2), then the page
//                   fills in: header facts and bio, the four tiles, the charts, the Reels list; the
//                   client's Instagram photo is the avatar on the page and in the list
//   none linked     three delivered videos and no reel linked: "None of our videos is linked" (S9)
//   Link to job     right-click a reel, Link to job (S5): the video is Uploaded on the client page, the
//                   Jobs page (its tab, its row) and in its sheet (S6, "On Instagram"); Mark paid lists it
//   Unlink          right-click the reel, Unlink (S4): Delivered again, offered in Link to job again
//   Clients list    followers, this week and ours vs theirs of the client with an account (L1)
//   Scan now        a second scan: "Scanning…", then the numbers move (the fake adds 12 followers a scan)
//   can't run       a scan that times out keeps the older numbers under "The scan of … failed" and a Retry;
//                   a private account says so with Edit account (S3); no Apify key says "How to"
//
// Falcon FPV's jobs go through the fake runner (Approved) and are delivered by the API; the other clients
// are folders. 1440 x 900.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type Engine, startEngine } from './support/engine.ts';
import { badge, rowOf } from './support/jobs-ui.ts';
import { openApp, sheetOf } from './support/sheet-ui.ts';

const FALCON = 'Falcon FPV';
const JOBS = { granite: 'Granite', rooftop: 'Rooftop Run', orchard: 'Orchard crunch' } as const;
const QUIET = 'Quiet Studio';
const FLAKY = 'Flaky Studio';
const SPADINI = 'Venezia Studio';
const NO_KEY = 'Keyless Studio';

const GRANITE_REEL = 'Granite Fiber, one take through the warehouse';
const ROOFTOP_REEL = 'Chasing the train at 120 km/h';

/** The fake edit's own speed: a job takes 12 s, a scan 2.4 s. */
const FAKE_SPEED = Number(process.env.E2E_FAKE_SPEED ?? 5);
const WAIT = { timeout: 60_000 };

// One story, told in order: the tests after the first lean on what the ones before made on the one
// engine (Falcon FPV's account and its first scan, three delivered videos, the links). So when one
// fails the rest are skipped. Left parallel to each other, Playwright starts a new worker after a
// failure, and the file's beforeAll then boots a second, empty engine for the tests that follow:
// they fail on "No Instagram yet" and a missing Followers tile, which hides the one real failure
// (C100). Test 8 makes its own accounts.
test.describe.configure({ mode: 'serial' });

let engine: Engine;
const ids: Record<string, string> = {};

test.beforeAll(async () => {
  engine = await startEngine({
    settleMs: 2_000,
    fakeSpeed: FAKE_SPEED,
    review: false,
    instagram: true,
  });
  // Falcon's three videos go through the fake runner while the first tests run.
  for (const job of Object.values(JOBS)) await engine.createJob({ client: FALCON, job });
  // The other clients are folders, with no job.
  for (const client of [QUIET, FLAKY, SPADINI, NO_KEY]) {
    await mkdir(join(engine.inbox, client), { recursive: true });
  }
});

test.afterAll(async () => {
  await engine?.stop();
});

interface ClientRow {
  clientId: string;
  client: string;
}

interface JobOnServer {
  id: string;
  name: string;
  state: string;
  delivery: { uploadedAt?: string; reelUrl?: string } | null;
}

interface InstagramOnServer {
  account: { handle: string; fullName: string | null; private: boolean } | null;
  lastScan: { outcome: string; followers: number | null; reelsRead: number } | null;
  scanning: boolean;
  numbers: { reels: unknown } | null;
  reels: { shortcode: string; caption: string | null; job: { name: string } | null }[];
}

const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${engine.baseURL}/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  expect(response.ok, `${init?.method ?? 'GET'} ${path} answered ${response.status}`).toBe(true);
  return (await response.json()) as T;
};

/** The client's id, once the engine lists its folder. */
async function clientId(name: string): Promise<string> {
  await expect
    .poll(async () => (await api<ClientRow[]>('/clients')).some((row) => row.client === name), WAIT)
    .toBe(true);
  const row = (await api<ClientRow[]>('/clients')).find((candidate) => candidate.client === name);
  return (row as ClientRow).clientId;
}

const jobsOnServer = () => api<JobOnServer[]>('/jobs');
const instagramOf = (id: string) => api<InstagramOnServer>(`/clients/${id}/instagram`);

/** Saves a client's account through the API, as the dialog does, and waits for its scan to end. */
async function saveAccount(name: string, handle: string): Promise<string> {
  const id = await clientId(name);
  await api(`/clients/${id}/instagram`, {
    method: 'PUT',
    body: JSON.stringify({ handle, since: null }),
  });
  await expect.poll(async () => (await instagramOf(id)).lastScan !== null, WAIT).toBe(true);
  await expect.poll(async () => (await instagramOf(id)).scanning, WAIT).toBe(false);
  return id;
}

const section = (page: Page) => page.getByRole('region', { name: 'Instagram', exact: true });
const tile = (page: Page, name: string) => section(page).getByRole('region', { name, exact: true });
const reelRow = (page: Page, caption: string): Locator =>
  section(page)
    .getByRole('region', { name: 'Reels', exact: true })
    .getByRole('listitem')
    .filter({ hasText: caption });
const scanNow = (page: Page) => section(page).getByRole('button', { name: /^Scan(ning| now)/ });

/**
 * Right-clicks the reel and opens its menu's Link to job list, which it returns. The list opens
 * once the pointer has rested on its item for a moment: a first move that a busy page misses, or a
 * pointer that already stands there, opens nothing, and a click on the list's items would then wait
 * for a list that never comes. So each attempt moves the pointer on the item again (and
 * right-clicks again if the menu is not there), until the list is.
 */
async function openLinkToJob(page: Page, caption: string): Promise<Locator> {
  const trigger = page
    .getByRole('menu', { name: /^Actions for the reel/ })
    .getByRole('menuitem', { name: 'Link to job' });
  const list = page.getByRole('menu', { name: 'Link to job' });
  let attempt = 0;
  await expect(async () => {
    attempt += 1;
    if (!(await trigger.isVisible())) {
      await reelRow(page, caption).click({
        button: 'right',
        position: { x: 200, y: 20 },
        timeout: 5_000,
      });
    }
    await trigger.hover({ position: { x: 8 + attempt * 9, y: 8 }, timeout: 5_000 });
    await expect(list).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return list;
}

/** Whether a video is linked to a reel, by the engine's own account of it. */
async function linkedOnServer(name: string): Promise<boolean> {
  const job = (await jobsOnServer()).find((candidate) => candidate.name === name);
  return job?.delivery?.uploadedAt !== undefined;
}

/** "12,480": a number as the page writes it. */
const written = (count: number) => count.toLocaleString('en-US');

/**
 * What the tests on Falcon FPV's numbers start from, which the tests before them made (test 2 saved
 * the account and its first scan read it, tests 4 and 5 linked two reels to videos). Waits for the
 * engine to say so, and says what is missing when it never does (a test run alone has none of it).
 * Resolves with the followers the last scan read, which the page shows.
 */
async function falconsFirstScan(): Promise<number> {
  const id = ids[FALCON] ?? (await clientId(FALCON));
  const START = { timeout: 15_000 };
  await expect
    .poll(
      async () => {
        const { account, lastScan, scanning } = await instagramOf(id);
        return account !== null && !scanning && lastScan?.outcome === 'ok';
      },
      {
        ...START,
        message: `${FALCON} has no scanned account: the "Add Instagram" test makes it, so run the whole file`,
      },
    )
    .toBe(true);
  await expect
    .poll(
      async () => (await linkedOnServer(JOBS.granite)) && (await linkedOnServer(JOBS.rooftop)),
      {
        ...START,
        message: `${JOBS.granite} and ${JOBS.rooftop} are linked by the tests before this one`,
      },
    )
    .toBe(true);
  return (await instagramOf(id)).lastScan?.followers as number;
}

/** The calendar day this many days ago, `YYYY-MM-DD`, as the dialog's day field takes it. */
function daysAgo(days: number): string {
  const day = new Date(Date.now() - days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** Opens a page of the app and collects its errors. */
async function open(page: Page, path: string): Promise<string[]> {
  return openApp(page, engine.baseURL, path);
}

test('a client with no account: the Clients list offers Add Instagram, the client page has the empty state', async ({
  page,
}) => {
  const errors = await open(page, '/clients');
  ids[FALCON] = await clientId(FALCON);

  const row = page.getByRole('row').filter({ hasText: FALCON });
  await expect(row).toContainText('No Instagram yet');
  await expect(row.getByRole('button', { name: `Add Instagram for ${FALCON}` })).toBeVisible();

  await row.getByRole('link', { name: FALCON }).click();
  await expect(page).toHaveURL(new RegExp(`/clients/${ids[FALCON]}$`));
  await expect(page.getByText('Add their Instagram to see how our videos do there.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Instagram' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Add Instagram: the dialog, the first scan reads, and the page fills in with the photo as the avatar', async ({
  page,
}) => {
  const errors = await open(page, `/clients/${await clientId(FALCON)}`);

  await test.step('the dialog (S1) takes the account and Save and scan', async () => {
    await page.getByRole('button', { name: 'Add Instagram' }).click();
    const dialog = page.getByRole('dialog', { name: `Instagram · ${FALCON}` });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Instagram account').fill('@falcon.fpv');
    // Working together since: before the sample's oldest reel, so "Since us" covers all 22.
    await dialog.getByLabel('Working together since').fill(daysAgo(95));
    await dialog.getByRole('button', { name: 'Save and scan' }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step('the first scan (S2): "Reading @falcon.fpv…" until it is done', async () => {
    await expect(page.getByText('Reading @falcon.fpv… about a minute')).toBeVisible();
    await expect(tile(page, 'Followers')).toContainText('12,480', WAIT);
    await expect(page.getByText('Reading @falcon.fpv…')).toBeHidden();
  });

  await test.step('the page has the account’s facts and the sample’s numbers', async () => {
    await expect(page.getByText('FPV drone pilot. Bookings in DM.')).toBeVisible();
    await expect(page.getByRole('link', { name: '@falcon.fpv on Instagram' })).toHaveAttribute(
      'href',
      'https://www.instagram.com/falcon.fpv/',
    );
    await expect(page.getByText(/12,480 followers/)).toBeVisible();
    for (const name of ['Plays per reel', 'Likes per reel', 'Shares a week']) {
      await expect(tile(page, name)).toBeVisible();
    }
    await expect(
      section(page).getByRole('region', { name: 'Plays of every reel', exact: true }),
    ).toContainText('22 reels');
    await expect(reelRow(page, GRANITE_REEL)).toContainText('9.8K');
    await expect(reelRow(page, 'Positano from above')).toContainText('41.2K');
    const onServer = await instagramOf(ids[FALCON] as string);
    expect(onServer.account).toMatchObject({ handle: 'falcon.fpv', private: false });
    expect(onServer.lastScan).toMatchObject({ outcome: 'ok', followers: 12_480, reelsRead: 22 });
  });

  await test.step('the Instagram photo is the client’s avatar on the page and in the Clients list', async () => {
    const photo = page.locator('img[data-slot="client-photo"]').first();
    await expect(photo).toHaveAttribute(
      'src',
      new RegExp(`/api/clients/${ids[FALCON]}/photo\\?v=`),
    );
    // The sample's picture is a 96 px PNG: the browser decoded it.
    await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(96);

    await page.goto(`${engine.baseURL}/clients`);
    await expect(
      page.getByRole('row').filter({ hasText: FALCON }).locator('img[data-slot="client-photo"]'),
    ).toHaveAttribute('src', new RegExp(`/api/clients/${ids[FALCON]}/photo`));
  });
  expect(errors).toEqual([]);
});

test('three delivered videos and no reel linked: the page says so and lists them', async ({
  page,
}) => {
  await test.step('the videos finish and are marked delivered', async () => {
    await expect
      .poll(async () => (await jobsOnServer()).filter((job) => job.state === 'ready').length, WAIT)
      .toBe(3);
    for (const job of await jobsOnServer()) {
      await api(`/jobs/${job.id}/deliver`, { method: 'POST' });
      ids[job.name] = job.id;
    }
  });

  const errors = await open(page, `/clients/${ids[FALCON]}`);
  const notice = page.getByText('None of our videos is linked to a reel yet.');
  await expect(notice).toBeVisible();
  const text = (await notice.locator('..').innerText()).replace(/\s+/g, ' ');
  for (const name of Object.values(JOBS)) expect(text).toContain(name);
  expect(errors).toEqual([]);
});

test('Link to job: the reel gets its video, which is Uploaded on the client page, the Jobs page and in its sheet; Mark paid lists it', async ({
  page,
}) => {
  const errors = await open(page, `/clients/${ids[FALCON]}`);

  await test.step('right-click the reel › Link to job lists the delivered videos no reel links', async () => {
    const list = await openLinkToJob(page, ROOFTOP_REEL);
    await expect(list).toContainText(`Delivered to ${FALCON}, not linked yet`);
    for (const name of Object.values(JOBS)) {
      await expect(list.getByRole('menuitem', { name: new RegExp(name) })).toBeVisible();
    }
    await list.getByRole('menuitem', { name: new RegExp(`^${JOBS.rooftop}`) }).click();
  });

  await test.step('the reel shows its video, the message offers Undo, the server agrees', async () => {
    await expect(
      reelRow(page, ROOFTOP_REEL).getByRole('link', { name: JOBS.rooftop }),
    ).toBeVisible();
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Linked/ })).toContainText(
      JOBS.rooftop,
    );
    const job = (await jobsOnServer()).find((candidate) => candidate.name === JOBS.rooftop);
    expect(job?.delivery?.uploadedAt).toBeDefined();
    expect(job?.delivery?.reelUrl).toMatch(/^https:\/\/www\.instagram\.com\/reel\//);
    // "None of our videos is linked" is gone, and Rooftop Run is not offered any more.
    await expect(page.getByText('None of our videos is linked to a reel yet.')).toBeHidden();
  });

  await test.step('the Jobs page has it Uploaded, on its own tab', async () => {
    await page.goto(`${engine.baseURL}/`);
    const row = rowOf(page, JOBS.rooftop);
    await expect(badge(row, 'Uploaded')).toBeVisible(WAIT);
    await expect(badge(rowOf(page, JOBS.granite), 'Delivered')).toBeVisible();
    await expect(badge(rowOf(page, JOBS.orchard), 'Delivered')).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Uploaded/ })).toContainText('1');
    // The row says how the reel is doing (the sample's 27.5K plays), not what the video is owed.
    await expect(row).toContainText(/Posted \w{3} \d{1,2} \w{3} · 27\.5K plays/);
    await expect(row).not.toContainText('not paid');
  });

  await test.step('its sheet has the On Instagram line with the reel’s numbers', async () => {
    await rowOf(page, JOBS.rooftop).click({ position: { x: 6, y: 22 } });
    const sheet = sheetOf(page);
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('On Instagram');
    await expect(sheet).toContainText('27.5K plays');
    await expect(sheet).toContainText('1,640 likes');
    await expect(sheet).toContainText('71 comments');
    await expect(sheet).toContainText('820 shares');
    await expect(sheet.getByRole('link', { name: 'Open reel' })).toHaveAttribute(
      'href',
      /^https:\/\/www\.instagram\.com\/reel\//,
    );
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  await test.step('Mark paid lists the Uploaded video with the Delivered ones', async () => {
    await rowOf(page, JOBS.rooftop)
      .getByRole('button', { name: /^Mark paid/ })
      .click();
    const dialog = page.getByRole('dialog', { name: new RegExp(`^Mark paid · ${FALCON}`) });
    await expect(dialog).toBeVisible();
    for (const name of Object.values(JOBS)) {
      await expect(dialog.getByLabel(`Paid for ${name}`)).toBeVisible();
    }
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });
  expect(errors).toEqual([]);
});

test('Unlink puts the video back to Delivered, and Link to job offers it again', async ({
  page,
}) => {
  const errors = await open(page, `/clients/${ids[FALCON]}`);

  await reelRow(page, ROOFTOP_REEL).click({ button: 'right', position: { x: 200, y: 20 } });
  const menu = page.getByRole('menu', { name: /^Actions for the reel/ });
  await expect(menu.getByRole('menuitem', { name: `Open job · ${JOBS.rooftop}` })).toBeVisible();
  await menu.getByRole('menuitem', { name: `Unlink from ${JOBS.rooftop}` }).click();

  await expect(reelRow(page, ROOFTOP_REEL).getByRole('link', { name: JOBS.rooftop })).toBeHidden();
  await expect
    .poll(
      async () =>
        (await jobsOnServer()).find((job) => job.name === JOBS.rooftop)?.delivery?.uploadedAt,
    )
    .toBeUndefined();

  await page.goto(`${engine.baseURL}/`);
  await expect(badge(rowOf(page, JOBS.rooftop), 'Delivered')).toBeVisible(WAIT);
  await expect(page.getByRole('tab', { name: /^Uploaded/ })).toContainText('0');

  // Linked again for the next tests: Granite and Rooftop Run, as on the board.
  await page.goto(`${engine.baseURL}/clients/${ids[FALCON]}`);
  for (const [reel, job] of [
    [ROOFTOP_REEL, JOBS.rooftop],
    [GRANITE_REEL, JOBS.granite],
  ] as const) {
    const list = await openLinkToJob(page, reel);
    await list.getByRole('menuitem', { name: new RegExp(`^${job}`) }).click();
    await expect(reelRow(page, reel).getByRole('link', { name: job })).toBeVisible();
    // The row turns ours at once, before the engine has the link: the next tests start from the
    // engine's own account of it, so wait for that (a page closed first would drop the request).
    await expect.poll(() => linkedOnServer(job), WAIT).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('the Clients list has the numbers of the account and an Add Instagram for each client without one', async ({
  page,
}) => {
  const followers = await falconsFirstScan();
  const errors = await open(page, '/clients');

  const falcon = page.getByRole('row').filter({ hasText: FALCON });
  await expect(falcon).toContainText('@falcon.fpv');
  await expect(falcon).toContainText(written(followers));
  // One scan so far: there is no earlier week to compare with, but two videos are linked.
  await expect(falcon).toContainText(/\d\.\d×/);

  const quiet = page.getByRole('row').filter({ hasText: QUIET });
  await expect(quiet).toContainText('No Instagram yet');
  await page.getByRole('button', { name: `Add Instagram for ${QUIET}` }).click();
  const dialog = page.getByRole('dialog', { name: `Instagram · ${QUIET}` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});

test('Scan now: "Scanning…", then the numbers move', async ({ page }) => {
  const followers = await falconsFirstScan();
  const errors = await open(page, `/clients/${ids[FALCON]}`);
  await expect(tile(page, 'Followers')).toContainText(written(followers));

  await scanNow(page).click();
  await expect(scanNow(page)).toHaveText('Scanning…');
  await expect(scanNow(page)).toBeDisabled();
  // The fake adds 12 followers to every scan after the first.
  await expect(tile(page, 'Followers')).toContainText(written(followers + 12), WAIT);
  await expect(scanNow(page)).toHaveText('Scan now');
  const onServer = await instagramOf(ids[FALCON] as string);
  expect(onServer.lastScan).toMatchObject({ outcome: 'ok', followers: followers + 12 });
  expect(errors).toEqual([]);
});

test('a scan that can’t run: the older numbers stay under a line that says why (a timeout, a private account, no key)', async ({
  page,
}) => {
  await test.step('a scan that times out keeps the numbers of the one before, and Retry asks again', async () => {
    ids[FLAKY] = await saveAccount(FLAKY, 'flaky.studio');
    const errors = await open(page, `/clients/${ids[FLAKY]}`);
    await expect(tile(page, 'Followers')).toContainText('2,105');
    await scanNow(page).click();
    const line = page.getByText(/^The scan of \w{3} \d{1,2} \w{3} failed$/);
    await expect(line).toBeVisible(WAIT);
    await expect(page.getByText(/Instagram didn’t answer\. The numbers are from/)).toBeVisible();
    // The last numbers are still there under the line.
    await expect(tile(page, 'Followers')).toContainText('2,105');
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(scanNow(page)).toHaveText('Scanning…');
    await expect(line).toBeVisible(WAIT);
    expect(errors).toEqual([]);
  });

  await test.step('a private account says so, with Edit account, in the section and in the Clients list', async () => {
    ids[SPADINI] = await saveAccount(SPADINI, 'venezia.studio');
    await open(page, `/clients/${ids[SPADINI]}`);
    await expect(page.getByText('The account is private')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit account' })).toBeVisible();

    await page.goto(`${engine.baseURL}/clients`);
    const row = page.getByRole('row').filter({ hasText: SPADINI });
    await expect(row).toContainText('Account is private');
    await expect(row.getByRole('button', { name: `Edit account for ${SPADINI}` })).toBeVisible();
  });

  await test.step('no Apify key says so, with How to', async () => {
    ids[NO_KEY] = await saveAccount(NO_KEY, 'no.key');
    await open(page, `/clients/${ids[NO_KEY]}`);
    await expect(page.getByText('Apify isn’t set up')).toBeVisible();
    await expect(page.getByText(/APIFY_TOKEN is missing from \.env/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'How to' })).toBeVisible();
  });
});
