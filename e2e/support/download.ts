// What the e2e specs check about a finished job's download: the Download MP4 link hands out a real
// MP4. Shared by smoke.spec.ts and review.spec.ts.

import { expect, type Locator, type Page } from '@playwright/test';
import { menuItem, openRowMenu } from './jobs-ui.ts';

/** An MP4 starts with a box whose type, bytes 4 to 8, is `ftyp`. */
export function isMp4(bytes: Buffer): boolean {
  return bytes.length > 8 && bytes.subarray(4, 8).toString('latin1') === 'ftyp';
}

/**
 * The Download MP4 link in the row's right-click menu (it left the right column, which holds only
 * the next step) must hand out the finished video; returns its bytes. The menu is closed again.
 */
export async function expectDownloadServesMp4(
  page: Page,
  row: Locator,
  jobName: string,
): Promise<Buffer> {
  const menu = await openRowMenu(page, row);
  const link = menuItem(page, 'Download MP4');
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  expect(href).toMatch(/\/api\/jobs\/[^/]+\/download$/);

  // Resolved against the page, so a spec without a `baseURL` can use it too.
  const response = await page.request.get(new URL(href ?? '', page.url()).toString());
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('video/mp4');
  expect(response.headers()['content-disposition']).toContain(`${jobName}.mp4`);
  const body = await response.body();
  expect(body.length).toBeGreaterThan(0);
  expect(isMp4(body), 'the download starts with an MP4 ftyp box').toBe(true);
  return body;
}
