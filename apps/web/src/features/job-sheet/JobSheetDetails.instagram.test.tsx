import type { Job, JobReel } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJobDelivery } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import { JobSheetDetails } from './JobSheetDetails';
import type { SheetInstagram } from './sheet-instagram';
import { jobSheetJobs, jobSheetNow } from './test-fixtures';

// The On Instagram row of the job sheet, Mac and phone (board CLStates S6).

const REEL: JobReel = {
  shortcode: 'DAbc123',
  url: 'https://www.instagram.com/reel/DAbc123/',
  postedAt: '2026-10-20T09:30:00.000Z',
  plays: 27_500,
  likes: 1_640,
  comments: 71,
  shares: 820,
};

const uploaded: Job = {
  ...jobSheetJobs.delivered,
  delivery: makeJobDelivery({ uploadedAt: '2026-10-20T09:30:00.000Z' }),
};
const delivered: Job = jobSheetJobs.delivered;

const render = (
  job: Job,
  instagram: SheetInstagram | null | undefined,
  variant: 'mac' | 'phone' = 'mac',
) =>
  renderAt(
    '/jobs',
    <JobSheetDetails
      job={job}
      now={jobSheetNow.delivered}
      timeZone="UTC"
      variant={variant}
      instagram={instagram}
    />,
  );

/** The text of the markup, tags dropped without a space, so a link inside a sentence reads on. */
const text = (markup: string) =>
  markup
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The `<div>` of one row of the list, by its label. */
const rowOf = (markup: string, label: string) =>
  markup.match(
    new RegExp(`<div[^>]*data-detail="${label}"[\\s\\S]*?</dd>(?:<dd[\\s\\S]*?</dd>)?`),
  )?.[0] ?? '';

for (const variant of ['mac', 'phone'] as const) {
  describe(`<JobSheetDetails> On Instagram (${variant} sheet)`, () => {
    it('says how the linked reel is doing, then when it was posted and Open reel', async () => {
      const markup = await render(uploaded, { kind: 'reel', reel: REEL }, variant);
      const row = rowOf(markup, 'On Instagram');
      expect(text(row)).toContain('27.5K plays · 1,640 likes · 71 comments · 820 shares');
      expect(text(row)).toContain('Posted Tue 20 Oct · linked by you · Open reel');
    });

    it('opens the reel in a new tab, safely', async () => {
      const markup = await render(uploaded, { kind: 'reel', reel: REEL }, variant);
      const link = markup.match(/<a [^>]*data-slot="sheet-open-reel"[^>]*>/)?.[0] ?? '';
      expect(link).toContain('href="https://www.instagram.com/reel/DAbc123/"');
      expect(link).toContain('target="_blank"');
      expect(link).toContain('rel="noopener noreferrer"');
      expect(link).toContain('cursor-pointer');
    });

    it('has no Open reel link when the reel’s place is not known', async () => {
      const markup = await render(uploaded, { kind: 'reel', reel: null }, variant);
      expect(markup).not.toContain('sheet-open-reel');
      expect(text(rowOf(markup, 'On Instagram'))).toContain('Posted Tue 20 Oct · linked by you');
    });

    it('says where to link a reel for a delivered job with none, and links the client’s page', async () => {
      const markup = await render(delivered, { kind: 'none' }, variant);
      const row = rowOf(markup, 'On Instagram');
      expect(text(row)).toContain(`No reel linked yet. Link it from ${delivered.client}’s page.`);
      const link = markup.match(/<a [^>]*data-slot="sheet-client-page"[^>]*>/)?.[0] ?? '';
      expect(link).toContain(`href="/clients/${delivered.clientId}"`);
      expect(markup).not.toContain('sheet-open-reel');
    });

    it('mutes the sentence about no reel, and not the numbers', async () => {
      const none = await render(delivered, { kind: 'none' }, variant);
      expect(rowOf(none, 'On Instagram')).toMatch(/<dd[^>]*class="[^"]*text-muted-foreground/);
      const reel = await render(uploaded, { kind: 'reel', reel: REEL }, variant);
      expect(rowOf(reel, 'On Instagram')).toMatch(/<dd[^>]*class="(?![^"]*text-muted-foreground)/);
    });

    it('is the sheet as it was while the switch is off', async () => {
      for (const instagram of [null, undefined]) {
        const markup = await render(uploaded, instagram, variant);
        expect(markup).not.toContain('On Instagram');
        expect(markup).not.toContain('sheet-open-reel');
        expect(text(markup)).toContain('Posted');
      }
      expect(text(await render(delivered, null, variant))).not.toContain('No reel linked yet');
    });
  });
}
