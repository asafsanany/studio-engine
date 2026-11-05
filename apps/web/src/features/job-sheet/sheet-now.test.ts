import type { Job } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { downloadUrl } from '@/data';
import { makeJob, makeMusicView } from '@/data/test-utils';
import { sheetButtons, sheetError, sheetNow, timeOfDay } from './sheet-now';
import {
  JOB_SHEET_STATES,
  type JobSheetState,
  jobSheetJobs,
  jobSheetList,
  jobSheetNow,
} from './test-fixtures';

// The fixtures are the boards' jobs and the moment each board is drawn at; times are UTC clock
// times, so every call pins the zone.
const UTC = { timeZone: 'UTC' };

/** What the sheet says for a job of the boards, at the moment its board is drawn. */
const say = (state: JobSheetState, jobs: readonly Job[] = jobSheetList, sentNotes?: number) =>
  sheetNow(jobSheetJobs[state], jobs, jobSheetNow[state], { ...UTC, sentNotes });

/** A job of the boards with some fields changed. */
const changed = (state: JobSheetState, overrides: Partial<Job>): Job => ({
  ...jobSheetJobs[state],
  ...overrides,
});

describe('sheetNow: the sentence of each state, as the boards draw it', () => {
  it('arriving: files are coming in, with a grey bar that counts down to the start', () => {
    expect(say('arriving')).toEqual({
      sentence:
        'Files are still coming in. The edit starts once nothing new has landed for 60 seconds.',
      progress: {
        pct: 30,
        label: 'Waiting for the last files',
        right: 'starts in 0:42',
        tone: 'grey',
      },
    });
  });

  it('queued: the place, the job it waits for and how long that has left', () => {
    // Two edits run on the board: it waits for the one that finishes first.
    expect(say('queued')).toEqual({
      sentence: '#1 in line. It starts when חנוכה 2026 is done, in about 1 minute.',
    });
  });

  it('held: since when, and that it waits for the person', () => {
    expect(say('held')).toEqual({
      sentence: 'On hold since 11:20. It won’t start until you release it.',
    });
  });

  it('editing: one sentence for the step and a blue bar with its count and the time left', () => {
    expect(say('editing')).toEqual({
      sentence: 'Cutting the video: adding graphic 2 of 5.',
      progress: { pct: 55, label: 'Cut · graphics 2 of 5', right: '~4 min left', tone: 'blue' },
    });
  });

  it('rendering: when it was approved, and a blue bar called Render', () => {
    expect(say('rendering')).toEqual({
      sentence: 'You approved it at 15:10. Making the MP4 now.',
      progress: { pct: 88, label: 'Render', right: '~1 min left', tone: 'blue' },
    });
  });

  it('review, the first cut: its length, and that the MP4 comes after approval', () => {
    expect(say('review')).toEqual({
      sentence: 'The first cut is ready, 0:44. The MP4 is made after you approve it.',
    });
  });

  it('review, a later round: the round, its length and the notes it applied', () => {
    expect(say('reviewRound2', jobSheetList, 3)).toEqual({
      sentence: 'Round 2 is ready, 0:41. It has your 3 notes from round 1.',
    });
  });

  it('failed: the step, when, what is kept, and where Retry starts', () => {
    expect(say('failed')).toEqual({
      sentence:
        'Render stopped at 12:52. Steps 1 to 7 are kept, so Retry only makes the MP4 again.',
    });
  });

  it('cancelled: the step it was stopped in, when, and where Resume picks it up', () => {
    expect(say('cancelled')).toEqual({
      sentence: 'You stopped it during Cut at 10:41. Resume picks it up again at Cut.',
    });
  });

  it('approved: the MP4’s length and size, and that the client has not got it', () => {
    expect(say('approved')).toEqual({
      sentence: 'The MP4 is ready: 0:30, 27 MB. It hasn’t been sent to RGM yet.',
    });
  });

  it('approved with a song and both files made: two files, one to show and one to post (Songs)', () => {
    const song = (state: JobSheetState) =>
      sheetNow(jobSheetJobs[state], jobSheetList, jobSheetNow[state], { ...UTC, twoFiles: true });
    expect(song('approved')).toEqual({
      sentence:
        'Approved and rendered. Two files: one with the song, to show the client, and one without it, to post.',
    });
    // Only the Approved stage: a delivered, paid or archived job keeps the sentence of its stage.
    for (const state of ['delivered', 'paid', 'archived'] as const) {
      expect(song(state)).toEqual(say(state));
    }
    // And without the song the sentence is what it always was.
    expect(
      sheetNow(jobSheetJobs.approved, jobSheetList, jobSheetNow.approved, {
        ...UTC,
        twoFiles: false,
      }),
    ).toEqual(say('approved'));
  });

  it('delivered: the day it was sent and what is owed', () => {
    expect(say('delivered')).toEqual({
      sentence: 'Sent to LAKESHORE on 21 Oct. ₪40 isn’t paid yet.',
    });
  });

  it('paid: the price, the day the money came in, and that nothing is left', () => {
    expect(say('paid')).toEqual({ sentence: 'Paid ₪40 on 21 Oct. Nothing left to do.' });
  });

  it('archived: the day, where it shows, and that it still counts in income', () => {
    expect(say('archived')).toEqual({
      sentence:
        'Archived on 30 Sep, so it only shows with Show archived on. It still counts in income.',
    });
  });

  it('has a sentence for every state of the boards, and a bar for exactly the three that move', () => {
    const withBar = JOB_SHEET_STATES.filter((state) => say(state).progress !== undefined);
    expect(withBar).toEqual(['arriving', 'editing', 'rendering']);
    for (const state of JOB_SHEET_STATES) expect(say(state).sentence, state).not.toBe('');
  });
});

