// A stand-in for the Web Share API (Level 2) in the e2e browser: Chrome on the Mac has no iPhone
// share sheet, so the phone specs replace `navigator.share` and `navigator.canShare` before the app
// loads. The stand-in records every file it is given, and whether the page still had the tap's
// permission (`navigator.userActivation.isActive`) when it was called; how it answers is set from
// the test (`answerShares`): sent, or closed without sending (AbortError).

import type { Page } from '@playwright/test';

/** What the stand-in saw of one share. */
export interface SharedFile {
  name: string;
  type: string;
  size: number;
  /** How many files the share carried. */
  files: number;
  /** Whether the share came inside a tap (the page had transient user activation). */
  inTap: boolean;
}

declare global {
  interface Window {
    __shares?: SharedFile[];
    /** The `text` of each share, in the same order as `__shares` ('' when it carried none). */
    __shareTexts?: string[];
    __shareAnswer?: 'sent' | 'cancel';
  }
}

/**
 * Before the page's scripts run: a `navigator.share` that records and answers, and a
 * `navigator.canShare` that says yes to files (`canShare: false` makes it say no, as a desktop
 * browser does, so the app falls back to Download MP4).
 */
export async function stubShare(page: Page, { canShare = true } = {}): Promise<void> {
  await page.addInitScript((allowed: boolean) => {
    window.__shares = [];
    window.__shareTexts = [];
    window.__shareAnswer = 'sent';
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: (data?: ShareData) => allowed && (data?.files?.length ?? 0) > 0,
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: (data?: ShareData) => {
        const files = data?.files ?? [];
        const file = files[0];
        window.__shareTexts?.push(data?.text ?? '');
        window.__shares?.push({
          name: file?.name ?? '',
          type: file?.type ?? '',
          size: file?.size ?? 0,
          files: files.length,
          inTap: navigator.userActivation?.isActive ?? false,
        });
        return window.__shareAnswer === 'cancel'
          ? Promise.reject(new DOMException('Share canceled', 'AbortError'))
          : Promise.resolve();
      },
    });
  }, canShare);
}

/** How the next shares answer: sent, or closed without sending. */
export async function answerShares(page: Page, answer: 'sent' | 'cancel'): Promise<void> {
  await page.evaluate((value) => {
    window.__shareAnswer = value;
  }, answer);
}

/** Every share so far. */
export function sharesOf(page: Page): Promise<SharedFile[]> {
  return page.evaluate(() => window.__shares ?? []);
}

/** The text each share carried (a video with a song shares its line to post), in the order of `sharesOf`. */
export function shareTextsOf(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__shareTexts ?? []);
}
