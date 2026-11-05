import type { HealthResponse, Job, MusicView } from '@studio/shared';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Sheet } from '@/components/ui/sheet';
import { HEALTH_KEY } from '@/data/health-query';
import { musicKey } from '@/data/music-query';
import {
  createTestQueryClient,
  makeJob,
  makeMusicVersion,
  makeMusicView,
  makeOrphanDelivery,
} from '@/data/test-utils';
import {
  type JobSheetState,
  jobSheetJobs,
  jobSheetList,
  jobSheetNow,
} from '@/features/job-sheet/test-fixtures';
import { rowMenuEntries } from '@/features/jobs/row-menu';
import { renderAt } from '@/lib/test-router';
import { MenuList, PhoneJobSheet, PhoneJobSheetGone, SubmenuView } from './PhoneJobSheet';
import { phoneMenuRows } from './phone-menu';

/** The sheet's content for a job of the boards, inside an open sheet on the jobs page. */
function sheetOf(state: JobSheetState) {
  return inSheet(
    <PhoneJobSheet
      job={jobSheetJobs[state]}
      jobs={jobSheetList}
      onClose={() => {}}
      now={jobSheetNow[state]}
    />,
  );
}

function inSheet(node: ReactNode) {
  return renderAt('/jobs', <Sheet open>{node}</Sheet>);
}

const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The opening tag of the first element whose attributes contain `needle`. */
const tag = (markup: string, needle: string) =>
  markup.match(new RegExp(`<[^>]*${needle}[^>]*>`))?.[0] ?? '';

/** The `data-menu-row` ids, top to bottom. */
const menuRows = (markup: string) =>
  [...markup.matchAll(/data-menu-row="([^"]*)"/g)].map((match) => match[1]);

describe('<PhoneJobSheet>: the parts every board has', () => {
  it('has the grabber, the avatar, the name, the client and a 44 px Close', async () => {
    const markup = await sheetOf('held');
    const job = jobSheetJobs.held;
    expect(markup).toContain('data-slot="sheet-grabber"');
    expect(markup).toMatch(/data-slot="avatar"[^>]*data-size="lg"/);
    expect(markup).toMatch(new RegExp(`<h2[^>]*>${job.name}</h2>`));
    expect(tag(markup, 'data-slot="job-sheet-client"')).toContain(
      `href="/clients/${job.clientId}"`,
    );
    expect(text(markup)).toContain(job.client);
    expect(tag(markup, 'aria-label="Close"')).toMatch(/\bsize-11\b/);
  });

  it('draws the boards’ header: a 24 px name line over a 14 px client line, a 6 px pill', async () => {
    const markup = await sheetOf('approved');
    expect(markup).toMatch(/<h2[^>]*\bleading-6\b/);
    expect(markup).not.toContain('leading-[26px]');
    // The client's line is 14 px (the Mac sheet's is 13).
    expect(markup).toMatch(
      /<div class="[^"]*\btext-sm\b[^"]*"[^>]*><a[^>]*data-slot="job-sheet-client"/,
    );
    expect(tag(markup, 'data-slot="job-sheet-status"')).toContain('rounded-[6px]');
  });

  it('puts 16 px above the button and no gap above Details, as the boards do', async () => {
    const markup = await sheetOf('approved');
    // The button's block sits 4 px under the 12 px of the stack: 16 in all.
    expect(markup).toMatch(/pt-3 empty:hidden[^>]*><div class="mt-1">/);
    // The menu is followed by Details directly: the block has no margin of its own.
    expect(markup).not.toMatch(/mt-3 flex flex-col gap-2 border-t/);
  });

  it('names the sheet with the job’s name at 18 px, in its own direction', async () => {
    const markup = await sheetOf('held');
    const heading = tag(markup, 'text-\\[18px\\]');
    expect(heading).toContain('<h2');
    expect(heading).toContain('id="radix-');
  });

  it('puts a pill and a muted line under the header', async () => {
    const markup = await sheetOf('held');
    const pill = tag(markup, 'data-slot="job-sheet-status"');
    expect(pill).toContain('data-tone="amber"');
    expect(text(markup)).toMatch(/Held\s+3 h ago/);
  });

  it('ends with Details, and has no History (the owner, CVP-277: the Mac keeps it)', async () => {
    for (const state of ['held', 'delivered'] as const) {
      const markup = await sheetOf(state);
      expect(markup.indexOf('>Details<')).toBeGreaterThan(
        markup.indexOf('data-slot="phone-sheet-menu"'),
      );
      expect(markup).not.toContain('>History');
    }
  });

  it('gives a delivered job the boards’ Details: Delivered, Price, Paid, File', async () => {
    const markup = await sheetOf('delivered');
    const labels = [...markup.matchAll(/data-detail="([^"]*)"/g)].map((match) => match[1]);
    expect(labels).toEqual(['Delivered', 'Price', 'Paid', 'File']);
    expect(text(markup)).toContain('Not yet');
    expect(text(markup)).not.toContain('_Exports/');
  });
});