describe('sheetNow: arriving', () => {
  it('fills the bar over the settle wait, and never past it', () => {
    const job = jobSheetJobs.arriving;
    const pctAt = (iso: string) => sheetNow(job, [], iso, UTC).progress;
    expect(pctAt('2026-10-22T15:03:00.000Z')).toMatchObject({ pct: 0, right: 'starts in 1:00' });
    expect(pctAt('2026-10-22T15:03:30.000Z')).toMatchObject({ pct: 50, right: 'starts in 0:30' });
    // The timer fires a moment late: the bar is full and the clock reads 0:00, not a negative.
    expect(pctAt('2026-10-22T15:04:05.000Z')).toMatchObject({ pct: 100, right: 'starts in 0:00' });
  });

  it('rounds the countdown up, so it shows 0:01 until the timer fires', () => {
    const progress = sheetNow(jobSheetJobs.arriving, [], '2026-10-22T15:03:59.200Z', UTC).progress;
    expect(progress?.right).toBe('starts in 0:01');
  });

  it('names the wait the job really has, not a fixed one', () => {
    const job = changed('arriving', { settlesAt: '2026-10-22T15:04:30.000Z' });
    expect(sheetNow(job, [], jobSheetNow.arriving, UTC).sentence).toContain('for 90 seconds');
  });

  it('keeps the sentence and leaves the bar out when it does not know when the wait ends', () => {
    const result = sheetNow(changed('arriving', { settlesAt: null }), [], jobSheetNow.arriving);
    expect(result.sentence).toContain('Files are still coming in.');
    expect(result.progress).toBeUndefined();
  });
});

