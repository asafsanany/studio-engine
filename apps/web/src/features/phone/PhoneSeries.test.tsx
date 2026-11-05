// PH21, boards MJobsSeries and MReviewSeries: what the phone says about a series, with series on.
// The row's mark and "follows episode N" and the job sheet's "Episode 6 of …" come from the Mac's
// series pieces; the notes' short Series and Style toggles are the Mac's card in its phone variant.

import type { Job } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { Sheet } from '@/components/ui/sheet';
import { clientSeriesKey } from '@/data';
import { HEALTH_KEY } from '@/data/health-query';
import {
  createTestQueryClient,
  makeEpisodeJob,
  makeFormatJob,
  makeJob,
  makeReviewNote,
  makeSeriesSummary,
} from '@/data/test-utils';
import { jobSheetList } from '@/features/job-sheet/test-fixtures';
import { NoteCard } from '@/features/review/NoteCard';
import { renderReview, tagWith } from '@/features/review/test-helpers';
import { renderAt } from '@/lib/test-router';
import { PhoneJobRow } from './PhoneJobRow';
import { PhoneJobSheet } from './PhoneJobSheet';

const SERIES = makeSeriesSummary();
const CLIENT_ID = makeEpisodeJob().clientId;

/** The client, with series switched on or off and the client's series cached (or not yet). */
function clientOf({ on = true, loaded = true } = {}): QueryClient {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, {
    ok: true,
    version: '0.0.0',
    settleMs: 60_000,
    series: on,
  });
  if (loaded) queryClient.setQueryData(clientSeriesKey(CLIENT_ID), [SERIES]);
  return queryClient;
}

/** The row of `job` on the phone's Jobs list. */
function rowOf(job: Job, options?: Parameters<typeof clientOf>[0]): Promise<string> {
  return renderAt(
    '/jobs',
    <ul>
      <PhoneJobRow job={job} onOpen={() => {}} />
    </ul>,
    clientOf(options),
  );
}

/** The content of `job`'s sheet on the phone. */
function sheetOf(job: Job, options?: Parameters<typeof clientOf>[0]): Promise<string> {
  const node: ReactNode = (
    <Sheet open>
      <PhoneJobSheet job={job} jobs={jobSheetList} onClose={() => {}} />
    </Sheet>
  );
  return renderAt('/jobs', node, clientOf(options));
}

/** The visible text of some markup. */
const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('a row on the phone with series on (board MJobsSeries)', () => {
  it('marks an episode with Layers2 after its name, labelled like the Mac’s tooltip', async () => {
    const episode = makeEpisodeJob();
    const row = await rowOf(episode);
    const mark = tagWith(row, 'aria-label="Episode 6 of מיתוס או אמת"');
    expect(mark).toContain('role="img"');
    expect(row.indexOf(episode.name)).toBeLessThan(row.indexOf('Episode 6 of מיתוס או אמת'));
    expect(row).toContain('lucide-layers-2');
    // 14 px, as the note's and the effort's marks beside it.
    expect(row).toMatch(/<svg[^>]*width="14"[^>]*height="14"[^>]*lucide-layers-2/);
  });

  it('marks the format job as the format of the series', async () => {
    expect(await rowOf(makeFormatJob())).toContain(
      'aria-label="The format of the series מיתוס או אמת"',
    );
  });

  it('draws the mark between the note’s and the effort’s marks and the archive box, after the name', async () => {
    const row = await rowOf(
      makeEpisodeJob({
        note: 'Open on the logo',
        effort: 'high',
        archivedAt: '2026-10-21T00:00:00.000Z',
      }),
    );
    const at = (label: string) => row.indexOf(`aria-label="${label}"`);
    expect(at('Your note')).toBeGreaterThan(-1);
    expect(at('Episode 6 of מיתוס או אמת')).toBeGreaterThan(at('Effort: High'));
    expect(at('Archived')).toBeGreaterThan(at('Episode 6 of מיתוס או אמת'));
  });

  it('marks no job that is in no series, and none while series are off or not yet loaded', async () => {
    expect(await rowOf(makeJob({ id: 'plain' }))).not.toContain('lucide-layers-2');
    expect(await rowOf(makeEpisodeJob(), { on: false })).not.toContain('lucide-layers-2');
    expect(await rowOf(makeEpisodeJob(), { loaded: false })).not.toContain('lucide-layers-2');
  });

  it('says which episode an editing episode follows, in its second line', async () => {
    const row = await rowOf(makeEpisodeJob({ state: 'editing', step: 5 }));
    expect(text(row)).toMatch(/Cut · follows episode 5 · /);
    const detail = tagWith(row, 'data-slot="job-detail"');
    expect(detail).toBeTruthy();
  });

  it('says nothing about the series on a row that is not editing, or while series are off', async () => {
    expect(text(await rowOf(makeEpisodeJob({ state: 'queued', placeInLine: 1 })))).not.toContain(
      'follows episode',
    );
    expect(
      text(await rowOf(makeEpisodeJob({ state: 'editing', step: 5 }), { on: false })),
    ).not.toContain('follows episode');
  });
});