describe('<PhoneJobSheet>: an Uploaded job', () => {
  const delivered = jobSheetJobs.delivered;
  const uploaded: Job = {
    ...delivered,
    delivery: delivered.delivery && {
      ...delivered.delivery,
      uploadedAt: '2026-10-20T09:30:00.000Z',
      reelUrl: 'https://www.instagram.com/reel/C-rooftop/',
    },
  };
  const sheet = () =>
    inSheet(
      <PhoneJobSheet
        job={uploaded}
        jobs={jobSheetList}
        onClose={() => {}}
        now={jobSheetNow.delivered}
      />,
    );

  it('says Uploaded in the pill, with the violet dot', async () => {
    const markup = await sheet();
    const pill = tag(markup, 'data-slot="job-sheet-status"');
    expect(pill).toContain('data-tone="default"');
    expect(text(markup)).toContain('Uploaded');
    expect(markup).toContain('bg-status-uploaded');
  });

  it('keeps Mark paid… as the button and has no Not delivered yet in the list; Open reel is there', async () => {
    const markup = await sheet();
    expect(markup).toContain('data-sheet-action="pay"');
    expect(menuRows(markup)).toEqual(['reel', 'download', 'archive']);
    expect(text(markup)).toContain('Open reel');
    expect(text(markup)).not.toContain('Not delivered yet');
  });

  it('adds the Posted row to Details, after Delivered', async () => {
    const markup = await sheet();
    const labels = [...markup.matchAll(/data-detail="([^"]*)"/g)].map((match) => match[1]);
    expect(labels).toEqual(['Delivered', 'Posted', 'Price', 'Paid', 'File']);
  });
});

describe('<PhoneJobSheet>: Versions (VE4)', () => {
  it('ends with a closed Versions button, a 44 px touch target, after Details', async () => {
    for (const state of ['review', 'delivered'] as const) {
      const markup = await sheetOf(state);
      const versions = tag(markup, 'aria-label="Versions"');
      expect(versions).toContain('data-section="versions"');
      expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Versions/);
      expect(markup).toMatch(/<button[^>]*\bh-11\b[^>]*>Versions/);
      expect(markup.indexOf('data-section="versions"')).toBeGreaterThan(
        markup.indexOf('>Details<'),
      );
      expect(markup).not.toContain('<ol');
    }
  });

  it('is left out for a video whose folder is gone', async () => {
    const job = { ...jobSheetJobs.delivered, folderDeleted: true } as Job;
    const markup = await inSheet(
      <PhoneJobSheet
        job={job}
        jobs={jobSheetList}
        onClose={() => {}}
        now={jobSheetNow.delivered}
      />,
    );
    expect(markup).not.toContain('data-section="versions"');
  });
});