describe('sheetNow: queued', () => {
  const waiting = jobSheetJobs.queued;
  const editing = (overrides: Partial<Job> = {}): Job => ({
    ...jobSheetJobs.editing,
    ...overrides,
  });
  const sentence = (job: Job, jobs: readonly Job[]) =>
    sheetNow(job, jobs, jobSheetNow.queued, UTC).sentence;

  it('first in line with nobody editing: it starts next', () => {
    expect(sentence(waiting, [waiting])).toBe('#1 in line. It starts next.');
  });

  it('first in line behind an edit with no estimate: names the job and leaves the time out', () => {
    expect(sentence(waiting, [waiting, editing({ etaSec: null })])).toBe(
      '#1 in line. It starts when מיתוס או אמת 6 is done.',
    );
  });

  it('rounds the time left up to whole minutes, and says so for under one', () => {
    const behind = (etaSec: number) => sentence(waiting, [waiting, editing({ etaSec })]);
    expect(behind(240)).toContain('in about 4 minutes.');
    expect(behind(241)).toContain('in about 5 minutes.');
    expect(behind(60)).toContain('in about 1 minute.');
    expect(behind(20)).toContain('in under a minute.');
  });

  it('first in line behind two edits: waits for the one that finishes first', () => {
    const slow = editing({ id: 'slow', name: 'ריל השקה', etaSec: 600 });
    const fast = editing({ id: 'fast', name: 'אדריכלות', etaSec: 120 });
    const unknown = editing({ id: 'unknown', name: 'בלי הערכה', etaSec: null });
    expect(sentence(waiting, [waiting, slow, fast])).toBe(
      '#1 in line. It starts when אדריכלות is done, in about 2 minutes.',
    );
    expect(sentence(waiting, [waiting, unknown, slow])).toBe(
      '#1 in line. It starts when ריל השקה is done, in about 10 minutes.',
    );
  });

  it('second in line waits for the queued job ahead, which has no estimate to give', () => {
    const first = changed('queued', { id: 'first', name: 'ריל השקה', placeInLine: 1 });
    const second = changed('queued', { id: 'second', name: 'אדריכלות', placeInLine: 2 });
    expect(sentence(second, [editing(), first, second])).toBe(
      '#2 in line. It starts when ריל השקה is done.',
    );
  });

  it('does not take itself for the job ahead (a stale list that still has it editing)', () => {
    expect(sentence(waiting, [waiting, { ...waiting, state: 'editing', etaSec: 90 }])).toBe(
      '#1 in line. It starts next.',
    );
  });

  it('a queued job with no place still says it is waiting', () => {
    expect(sentence(changed('queued', { placeInLine: null }), jobSheetList)).toBe(
      'Waiting in line.',
    );
  });

  it('has no bar: the job moves by itself', () => {
    expect(sheetNow(waiting, jobSheetList, jobSheetNow.queued, UTC).progress).toBeUndefined();
  });
});

describe('sheetNow: editing', () => {
  const at = (overrides: Partial<Job>) =>
    sheetNow(changed('editing', overrides), [], jobSheetNow.editing, UTC);

  it.each([
    [1, null, 'Writing the brief.', 'Brief', 0],
    [2, '6/14', 'Transcribing the speech: 6 of 14 files done.', 'Transcribe · 6 of 14', 18],
    [3, null, 'Looking through the footage.', 'Scan', 25],
    [4, null, 'Planning the cut.', 'Plan', 38],
    [5, 'graphics 2/5', 'Cutting the video: adding graphic 2 of 5.', 'Cut · graphics 2 of 5', 55],
    [6, null, 'Building the preview.', 'Preview', 63],
    [7, 'pass 2/3', 'Checking the cut: pass 2 of 3.', 'Check · pass 2 of 3', 83],
  ] as const)(
    'step %i (%s) says %j on a bar called %j at %i%%',
    (step, sub, sentence, label, pct) => {
      expect(at({ step, subProgress: sub })).toEqual({
        sentence,
        progress: { pct, label, right: '~4 min left', tone: 'blue' },
      });
    },
  );

  it('leaves the time left out without an estimate, but keeps the bar', () => {
    expect(at({ etaSec: null }).progress).toEqual({
      pct: 55,
      label: 'Cut · graphics 2 of 5',
      right: '',
      tone: 'blue',
    });
  });

  it('says "< 1 min left" for the last seconds', () => {
    expect(at({ etaSec: 30 }).progress?.right).toBe('< 1 min left');
  });

  it('puts a count it does not know into the bar, not into the sentence', () => {
    const result = at({ step: 1, subProgress: 'reading 2 files' });
    expect(result.sentence).toBe('Writing the brief.');
    expect(result.progress?.label).toBe('Brief · reading 2 files');
  });

  it('keeps the plain step when the count is not in the shape the step writes', () => {
    expect(at({ step: 5, subProgress: 'slot 2' }).sentence).toBe('Cutting the video.');
  });

  it('a revise run says whose notes it applies', () => {
    const result = at({ runKind: 'revise', round: 1, step: 4, subProgress: null });
    expect(result.sentence).toBe('Applying your notes from round 1. Planning the cut.');
  });

  it('without a step yet, only says it is starting, and has no bar', () => {
    expect(at({ step: null, subProgress: null })).toEqual({ sentence: 'The edit is starting.' });
  });
});

