// A job the job sheet was opened on right after it was switched on (v0.16.0, CVP-262):
// אולימפוס / ונציה, "Ready to review · round 2". Its step runs are sparse and partly open, unlike the
// boards' (test-fixtures.ts), which every step has a run in:
//
// - the worker times only the steps the editing agent reports, so the first cut has runs for
//   Brief, Preview and Check and the revise run for Plan, Preview and Check; Transcribe, Scan, Plan
//   and Cut of the first cut, and Cut of round 2, never got one;
// - the first cut's runs ended, but round 2's Plan and Check are still open although the job has
//   been waiting in Review since (an engine restart cut the run in two, and the second half cannot
//   close what the first half opened);
// - the first cut was made on 21 Oct, its notes sent that evening, and round 2's revise run ran the
//   next day.
//
// Times are UTC clock times; a test reads them with `timeZone: 'UTC'`.

import type { Job, JobStepRun, ReviewNote, RunKind, StepId } from '@studio/shared';
import { makeJob, makeReviewNote } from '@/data/test-utils';

const FIRST_DAY = '2026-10-21';
const SECOND_DAY = '2026-10-22';

const iso = (day: string, time: string): string => `${day}T${time}.000Z`;

function run(
  step: StepId,
  runKind: RunKind,
  round: number,
  day: string,
  start: string,
  end: string | null,
): JobStepRun {
  return {
    step,
    runKind,
    round,
    startedAt: iso(day, start),
    endedAt: end === null ? null : iso(day, end),
  };
}

/** `GET /api/jobs/901b98290e2a/steps`, as the engine answered it. */
export const realRuns: readonly JobStepRun[] = [
  run(1, 'edit', 0, FIRST_DAY, '18:38:53', '18:39:34'),
  run(6, 'edit', 0, FIRST_DAY, '18:40:21', '18:40:26'),
  run(7, 'edit', 0, FIRST_DAY, '18:40:26', '18:41:17'),
  run(4, 'revise', 1, SECOND_DAY, '18:55:01', null),
  run(6, 'revise', 1, SECOND_DAY, '18:57:57', '18:57:58'),
  run(7, 'revise', 1, SECOND_DAY, '18:57:58', null),
];

/** The first cut's runs alone: what the sheet had read when the job first reached Review. */
export const realFirstCutRuns: readonly JobStepRun[] = realRuns.filter((r) => r.round === 0);

/** Waiting in Review at round 1 since 18:58, the moment the revise run's preview was ready. */
export const realJob: Job = makeJob({
  id: '901b98290e2a',
  clientId: '4b16f268bd46',
  client: 'אולימפוס',
  name: 'ונציה',
  relPath: 'אולימפוס/ונציה',
  state: 'review',
  step: 7,
  placeInLine: null,
  runKind: 'revise',
  round: 1,
  preview: { durationSec: 38, width: 1080, height: 1920 },
  addedAt: iso(FIRST_DAY, '18:30:00'),
  lastChangeAt: iso(FIRST_DAY, '18:30:00'),
  settledAt: iso(FIRST_DAY, '18:31:00'),
  updatedAt: iso(SECOND_DAY, '18:58:40'),
});

/** The moment the job was looked at: twelve minutes after it reached Review. */
export const realNow = iso(SECOND_DAY, '19:10:40');

/** Round 1's notes, sent on the evening of the 21st. */
export const realNotes: readonly ReviewNote[] = [
  makeReviewNote({
    id: 'real-n1',
    jobId: realJob.id,
    round: 1,
    atSec: 4.2,
    text: 'Shorter intro',
    sentAt: iso(FIRST_DAY, '21:54:10'),
    createdAt: iso(FIRST_DAY, '21:50:00'),
  }),
  makeReviewNote({
    id: 'real-n2',
    jobId: realJob.id,
    round: 1,
    atSec: 19,
    text: 'Lower the music',
    sentAt: iso(FIRST_DAY, '21:54:10'),
    createdAt: iso(FIRST_DAY, '21:52:00'),
  }),
];
