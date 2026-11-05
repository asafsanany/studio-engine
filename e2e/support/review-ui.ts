// What the review spec knows about the review dialog: finding it, reading the player's playhead,
// and putting the playhead on an exact second with the player's own keys.

import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The review dialog: the one dialog that holds the preview player. The note dialog (Phase 1) is a
 * dialog too, so it is never found by its role alone.
 */
export function reviewDialog(page: Page): Locator {
  return page.getByRole('dialog').filter({ has: page.locator('[data-slot="preview-player"]') });
}

/** The player element's own playhead, in seconds. */
export function playerTime(dialog: Locator): Promise<number> {
  return dialog
    .locator('hyperframes-player')
    .evaluate((el) => (el as HTMLElement & { currentTime: number }).currentTime);
}

/** "0:04" for 4 s, the way the composer and the dots write a time. */
export function clockOf(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Longer than the player's throttle (about 150 ms) and the app's wait for it to catch up (300 ms). */
const LATE_REPORTS_MS = 500;

/**
 * Puts the playhead on a whole second with the player's own keys (Home, → = 5 s, . = 1 s), so the
 * time is exact. The dialog shows the new time at once and keeps it when the player's late reports
 * of the time before the seek arrive, so it needs no wait for the player. A click on the Notes
 * heading gives the dialog the focus. It is not the video, which would toggle play, and not the
 * note box, where keys type.
 */
export async function seekTo(page: Page, dialog: Locator, seconds: number): Promise<void> {
  await dialog.getByRole('heading', { name: /^Notes/ }).click();

  await page.keyboard.press('Home');
  for (let i = 0; i < Math.floor(seconds / 5); i += 1) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < seconds % 5; i += 1) await page.keyboard.press('.');

  await expect(dialog).toContainText(`New note at ${clockOf(seconds)}`);
  // Give the player's late reports of the time before the seek (they come within about 150 ms) time
  // to arrive: the playhead must still be on the new second after them.
  await page.waitForTimeout(LATE_REPORTS_MS);
  await expect(dialog).toContainText(`New note at ${clockOf(seconds)}`);
}