describe('sheetNow: rendering', () => {
  const render = (overrides: Partial<Job>) =>
    sheetNow(changed('rendering', overrides), [], jobSheetNow.rendering, UTC);

  it('without the time of approval, leaves "You approved it" out', () => {
    expect(render({ approvedAt: null }).sentence).toBe('Making the MP4 now.');
  });

  it('is also the last step of an edit that renders on its own', () => {
    const result = render({ runKind: 'edit', approvedAt: null, step: 8 });
    expect(result.sentence).toBe('Making the MP4 now.');
    expect(result.progress?.label).toBe('Render');
  });

  it('keeps the bar when there is no estimate', () => {
    expect(render({ etaSec: null }).progress).toMatchObject({ label: 'Render', right: '' });
  });
});

describe('sheetNow: review', () => {
  it('leaves the length out when there is no preview', () => {
    const job = changed('review', { preview: null });
    expect(sheetNow(job, [], jobSheetNow.review, UTC).sentence).toBe(
      'The first cut is ready. The MP4 is made after you approve it.',
    );
  });

  it('counts rounds like the row: round 1’s notes made the second cut, round 2’s the third', () => {
    const third = changed('reviewRound2', { round: 2 });
    expect(sheetNow(third, [], jobSheetNow.reviewRound2, { ...UTC, sentNotes: 2 }).sentence).toBe(
      'Round 3 is ready, 0:41. It has your 2 notes from round 2.',
    );
  });

  it('says "1 note" for one, and leaves the count out when it is not known', () => {
    expect(say('reviewRound2', jobSheetList, 1).sentence).toBe(
      'Round 2 is ready, 0:41. It has your 1 note from round 1.',
    );
    for (const unknown of [undefined, null, 0]) {
      expect(
        sheetNow(jobSheetJobs.reviewRound2, [], jobSheetNow.reviewRound2, {
          ...UTC,
          sentNotes: unknown,
        }).sentence,
        String(unknown),
      ).toBe('Round 2 is ready, 0:41. It has your notes from round 1.');
    }
  });
});

describe('sheetNow: failed and cancelled', () => {
  const failedAt = (step: 1 | 2 | 5 | null) =>
    sheetNow(changed('failed', { failedAt: step }), [], jobSheetNow.failed, UTC).sentence;

  it('tells Retry where it starts, from the step that failed', () => {
    expect(failedAt(5)).toBe(
      'Cut stopped at 12:52. Steps 1 to 4 are kept, so Retry starts at Cut.',
    );
  });

  it('is right about the first steps, where there is little or nothing to keep', () => {
    expect(failedAt(2)).toBe(
      'Transcribe stopped at 12:52. Step 1 is kept, so Retry starts at Transcribe.',
    );
    expect(failedAt(1)).toBe(
      'Brief stopped at 12:52. Nothing was finished yet, so Retry starts at Brief.',
    );
  });

  it('says only what it knows when the step is not', () => {
    expect(failedAt(null)).toBe('It stopped at 12:52.');
    const cancelled = changed('cancelled', { stoppedAt: null });
    expect(sheetNow(cancelled, [], jobSheetNow.cancelled, UTC).sentence).toBe(
      'You stopped it at 10:41. Resume picks it up again.',
    );
  });
});

