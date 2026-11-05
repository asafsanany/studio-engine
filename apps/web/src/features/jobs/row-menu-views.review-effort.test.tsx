// "Effort ▸" as the menu draws it (board "Effort with Auto", "Right-click a job in Review"): with
// Quick fixes on, a job in Review shows sparkles and Auto (Default) first, then the three levels
// with no hints; any other job, and every job with Quick fixes off, keeps today's Effort ▸.

import type { HealthResponse, Job } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { JOBS_KEY } from '@/data/jobs-cache';
import { createTestQueryClient, makeJob } from '@/data/test-utils';
import type { RowActions } from './cells/use-row-actions';
import { reviewEffortMenuEntry } from './row-menu';
import {
  DROPDOWN_MENU_PARTS,
  type MenuParts,
  RowMenuEntries,
  RowMenuSubmenuView,
} from './row-menu-views';

const PREVIEW = { durationSec: 28.4, width: 1080, height: 1920 };

const actions: RowActions = {
  run: () => {},
  setEffort: () => {},
  setReviewEffort: () => {},
  archive: () => {},
  unarchive: () => {},
  archiveAllPaid: () => {},
  busy: false,
  refusal: null,
  dismissRefusal: () => {},
};

const health = (quickFixes: boolean): HealthResponse => ({
  ok: true,
  version: '0.42.7',
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
  quickFixes,
});

const review = (overrides: Partial<Job> = {}) =>
  makeJob({ id: 'r1', state: 'review', preview: PREVIEW, placeInLine: null, ...overrides });

/** A job's whole menu, open, as the sheet's ⋯ draws it, with the health answer already in. */
function menuOf(job: Job, quickFixes: boolean | null): string {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(JOBS_KEY, [job]);
  if (quickFixes !== null) queryClient.setQueryData(HEALTH_KEY, health(quickFixes));
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DropdownMenu.Root open>
        <DropdownMenu.Trigger>⋯</DropdownMenu.Trigger>
        <DropdownMenu.Content>
          <RowMenuEntries job={job} actions={actions} parts={DROPDOWN_MENU_PARTS} />
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </QueryClientProvider>,
  );
}

/** The Effort item of an open menu: its opening tag's end to the next item. */
function effortTrigger(html: string): string {
  const at = html.indexOf('data-slot="dropdown-menu-sub-trigger"');
  if (at === -1) throw new Error('no submenu in the menu');
  return html.slice(at, html.indexOf('</div>', at));
}

describe('the Effort item in a job’s menu', () => {
  it('wears sparkles and no level for a job in Review on Auto, with Quick fixes on', () => {
    const item = effortTrigger(menuOf(review({ reviewEffort: null }), true));
    expect(item).toContain('Effort');
    expect(item).toContain('lucide-sparkles');
    expect(item).not.toContain('lucide-gauge');
    expect(item).not.toContain('Medium');
  });

  it('wears the gauge of the review level, and says it, for a job in Review on a level', () => {
    const item = effortTrigger(menuOf(review({ reviewEffort: 'medium', effort: 'xhigh' }), true));
    expect(item).toContain('lucide-gauge');
    expect(item).toContain('d="M12 14 6.6 12.3"');
    expect(item).toContain('Medium');
  });

  it('keeps the edit’s gauge for a job in Review with Quick fixes off, or not heard yet', () => {
    for (const quickFixes of [false, null]) {
      const item = effortTrigger(
        menuOf(review({ effort: 'high', reviewEffort: null }), quickFixes),
      );
      expect(item, String(quickFixes)).toContain('lucide-gauge');
      expect(item, String(quickFixes)).toContain('d="M12 14V8.3"');
      expect(item, String(quickFixes)).not.toContain('lucide-sparkles');
    }
  });

  it('keeps the edit’s gauge for a job that is not in Review, with Quick fixes on', () => {
    const queued = makeJob({ id: 'q1', state: 'queued', effort: 'medium', reviewEffort: null });
    const item = effortTrigger(menuOf(queued, true));
    expect(item).toContain('d="M12 14 6.6 12.3"');
    expect(item).not.toContain('lucide-sparkles');
  });
});

/** Parts whose submenu is already open, so its list is in the markup. */
const OPEN_SUB_PARTS: MenuParts = {
  ...DROPDOWN_MENU_PARTS,
  Sub: ({ children }) => <DropdownMenu.Sub open>{children}</DropdownMenu.Sub>,
};

function submenuOf(job: Job): string {
  const entry = reviewEffortMenuEntry(job, () => {});
  const node: ReactNode = (
    <DropdownMenu.Root open>
      <DropdownMenu.Trigger>⋯</DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <RowMenuSubmenuView entry={entry} parts={OPEN_SUB_PARTS} />
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
  return renderToStaticMarkup(node);
}

describe('the Effort list of a job in Review', () => {
  it('is Auto with Default on the right, a line, then Medium, High and Extra high with no hint', () => {
    const html = submenuOf(review());
    const checked = [...html.matchAll(/aria-checked="(true|false)"/g)].map((match) => match[1]);
    expect(checked).toEqual(['true', 'false', 'false', 'false']);
    expect(html).toContain('>Auto<');
    expect(html).toContain('>Default<');
    for (const level of ['Medium', 'High', 'Extra high']) expect(html).toContain(`>${level}<`);
    expect(html).not.toContain('waits for Send');
    expect(html).not.toContain('quickest');
    // One line, under Auto.
    expect(html.match(/data-slot="dropdown-menu-separator"/g)).toHaveLength(1);
  });

  it('checks the job’s level', () => {
    const html = submenuOf(review({ reviewEffort: 'high' }));
    const checkedAt = html.indexOf('aria-checked="true"');
    expect(html.slice(checkedAt, html.indexOf('</div>', checkedAt))).toContain('>High<');
  });
});
