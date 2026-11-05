// Approve is in a job row's right-click menu only, never inside the job (the owner, 31 Oct: an editor
// approved to see the video sooner, then unapproved). The Mac right-clicks the row; the phone has no
// right-click, so it presses and holds the row, which opens the row's sheet, whose list is that menu.

import { expect, type Locator, type Page } from '@playwright/test';
import { chooseFromRowMenu } from './jobs-ui.ts';
import { reviewDialog } from './review-ui.ts';

/** The phone's Review, its job sheet, and a row of the sheet's list. */
const PHONE_REVIEW = '[data-slot="phone-review"]';
const PHONE_SHEET = '[data-slot="phone-job-sheet"]';

/** The phone Review's footer line with no notes, where the Approve button was: it says where Approve is. */
export const PHONE_APPROVE_LINE = `${PHONE_REVIEW} [data-slot="phone-review-approve"]`;
export const PHONE_APPROVE_TEXT =
  'Happy with it? Press and hold the job in the list and choose Approve to render the final video.';

/** How long the spec holds a finger on a phone row: past the app's 500 ms (`LONG_PRESS_MS`). */
const HOLD_MS = 650;

/** The Mac: closes the review dialog when it is open, then chooses Approve in the row's right-click menu. */
export async function approveFromRowMenu(page: Page, row: Locator): Promise<void> {
  const dialog = reviewDialog(page);
  if (await dialog.isVisible()) {
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  await chooseFromRowMenu(page, row, 'Approve');
}

/**
 * The phone's press and hold on a row: a finger down on the row's own button, still for 650 ms,
 * then up. The row's sheet opens; the click that comes with lifting the finger opens nothing else.
 */
export async function holdPhoneRow(page: Page, row: Locator): Promise<void> {
  const target = row.locator('button[aria-label^="Open "]');
  const box = await target.boundingBox();
  if (box === null) throw new Error('the row is not on screen');
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  const finger = { pointerType: 'touch', isPrimary: true, pointerId: 7, ...at };
  await target.dispatchEvent('pointerdown', finger);
  await page.waitForTimeout(HOLD_MS);
  await target.dispatchEvent('pointerup', finger);
  await target.dispatchEvent('click', at);
}

/**
 * The phone: closes the Review when it is open, presses and holds the row (unless the Review was
 * opened from the job's sheet, which is back now), and taps Approve in the sheet. The sheet stays
 * open on the job, which is rendering now.
 */
export async function approveFromPhoneSheet(page: Page, row: Locator): Promise<void> {
  const review = page.locator(PHONE_REVIEW);
  if (await review.isVisible()) {
    await review.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(review).toBeHidden();
  }
  const sheet = page.locator(PHONE_SHEET);
  if (!(await sheet.isVisible())) await holdPhoneRow(page, row);
  await expect(sheet).toBeVisible();
  await sheet.locator('[data-menu-row="approve"]').click();
}