describe('sheetNow: a finished job', () => {
  const ready = (overrides: Partial<Job>) =>
    sheetNow(changed('approved', overrides), [], jobSheetNow.approved, UTC).sentence;

  it('approved without an export record still says it is not sent', () => {
    expect(ready({ output: null })).toBe('The MP4 is ready. It hasn’t been sent to RGM yet.');
  });

  it('names the client as the folder does, in its own script', () => {
    expect(ready({ client: 'עו״ד דוד לוי' })).toBe(
      'The MP4 is ready: 0:30, 27 MB. It hasn’t been sent to עו״ד דוד לוי yet.',
    );
  });

  it('delivered reads the price it was frozen at, in its currency', () => {
    const delivered = changed('delivered', {
      delivery: {
        deliveredAt: '2026-10-21T14:00:00.000Z',
        price: 37.5,
        currency: 'USD',
        paidOn: null,
      },
    });
    expect(sheetNow(delivered, [], jobSheetNow.delivered, UTC).sentence).toBe(
      'Sent to LAKESHORE on 21 Oct. $37.50 isn’t paid yet.',
    );
  });

  it('delivered takes the day on the browser’s calendar', () => {
    // 22:30 on the 21st in New York is the 22nd in Jerusalem.
    const delivered = changed('delivered', {
      delivery: {
        deliveredAt: '2026-10-22T02:30:00.000Z',
        price: 40,
        currency: 'ILS',
        paidOn: null,
      },
    });
    const sentence = (timeZone: string) =>
      sheetNow(delivered, [], jobSheetNow.delivered, { timeZone }).sentence;
    expect(sentence('America/New_York')).toContain('on 21 Oct.');
    expect(sentence('Asia/Jerusalem')).toContain('on 22 Oct.');
  });

  // 21 Oct 2026 14:00 UTC: the video was sent; the reel was posted on Tuesday the 20th.
  const REEL = { uploadedAt: '2026-10-20T09:30:00.000Z', reelUrl: 'https://x.test/reel/1/' };

  it('uploaded: where it was posted and what is still owed', () => {
    const uploaded = changed('delivered', {
      delivery: { ...jobSheetJobs.delivered.delivery, ...REEL } as Job['delivery'],
    });
    expect(sheetNow(uploaded, [], jobSheetNow.delivered, UTC).sentence).toBe(
      'Posted on Instagram Tue 20 Oct. ₪40 isn’t paid yet.',
    );
  });

  it('uploaded, for an editor (no money): only where it was posted', () => {
    const uploaded = changed('delivered', {
      delivery: { deliveredAt: '2026-10-21T14:00:00.000Z', ...REEL },
    });
    expect(sheetNow(uploaded, [], jobSheetNow.delivered, UTC).sentence).toBe(
      'Posted on Instagram Tue 20 Oct.',
    );
  });

  it('paid keeps its sentence when a reel is linked to it', () => {
    const paid = changed('paid', {
      delivery: { ...jobSheetJobs.paid.delivery, ...REEL } as Job['delivery'],
    });
    expect(sheetNow(paid, [], jobSheetNow.paid, UTC).sentence).toBe(
      sheetNow(jobSheetJobs.paid, [], jobSheetNow.paid, UTC).sentence,
    );
  });

  it('an archived video that was never delivered does not claim to count in income', () => {
    const archived = changed('approved', { archivedAt: '2026-09-30T09:00:00.000Z' });
    expect(sheetNow(archived, [], jobSheetNow.approved, UTC).sentence).toBe(
      'Archived on 30 Sep, so it only shows with Show archived on.',
    );
  });
});

describe('timeOfDay', () => {
  it('is the 24-hour clock of the zone, with a leading zero', () => {
    expect(timeOfDay('2026-10-22T09:05:00.000Z', 'UTC')).toBe('09:05');
    expect(timeOfDay('2026-10-22T09:05:00.000Z', 'Asia/Jerusalem')).toBe('12:05');
    expect(timeOfDay('2026-10-22T23:59:00.000Z', 'UTC')).toBe('23:59');
  });

  it('is empty for a moment it cannot read', () => {
    expect(timeOfDay('not a time', 'UTC')).toBe('');
  });
});