describe('<PhoneJobSheet>: Held (board MJobSheetHeld)', () => {
  it('shows the note in a box, Release as a 48 px full-width button, then Edit note…, Effort and Archive', async () => {
    const markup = await sheetOf('held');
    // The fixture’s held job has no note; give this one the board’s.
    const withNote: Job = { ...jobSheetJobs.held, note: 'לפתוח עם הלוגו של הטורניר' };
    const noted = await inSheet(
      <PhoneJobSheet
        job={withNote}
        jobs={jobSheetList}
        onClose={() => {}}
        now={jobSheetNow.held}
      />,
    );
    expect(text(noted)).toContain('Note for the editor');
    expect(text(noted)).toContain('לפתוח עם הלוגו של הטורניר');
    expect(tag(noted, 'data-slot="note-box"')).toBeTruthy();
    expect(markup).not.toContain('data-slot="note-box"');

    const release = tag(markup, 'data-sheet-action="release"');
    expect(release).toMatch(/\bh-12\b/);
    expect(release).toMatch(/\bw-full\b/);
    expect(text(markup)).toContain('Release');
    expect(menuRows(markup)).toEqual(['note', 'effort', 'archive']);
    expect(text(noted)).toContain('Edit note…');
  });

  it('has 48 px rows with an 18 px icon, the label and, for Effort, its level and a chevron', async () => {
    const markup = await sheetOf('held');
    const effort = markup.match(/<button[^>]*data-menu-row="effort"[^>]*>.*?<\/button>/)?.[0] ?? '';
    expect(effort).toMatch(/\bmin-h-12\b/);
    expect(effort).toMatch(/size-\[18px\]/);
    expect(text(effort)).toBe('Effort Default · Extra high');
    expect(effort).toContain('lucide-chevron-right');
  });

  it('does not show Details’ Effort row: the list has it', async () => {
    expect(text(await sheetOf('held'))).not.toContain('Effort Extra high');
  });
});

describe('<PhoneJobSheet>: Queued (board MJobSheetQueued)', () => {
  it('has the pill with its place in line, who it waits for, no button, and Edit note…, Effort, Hold', async () => {
    const markup = await sheetOf('queued');
    expect(text(markup)).toContain('Queued · #1 in line');
    expect(text(markup)).toContain('Starts after חנוכה 2026');
    expect(markup).not.toContain('data-sheet-action');
    expect(menuRows(markup)).toEqual(['note', 'effort', 'hold']);
    expect(text(markup)).toContain('Use the new logo, not the one from last year');
  });
});