describe('the job sheet on the phone with series on (boards MJobSheetEditing, MJobSheetQueued)', () => {
  it('adds "Episode 6 of <series>" after the client, as plain text', async () => {
    const markup = await sheetOf(makeEpisodeJob({ state: 'editing', step: 5 }));
    const subtitle = markup.match(/<span[^>]*data-slot="job-sheet-series"[^>]*>.*?<\/span>/)?.[0];
    expect(subtitle).toBeDefined();
    expect(text(subtitle ?? '')).toBe('Episode 6 of מיתוס או אמת');
    expect(subtitle).toContain('<bdi>מיתוס או אמת</bdi>');
    // The series' page is on the Mac: nothing here is a link to it.
    expect(markup).not.toContain('/series/');
    expect(markup).not.toMatch(/<a [^>]*job-sheet-series/);
    // After the client's name, with a dot between.
    const client = markup.indexOf('data-slot="job-sheet-client"');
    expect(markup.indexOf('data-slot="job-sheet-series"')).toBeGreaterThan(client);
    expect(text(markup)).toMatch(/עו״ד דוד לוי · Episode 6 of מיתוס או אמת/);
  });

  it('says "The format of the series …" for the format job, as its row’s mark does', async () => {
    const markup = await sheetOf(makeFormatJob());
    expect(text(markup)).toContain('The format of the series מיתוס או אמת');
  });

  it('says nothing for a job in no series, while series are off, or before the series have loaded', async () => {
    for (const markup of [
      await sheetOf(makeJob({ id: 'plain', state: 'queued', placeInLine: 1 })),
      await sheetOf(makeEpisodeJob({ state: 'queued', placeInLine: 1 }), { on: false }),
      await sheetOf(makeEpisodeJob({ state: 'queued', placeInLine: 1 }), { loaded: false }),
    ]) {
      expect(markup).not.toContain('data-slot="job-sheet-series"');
      expect(markup).not.toContain('Episode');
    }
  });

  it('has no series row in its list, even for a queued episode that the Mac gives a Series submenu', async () => {
    const markup = await sheetOf(makeEpisodeJob({ state: 'queued', placeInLine: 2 }));
    const rows = [...markup.matchAll(/data-menu-row="([^"]*)"/g)].map((match) => match[1]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((id) => id?.startsWith('series'))).toEqual([]);
    expect(text(markup)).not.toContain('Open the series');
    expect(text(markup)).not.toContain('Start a series');
  });
});

/** A text note's card in the review's notes list, on a job in the series `seriesName` (or in none). */
function noteCard(
  noteOverrides: Parameters<typeof makeReviewNote>[0],
  variant: 'mac' | 'phone',
  seriesName: string | null,
): string {
  return renderReview(
    <NoteCard
      note={makeReviewNote({ text: 'הכותרת יורדת מהר מדי.', ...noteOverrides })}
      jobId="a1b2c3d4e5f6"
      client="מאפיית הצפון"
      seriesName={seriesName}
      hovered={false}
      active={false}
      onHover={() => {}}
      onGo={() => {}}
      onDelete={() => {}}
      cardRef={() => {}}
      onPlayVoice={() => {}}
      variant={variant}
    />,
  );
}

describe('a note on an episode, on the phone (board MReviewSeries)', () => {
  const NAME = 'סיורים';
  const card = (noteOverrides: Parameters<typeof makeReviewNote>[0] = {}) =>
    noteCard(noteOverrides, 'phone', NAME);

  it('has Series then Style, short labels, 32 px, both outline until pressed', () => {
    const html = card();
    expect(html).toContain('Series</button>');
    expect(html).toContain('Style</button>');
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
    expect(html).not.toContain('Add to style');
    for (const label of ['Series', 'Style']) {
      const toggle = html.match(
        new RegExp(`<button[^>]*aria-pressed="false"[^>]*>(?:(?!</button>).)*${label}</button>`),
      )?.[0];
      expect(toggle, label).toContain('h-8');
      expect(toggle, label).toContain('data-size="xs"');
    }
    expect(html.indexOf('Series</button>')).toBeLessThan(html.indexOf('Style</button>'));
    expect(html).not.toContain('When you send');
  });

  it('fills Series, keeps its label, and says the note goes into the series', () => {
    const html = card({ addToSeries: true });
    const pressed = tagWith(html, 'aria-pressed="true"');
    expect(pressed).toContain('bg-foreground');
    expect(pressed).toContain('text-background');
    expect(html).toContain('Series</button>');
    expect(html).not.toContain('In series');
    expect(text(html)).toContain(`When you send, this also goes into the series ${NAME}`);
    expect(html).toContain(`<bdi class="text-foreground">${NAME}</bdi>`);
    expect(html).not.toContain('every later episode');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it('fills Style, keeps its label, and says the note goes into the client’s style', () => {
    const html = card({ addToStyle: true });
    expect(html).toContain('Style</button>');
    expect(html).not.toContain('In style');
    expect(text(html)).toContain('When you send, this also goes into the style of מאפיית הצפון');
    expect(html).not.toContain('into the series');
  });

  it('shows both lines, the series first, with the phone’s 2 px and 1.43 line', () => {
    const html = card({ addToSeries: true, addToStyle: true });
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html.indexOf('into the series')).toBeLessThan(html.indexOf('into the style of'));
    const lines = html.match(/<div class="[^"]*border-t border-white\/\[0\.08\][^"]*"/g) ?? [];
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain('mt-0.5');
      expect(line).toContain('leading-[1.43]');
    }
  });

  it('is still the Mac’s words on the Mac: In series, In style and "every later episode of"', () => {
    const html = noteCard({ addToSeries: true, addToStyle: true }, 'mac', NAME);
    expect(html).toContain('In series</button>');
    expect(html).toContain('In style</button>');
    expect(html).toContain('When you send, this also goes into every later episode of');
  });

  it('is the one Add to style toggle on a job in no series, on and off', () => {
    const off = noteCard({}, 'phone', null);
    expect(off).toContain('Add to style</button>');
    expect(off).not.toContain('Series');
    const on = noteCard({ addToStyle: true }, 'phone', null);
    expect(on).toContain('In style</button>');
  });
});