describe('sheetError', () => {
  it('titles the box with the step and the time, and keeps the whole text', () => {
    expect(sheetError(jobSheetJobs.failed, 'UTC')).toEqual({
      title: 'Failed at Render · 12:52',
      text: 'ffmpeg exited with code 1:\nError writing trailer: No space left on device',
    });
  });

  it('titles it "Failed" alone when the step is not known', () => {
    expect(sheetError(changed('failed', { failedAt: null }), 'UTC')?.title).toBe('Failed · 12:52');
  });

  it('a job that waits for a camera LUT (LU10): titled by what it waits for, with its id', () => {
    const waiting = changed('failed', {
      error: 'Waiting for a camera LUT: the clips are Sony S-Log3 (C0003.MP4).',
    });
    expect(sheetError(waiting, 'UTC')).toEqual({
      title: 'Waiting for a camera LUT · 12:52',
      text: 'Waiting for a camera LUT: the clips are Sony S-Log3 (C0003.MP4).',
      cameraWait: { curve: 'slog3', source: 'C0003.MP4', several: false },
      jobId: waiting.id,
    });
  });

  it('any other error text is a plain failure, with no camera wait', () => {
    const error = sheetError(jobSheetJobs.failed, 'UTC');
    expect(error).not.toHaveProperty('cameraWait');
    expect(error).not.toHaveProperty('jobId');
  });

  it('is nothing for a failed job without an error text, and for every other state', () => {
    expect(sheetError(changed('failed', { error: null }), 'UTC')).toBeNull();
    for (const state of JOB_SHEET_STATES.filter((s) => s !== 'failed')) {
      expect(sheetError(jobSheetJobs[state], 'UTC'), state).toBeNull();
    }
  });
});

describe('sheetButtons: the next step with its name, and Download MP4', () => {
  const buttons = (state: JobSheetState) => sheetButtons(jobSheetJobs[state]);

  it.each([
    ['arriving', 'start', 'Start now'],
    ['held', 'release', 'Release'],
    ['failed', 'retry', 'Retry from Render'],
    ['cancelled', 'resume', 'Resume'],
    ['review', 'review', 'Review'],
    ['reviewRound2', 'review', 'Review'],
    ['approved', 'deliver', 'Mark delivered'],
    ['delivered', 'pay', 'Mark paid…'],
  ] as const)('%s: the primary button is %s, named %j', (state, kind, label) => {
    expect(buttons(state).primary).toEqual({ kind, label });
  });

  it.each(['queued', 'editing', 'rendering'] as const)(
    '%s has no button at all: it moves by itself',
    (state) => {
      expect(buttons(state)).toEqual({ primary: null, download: null });
    },
  );

  it('a ready job has Download MP4, with the link to its export', () => {
    for (const state of ['approved', 'delivered', 'paid', 'archived'] as const) {
      expect(buttons(state).download, state).toEqual({
        label: 'Download MP4',
        href: downloadUrl(jobSheetJobs[state].id),
      });
    }
  });

  it('no other state has Download MP4', () => {
    const others = JOB_SHEET_STATES.filter(
      (state) => !['approved', 'delivered', 'paid', 'archived'].includes(state),
    );
    for (const state of others) expect(buttons(state).download, state).toBeNull();
  });

  it('an uploaded job’s next step is Mark paid… too', () => {
    const uploaded = changed('delivered', {
      delivery: {
        ...jobSheetJobs.delivered.delivery,
        uploadedAt: '2026-10-20T09:30:00.000Z',
      } as Job['delivery'],
    });
    expect(sheetButtons(uploaded).primary).toEqual({ kind: 'pay', label: 'Mark paid…' });
    expect(sheetButtons(uploaded).download).toEqual({
      label: 'Download MP4',
      href: downloadUrl(uploaded.id),
    });
  });

  it('a paid job has only Download, and so does an archived one: nothing is left to do', () => {
    expect(buttons('paid')).toMatchObject({ primary: null });
    expect(buttons('archived')).toMatchObject({ primary: null });
  });

  it('Retry names the step that failed', () => {
    const retry = sheetButtons(changed('failed', { failedAt: 5 })).primary;
    expect(retry).toEqual({ kind: 'retry', label: 'Retry from Cut' });
  });

  it('a video whose folder was deleted can be paid for but not downloaded', () => {
    const orphan = { ...jobSheetJobs.delivered, folderDeleted: true as const };
    expect(sheetButtons(orphan)).toEqual({
      primary: { kind: 'pay', label: 'Mark paid…' },
      download: null,
    });
  });

  it('is the same step as the row’s button, for a made-up job too', () => {
    const job = makeJob({ state: 'held', placeInLine: null });
    expect(sheetButtons(job).primary).toEqual({ kind: 'release', label: 'Release' });
  });
});