describe('<PhoneJobSheet>: Editing (board MJobSheetEditing)', () => {
  it('has eight segments, the step line, only Cancel… in red, and the level in Details', async () => {
    const markup = await sheetOf('editing');
    const steps = markup.match(/<div[^>]*data-slot="phone-sheet-steps"[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(steps.match(/h-1\.5 flex-1/g)).toHaveLength(8);
    expect(text(steps)).toBe('Cut · graphics 2/5 · step 5 of 8');
    expect(text(markup)).toContain('~4 min left');
    expect(menuRows(markup)).toEqual(['cancel']);
    expect(tag(markup, 'data-menu-row="cancel"')).toContain('text-status-failed-foreground');
    expect(markup).not.toContain('data-sheet-action');
    expect(text(markup)).toMatch(/Effort Default · Extra high/);
  });
});

describe('<PhoneJobSheet>: Failed (board MJobSheetFailed)', () => {
  it('has a red pill, the error text and Copy error, Retry from Render, and Add note…, Effort, Archive', async () => {
    const markup = await sheetOf('failed');
    expect(tag(markup, 'data-slot="job-sheet-status"')).toContain('data-tone="red"');
    expect(text(markup)).toContain('Failed at Render');
    const error = markup.match(/<div[^>]*data-slot="job-sheet-error"[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(text(error)).toContain(text(jobSheetJobs.failed.error ?? 'unreachable'));
    expect(text(error)).toContain('Copy error');
    expect(tag(error, 'data-sheet-copy')).toMatch(/\bh-11\b/);
    expect(text(markup)).toContain('7 of 8 done, stopped at Render');
    expect(text(tag(markup, 'data-sheet-action="retry"') ? markup : '')).toContain(
      'Retry from Render',
    );
    expect(menuRows(markup)).toEqual(['note', 'effort', 'archive']);
    // The failed segment is red.
    expect(markup).toContain('bg-status-failed');
  });
});

describe('<PhoneJobSheet>: the other states', () => {
  it('Approved, on a phone that can share: the video on its way as the button; Mark delivered first in the list', async () => {
    // An iPhone: Web Share with files (Node has none).
    vi.stubGlobal('navigator', { share: vi.fn(), canShare: () => true });
    try {
      const markup = await sheetOf('approved');
      expect(text(markup)).toContain('0:30 · 1080×1920 · 27 MB');
      // The sheet fetches the MP4 as it opens: the button is the bar until it is in hand.
      expect(tag(markup, 'data-slot="share-getting"')).toMatch(/\bh-12\b/);
      expect(text(markup)).toContain('Getting the video · 0 of 27 MB');
      expect(markup).not.toContain('data-sheet-action="deliver"');
      // No Download MP4 anywhere while the phone can share: the button is Share video.
      expect(menuRows(markup)).toEqual([
        'view-preview',
        'deliver',
        'use-look',
        'unapprove',
        'archive',
      ]);
      expect(text(markup)).toContain('Mark delivered');
      expect(markup).not.toContain('download=""');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Approved, where the browser can’t share a file: Download MP4 as the button, out of the list', async () => {
    const markup = await sheetOf('approved');
    const download = tag(markup, 'data-sheet-action="download"');
    expect(download).toMatch(/^<a/);
    expect(download).toContain(`href="/api/jobs/${jobSheetJobs.approved.id}/download"`);
    expect(download).toMatch(/\bh-12\b/);
    expect(markup).not.toContain('data-slot="share-getting"');
    expect(menuRows(markup)).toEqual([
      'view-preview',
      'deliver',
      'use-look',
      'unapprove',
      'archive',
    ]);
  });

  /** An iPhone: Web Share with files (Node has none). */
  async function onPhoneThatShares(state: JobSheetState) {
    vi.stubGlobal('navigator', { share: vi.fn(), canShare: () => true });
    try {
      return await sheetOf(state);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it('Delivered, on a phone that can share: Mark paid… as the button; Share video, Not delivered yet, Archive', async () => {
    const markup = await onPhoneThatShares('delivered');
    expect(tag(markup, 'data-sheet-action="pay"')).toMatch(/\bh-12\b/);
    expect(menuRows(markup)).toEqual(['share', 'undeliver', 'archive']);
    // Nothing is fetched until the tap: the row is Share video, a button, not a link.
    expect(tag(markup, 'data-menu-row="share"')).toMatch(/^<button/);
    expect(text(markup)).toContain('Share video');
    expect(text(markup)).not.toContain('Download MP4');
    expect(markup).not.toContain('download=""');
  });

  it('Paid, on a phone that can share: View preview button; muted pill; Share video, Not paid yet, Archive', async () => {
    const markup = await onPhoneThatShares('paid');
    expect(tag(markup, 'data-sheet-action="view-preview"')).toMatch(/\bh-12\b/);
    expect(tag(markup, 'data-slot="job-sheet-status"')).toContain('data-tone="muted"');
    expect(menuRows(markup)).toEqual(['share', 'unpay', 'archive']);
    expect(markup).not.toContain('download=""');
  });

  it('Delivered or Paid, where the browser can’t share a file: Download MP4 with the reason', async () => {
    for (const state of ['delivered', 'paid'] as const) {
      const markup = await sheetOf(state);
      const download = tag(markup, 'data-menu-row="download"');
      expect(download, state).toContain(`href="/api/jobs/${jobSheetJobs[state].id}/download"`);
      expect(text(markup), state).toContain('This browser can’t share files, so it downloads');
    }
  });

  it('Review: the big button opens the phone Review, so the list has no Review… row; Approve is in the list', async () => {
    const markup = await sheetOf('review');
    expect(markup).toContain('data-sheet-action="review"');
    expect(markup).toMatch(/data-sheet-action="review"[^>]*>(<svg.*?<\/svg>)?Review</);
    // The phone's right-click menu is this list: Approve is here, never inside the Review.
    expect(menuRows(markup)).toEqual(['approve', 'effort', 'archive']);
  });

  it('Review: the big button comes before the note, so it is on screen without scrolling', async () => {
    const markup = await sheetOf('review');
    expect(markup).toContain('data-slot="job-sheet-notes"');
    expect(markup.indexOf('data-sheet-action="review"')).toBeLessThan(
      markup.indexOf('data-slot="job-sheet-notes"'),
    );
  });

  it('Arriving: Start now as the button; Hold in the list', async () => {
    const markup = await sheetOf('arriving');
    expect(text(tag(markup, 'data-sheet-action="start"') ? markup : '')).toContain('Start now');
    expect(menuRows(markup)).toEqual(['note', 'effort', 'hold']);
  });
});

describe('<MenuList>: separators, destructive and disabled rows', () => {
  const rowsFor = (job: Job, busy = false) =>
    phoneMenuRows(
      rowMenuEntries(job, { run: vi.fn(), busy, setEffort: vi.fn(), archive: vi.fn() }),
      job,
    );

  it('is a flat list: no line between rows, and no chevron on Download MP4', async () => {
    // Approved: View preview…, Mark delivered, Download MP4, Use this look…, Unapprove, Archive.
    const markup = await inSheet(
      <MenuList rows={rowsFor(jobSheetJobs.approved)} onOpenSubmenu={() => {}} />,
    );
    expect(markup).not.toContain('<hr');
    expect(markup).not.toContain('lucide-chevron-right');
    expect(markup.match(/data-menu-row=/g)).toHaveLength(6);
  });

  it('draws a row that waits for a request at 50% and does not take the tap', async () => {
    const markup = await inSheet(
      <MenuList rows={rowsFor(jobSheetJobs.queued, true)} onOpenSubmenu={() => {}} />,
    );
    const hold = tag(markup, 'data-menu-row="hold"');
    expect(hold).toContain('aria-disabled="true"');
    expect(hold).toContain('opacity-50');
  });

  it('puts a reason under the label of a disabled row', async () => {
    const [icon] = rowsFor(jobSheetJobs.queued);
    if (icon === undefined || icon.kind !== 'item') throw new Error('no row');
    const markup = await inSheet(
      <MenuList
        rows={[{ ...icon, disabled: true, reason: 'Only an approved episode can be the format' }]}
        onOpenSubmenu={() => {}}
      />,
    );
    expect(text(markup)).toContain('Only an approved episode can be the format');
  });

  it('keeps a client’s name in its own direction inside the row’s words', async () => {
    const markup = await inSheet(
      <MenuList rows={rowsFor(jobSheetJobs.approved)} onOpenSubmenu={() => {}} />,
    );
    expect(markup).toContain(`Use this look for <bdi>${jobSheetJobs.approved.client}</bdi>…`);
  });
});

describe('<SubmenuView>: the Effort sub-view (board MJobSheetEffort)', () => {
  const effortRow = (job: Job) => {
    const row = phoneMenuRows(
      rowMenuEntries(job, { run: vi.fn(), busy: false, setEffort: vi.fn() }),
      job,
    ).find((candidate) => candidate.kind === 'submenu');
    if (row === undefined || row.kind !== 'submenu') throw new Error('no effort row');
    return row;
  };

  it('has “‹ Effort”, the hint line, four 52 px radio rows with their hints, and a check on the level in use', async () => {
    const markup = await inSheet(
      <SubmenuView row={effortRow(jobSheetJobs.queued)} onBack={() => {}} />,
    );
    expect(text(markup)).toContain('Effort');
    expect(markup).toContain('lucide-chevron-left');
    expect(text(markup)).toContain('How hard the editor works on this video. Higher takes longer.');
    expect(markup).toContain('role="radiogroup"');
    const radios = [...markup.matchAll(/<button[^>]*role="radio"[^>]*>.*?<\/button>/g)].map(
      (match) => match[0],
    );
    expect(radios.map((radio) => text(radio))).toEqual([
      'Default Extra high',
      'Medium quickest',
      'High slower',
      'Extra high slowest',
    ]);
    expect(radios.every((radio) => /\bh-\[52px\]/.test(radio))).toBe(true);
    // The queued board job is on High: only that row is checked and shows the check.
    expect(radios.map((radio) => radio.includes('aria-checked="true"'))).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(radios.map((radio) => radio.includes('lucide-check'))).toEqual([
      false,
      false,
      true,
      false,
    ]);
    // A rule under Default only.
    expect(radios.map((radio) => radio.includes('border-t'))).toEqual([false, true, false, false]);
  });

  it('checks Default for a job on Default', async () => {
    const markup = await inSheet(
      <SubmenuView row={effortRow(jobSheetJobs.held)} onBack={() => {}} />,
    );
    const radios = [...markup.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map((match) => match[0]);
    expect(radios.map((radio) => radio.includes('aria-checked="true"'))).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('<PhoneJobSheetGone>', () => {
  it('says the job is gone, where its folder was, and has a Close', async () => {
    const gone = makeOrphanDelivery();
    const markup = await inSheet(
      <PhoneJobSheetGone
        last={makeJob({ client: gone.client, name: gone.name })}
        onClose={() => {}}
      />,
    );
    expect(text(markup)).toContain('This job is gone');
    expect(text(markup)).toContain(`${gone.client}/${gone.name}`);
    expect(markup).toContain('aria-label="Close"');
  });
});

// The Music row of Details (Soundtrack, board SDPhone): a value and a muted line under it, from the
// job's music in the query cache (the job.music event keeps it current), while the switch is on.
describe('<PhoneJobSheet>: the Music row', () => {
  const health: HealthResponse = {
    ok: true,
    version: '0.27.1',
    settleMs: 60_000,
    series: false,
    jobSheet: true,
    analytics: false,
    phone: true,
    graphics: false,
    graphicsInEdits: false,
    music: true,
    luts: false,
    lutsInEdits: false,
    fonts: false,
    fontsInNotes: false,
    quickFixes: false,
  };
  const twoVersions: MusicView = makeMusicView({
    picked: 'v2',
    versions: [
      makeMusicVersion(1),
      makeMusicVersion(2, {
        by: 'you',
        ask: 'darker, heavier drums',
        describe: 'Intense cinematic electronic, 120 BPM, darker drums. Drop at 0:18.',
      }),
    ],
  });

  /** The sheet of a job of the boards, with the music the engine answered (`undefined`: not answered). */
  async function sheetWithMusic(state: JobSheetState, music: MusicView | null | undefined) {
    const job = jobSheetJobs[state];
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(HEALTH_KEY, health);
    if (music !== undefined) queryClient.setQueryData(musicKey(job.id), music);
    return renderAt(
      '/jobs',
      <Sheet open>
        <PhoneJobSheet job={job} jobs={jobSheetList} onClose={() => {}} now={jobSheetNow[state]} />
      </Sheet>,
      queryClient,
    );
  }

  const labels = (markup: string) =>
    [...markup.matchAll(/data-detail="([^"]*)"/g)].map((match) => match[1]);

  it('is in a job that is Ready to review: between Inputs and Added, with its second line', async () => {
    const markup = await sheetWithMusic('review', twoVersions);
    expect(labels(markup)).toEqual(['Inputs', 'Music', 'Added', 'Folder']);
    expect(text(markup)).toContain(
      'Music Made for this video · v2 of 2 Intense cinematic electronic, 120 BPM, darker drums. Drop at 0:18.',
    );
    // The phone's label column is 112 px, as the other rows.
    expect(tag(markup, 'data-detail="Music"')).toContain('grid-cols-[112px_minmax(0,1fr)]');
    expect(tag(markup, 'data-detail-sub="Music"')).toContain('text-muted-foreground');
  });

  it('is in an Approved job: between Inputs and Approved', async () => {
    const markup = await sheetWithMusic('approved', twoVersions);
    expect(labels(markup)).toEqual(['Inputs', 'Music', 'Approved', 'File']);
  });

  it('is not in a Delivered job or a Paid job: the boards’ short money lists stay as they are', async () => {
    for (const state of ['delivered', 'paid'] as const) {
      const markup = await sheetWithMusic(state, twoVersions);
      expect(labels(markup), state).not.toContain('Music');
      expect(labels(markup), state).toEqual(labels(await sheetWithMusic(state, undefined)));
    }
  });

  it('says the music could not be made in the failure colour, with the reason under it', async () => {
    const markup = await sheetWithMusic(
      'review',
      makeMusicView({
        picked: null,
        versions: [],
        picks: [],
        failure: {
          id: 'v1',
          code: 'no_credits',
          message: 'ElevenLabs says this month’s credits are used up.',
          at: '2026-10-22T13:06:00.000Z',
        },
      }),
    );
    expect(text(markup)).toContain(
      'Music None · couldn’t make it ElevenLabs says this month’s credits are used up.',
    );
    const row = markup.match(/data-detail="Music".*?<\/dd>/)?.[0] ?? '';
    expect(row).toContain('text-status-failed-foreground');
  });

  it('is not there for a job without music.json, or before the answer arrives (switch off)', async () => {
    const without = await sheetWithMusic('review', undefined);
    expect(labels(without)).toEqual(['Inputs', 'Added', 'Folder']);
    expect(labels(await sheetWithMusic('review', null))).toEqual(labels(without));
    expect(labels(await sheetWithMusic('approved', null))).toEqual(['Inputs', 'Approved', 'File']);
  });

  it('still has no History, music or not', async () => {
    expect(await sheetWithMusic('review', twoVersions)).not.toContain('>History');
  });
});
