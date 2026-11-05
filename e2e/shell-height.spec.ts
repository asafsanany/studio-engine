// C43 (CVP-361): the pages that fill the window do not scroll the whole document. LUTs, Fonts and
// Graphics (the list and the studio) are as tall as what is left under the header, and the empty
// toaster beside them in the content area used to add its 16 px gap below, so the document was
// 916 px on a 900 px window. The Clients page, which never had a toaster beside it, is checked too.
//
// One engine with the Fonts switch on (LUTs and Graphics are on by default) and nothing in any
// library: every page here is shorter than the window, so the document must be exactly as tall as
// the window. The colour-grade skill is pointed at an empty folder so the built-in LUTs of the
// machine that runs this cannot make the LUTs page taller than the window.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type Engine, startEngine } from './support/engine.ts';

const WINDOW = { width: 1440, height: 900 };

let engine: Engine;
let skillDir: string;

test.use({ viewport: WINDOW });

test.beforeAll(async () => {
  skillDir = await mkdtemp(join(tmpdir(), 'studio-e2e-skill-'));
  engine = await startEngine({
    settleMs: 2_000,
    fakeSpeed: 1,
    review: false,
    fonts: true,
    env: { STUDIO_COLOR_GRADE_DIR: skillDir },
  });
});

test.afterAll(async () => {
  await engine?.stop();
  if (skillDir !== undefined) await rm(skillDir, { recursive: true, force: true });
});

/** The first thing a fresh browser shows is the What's new dialog: put it away. */
async function dismissWhatsNew(page: Page): Promise<void> {
  const whatsNew = page.getByRole('dialog', { name: /What's new/ });
  await whatsNew.waitFor({ timeout: 5_000 }).then(
    () => whatsNew.getByRole('button', { name: 'Got it' }).click(),
    () => {},
  );
  await expect(whatsNew).toBeHidden();
}

/**
 * The page's own box is there (the content area has its first child with a height) and the
 * document is this much taller than the window; polled, so a page still loading is waited for.
 */
async function overflowOf(page: Page): Promise<number> {
  return page.evaluate(() => {
    const first = document.querySelector('main')?.firstElementChild;
    if (first === null || first === undefined || first.getBoundingClientRect().height === 0) {
      return Number.NaN;
    }
    return document.documentElement.scrollHeight - window.innerHeight;
  });
}

const PAGES = [
  { name: 'LUTs', path: '/luts', heading: 'LUTs' },
  { name: 'Fonts', path: '/fonts', heading: 'Fonts' },
  { name: 'Graphics', path: '/graphics', heading: 'Graphics' },
  { name: 'the Graphics studio', path: '/graphics/new', heading: null },
  { name: 'Clients', path: '/clients', heading: 'Clients' },
] as const;

for (const { name, path, heading } of PAGES) {
  test(`${name}: the document is as tall as the window`, async ({ page }) => {
    await page.goto(`${engine.baseURL}${path}`);
    await dismissWhatsNew(page);
    if (heading !== null) {
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    }
    // 0: no scrolling past the window. (The gap was 16, from the empty toaster after the page.)
    await expect.poll(() => overflowOf(page)).toBe(0);
    // And the page really is scrolled nowhere: nothing to scroll to.
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(WINDOW.height);
  });
}