// Soundtrack (boards SDSheet): what the sentence says about the music of the cut.
describe('sheetNow: music', () => {
  const failure = (code: 'no_credits' | 'down') => ({
    id: 'v1',
    code,
    message: 'ElevenLabs says this month’s credits are used up.',
    at: '2026-10-23T00:16:00.000Z',
  });

  describe('editing, while the first music is written', () => {
    const making = makeMusicView({
      picked: null,
      versions: [],
      picks: [],
      making: { id: 'v1', ask: null, startedAt: '2026-10-23T00:19:00.000Z' },
    });
    const preview = (overrides: Partial<Job>, music: Parameters<typeof makeMusicView>[0] | null) =>
      sheetNow(
        changed('editing', { step: 6, subProgress: 'making the music', ...overrides }),
        [],
        jobSheetNow.editing,
        { ...UTC, music: music === null ? null : makeMusicView(music) },
      );

    it('says the cut is planned and ElevenLabs is writing its music, and keeps the bar', () => {
      const now = preview({}, making);
      expect(now.sentence).toBe(
        'The cut is planned. ElevenLabs is writing its music now, to the cut’s shape.',
      );
      expect(now.progress).toMatchObject({ label: 'Preview · making the music', tone: 'blue' });
    });

    it('says the usual thing without music, on another step, for a later version or a revise run', () => {
      const usual = 'Building the preview.';
      expect(preview({}, null).sentence).toBe(usual);
      expect(preview({}, { ...making, making: null }).sentence).toBe(usual);
      expect(preview({ step: 5, subProgress: null }, making).sentence).toBe('Cutting the video.');
      expect(preview({}, { ...making, versions: makeMusicView().versions }).sentence).toBe(usual);
      expect(preview({ runKind: 'revise', round: 1 }, making).sentence).toBe(
        `Applying your notes from round 1. ${usual}`,
      );
    });
  });

  describe('review, the first cut', () => {
    const first = (music: Parameters<typeof makeMusicView>[0] | null) =>
      sheetNow(jobSheetJobs.review, [], jobSheetNow.review, {
        ...UTC,
        music: music === null ? null : makeMusicView(music),
      }).sentence;

    it('came with music made for it', () => {
      expect(first({})).toBe(
        'The first cut is ready, 0:44, with music made for it. The MP4 is made after you approve it.',
      );
    });

    it('came without it when the first make found no credits, and says what to do', () => {
      expect(first({ picked: null, versions: [], picks: [], failure: failure('no_credits') })).toBe(
        'The first cut is ready, 0:44, but without music: ElevenLabs had no credits left. You can make it in Review once they are back.',
      );
    });

    it('came without it for any other reason too, and can be tried again', () => {
      expect(first({ picked: null, versions: [], picks: [], failure: failure('down') })).toBe(
        'The first cut is ready, 0:44, but without music: it couldn’t be made. You can try again in Review.',
      );
    });

    it('says nothing of music when there is none, it was turned off, or it did not come from ElevenLabs', () => {
      const usual = 'The first cut is ready, 0:44. The MP4 is made after you approve it.';
      expect(first(null)).toBe(usual);
      expect(first({ picked: 'off' })).toBe(usual);
      expect(first({ source: 'supplied', file: 'Summer Vibes.mp3', picked: 'file' })).toBe(usual);
      expect(first({ source: 'none', reason: 'The client’s style says no music.' })).toBe(usual);
    });

    it('is the same for a later round', () => {
      expect(
        sheetNow(jobSheetJobs.reviewRound2, [], jobSheetNow.reviewRound2, {
          ...UTC,
          sentNotes: 3,
          music: makeMusicView(),
        }).sentence,
      ).toBe('Round 2 is ready, 0:41. It has your 3 notes from round 1.');
    });
  });
});
