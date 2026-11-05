// What the job sheet's History part says (design canvas page "Job sheet", board JSSheet): one row
// per thing that happened to the job, "time · what happened", oldest first. There is no history
// table: every row is read from what is already stored, the job itself, its step runs
// (`GET /api/jobs/:id/steps`) and the review notes that were sent (`GET /api/jobs/:id/sent-notes`).
// Pure: the clock and the time zone are parameters.
//
// What is stored, and so what can be said:
//   addedAt                        Folder appeared
//   settledAt (heldSettledAt)      Settled: <inputs>        not when it is a later re-queue (retry, resume)
//   the first edit run             Started · <effort>
//   a round's Check run, ended     First cut ready for review / Round N ready for review
//     (Check can stay open: see `readyMoments` for the moment such a round is ready)
//   the sent notes' sentAt         You sent K notes · round N   (no count when they failed to load)
//   approvedAt                     Approved by you
//   the render run, ended          MP4 ready in _Exports/<client>
//   delivery                       Marked delivered · ₪40, Marked paid
//   delivery.uploadedAt            Uploaded · posted Tue 20 Oct   (a reel is linked to the job)
//   archivedAt                     Archived
//   state failed / cancelled       <Step> failed / Cancelled by you during <Step>   (at updatedAt)
//   the job's music.json           its music lines (Soundtrack, `musicHistoryRows`), while given:
//                                  Music vN made · …, You picked music vN, Couldn’t make music: …;
//                                  with Songs on, the song's: The brief found the song on Yael’s
//                                  screenshot: …, Got the song from YouTube Music (3:12). …
//   the second file's status        Rendered with the song, and without it   (Songs, once it is made)
//   the Generate stage's events      (a generated job, `GET /api/jobs/:id/generate/history`) what it
//                                    did, in the words of `generateHistoryText`: the formats asked
//                                    for, the voice, the looks, each clip, the budget, a stop

import {
  CHECK_STEP,
  EFFORT_LABELS,
  GENERATE_STEP_NAME,
  type GenerateHistoryEvent,
  generateFailureOf,
  generateHistoryText,
  generateHistoryTone,
  type Job,
  type JobStepRun,
  type MusicView,
  type NoSongStatus,
  RENDER_STEP,
  type ReviewNote,
  runEffort,
  STEP_LABELS,
  songEventText,
  type TimeInput,
} from '@studio/shared';
import { formatPrice, isPriced, paidDay, postedDay } from '@/features/jobs/delivery-text';
import { EXPORTS_FOLDER, historyTime, inputsText } from './sheet-details';
import { type HistoryTone, musicHistoryRows } from './sheet-music';

export interface HistoryRow {
  /** Unique within a job's history: what kind of row it is, with its round where it has one. */
  id: string;
  /** "13:01" for a moment today, "21 Oct" for an earlier day. */
  time: string;
  text: string;
  /** How the line reads on top of the normal colour: music that could not be made is `failure`, music being made is `active`. */
  tone?: HistoryTone;
}

/** What `historyRows` reads. `runs` and `notes` are `undefined` until they have arrived (or failed). */
export interface HistorySource {
  job: Job;
  runs: readonly JobStepRun[] | undefined;
  /** The notes that were sent (`GET /api/jobs/:id/sent-notes`), not the Review dialog's drafts. */
  notes: readonly ReviewNote[] | undefined;
  /**
   * The notes could not be loaded (as opposed to "not here yet"). Only then does a round the runs
   * show was sent, with no notes to count, say "You sent notes · round N".
   */
  notesFailed?: boolean;
  /**
   * The job's music (Soundtrack, `GET /api/jobs/:id/music`): given only while the switch is on and
   * the job has music.json. Left out, there are no music lines.
   */
  music?: MusicView | null;
  /**
   * The status of the second file (Songs, `GET /api/jobs/:id/no-song`): given only while Songs is
   * on and it has arrived. Once it is `ready` the history says it was rendered. Left out, no line.
   */
  noSong?: NoSongStatus | null;
  /**
   * What the Generate stage did (Generated videos, GN9): given only for a generated job, once it has
   * arrived. Its events have their own times; a stop of the stage takes the place of the generic
   * "<Step> failed" row, which would only say the same thing less well.
   */
  generate?: readonly GenerateHistoryEvent[] | undefined;
}

/** A row on its way to being shown: when it happened, as a number to sort by, and how it reads. */
interface Event {
  id: string;
  /** Epoch milliseconds, to put the rows in order. */
  at: number;
  /** The row's time as shown. */
  time: string;
  text: string;
  tone?: HistoryTone;
}

const parse = (iso: string): number => Date.parse(iso);

/** "1 note", "3 notes". */
const notesText = (count: number): string => `${count} ${count === 1 ? 'note' : 'notes'}`;

/** The first run (oldest `startedAt`) that passes `test`, or `undefined`. */
function firstRun(
  runs: readonly JobStepRun[],
  test: (run: JobStepRun) => boolean,
): JobStepRun | undefined {
  let found: JobStepRun | undefined;
  for (const run of runs) {
    if (test(run) && (found === undefined || parse(run.startedAt) < parse(found.startedAt))) {
      found = run;
    }
  }
  return found;
}

/**
 * The runs of `step` that ended (a run a failure or a cancel left open does not count), the latest
 * ending for each round, by round. A step that was run again in the same round (a retry) is
 * reported by its last run.
 */
function lastEndsByRound(runs: readonly JobStepRun[], step: number): Map<number, string> {
  const ends = new Map<number, string>();
  for (const run of runs) {
    if (run.step !== step || run.endedAt === null) continue;
    const known = ends.get(run.round);
    if (known === undefined || parse(run.endedAt) > parse(known)) ends.set(run.round, run.endedAt);
  }
  return ends;
}

/**
 * When each round was ready for review, by round (numbered like a run's `round`).
 *
 * The end of the round's Check run is the moment. Real runs are sparse and some stay open for good
 * (the worker times only the steps the editing agent reports, and a run an engine restart cut in
 * two never closes the step the first half began), so a round whose Check has no end falls back,
 * when the job has got to the round's review at all, to:
 * - the moment the job reached Review (`job.updatedAt`, which nothing else moves while the job
 *   waits there) for the round it is waiting in now;
 * - the last moment of the round's own runs for a round the job has left (notes were sent, or it
 *   was approved): the latest end among them, or the start of one left open. Not the start of the
 *   next round's first run: that is when Send notes started it, after all the time spent in
 *   Review, and it would put the row next to the notes it came before.
 *
 * A round that was not reached (the job is still editing it, failed in it, or was stopped) has no
 * moment, and neither has a left round with no run of its own to read a time from.
 */
function readyMoments(job: Job, runs: readonly JobStepRun[]): Map<number, string> {
  const moments = lastEndsByRound(runs, CHECK_STEP);

  const lastMoment = new Map<number, string>();
  for (const run of runs) {
    if (run.runKind === 'render') continue;
    const at =
      run.endedAt !== null && parse(run.endedAt) > parse(run.startedAt)
        ? run.endedAt
        : run.startedAt;
    const known = lastMoment.get(run.round);
    if (known === undefined || parse(at) > parse(known)) lastMoment.set(run.round, at);
  }

  const approved = job.approvedAt !== null;
  const waiting = job.state === 'review';
  const rounds = new Set<number>(lastMoment.keys());
  if (waiting) rounds.add(job.round);
  for (const round of rounds) {
    if (moments.has(round)) continue;
    if (round < job.round || (round === job.round && approved)) {
      const at = lastMoment.get(round);
      if (at !== undefined) moments.set(round, at);
    } else if (round === job.round && waiting) {
      moments.set(round, job.updatedAt);
    }
  }
  return moments;
}

/** "First cut ready for review" for the first run's Check, "Round 2 ready for review" after one round of notes. */
function readyText(round: number): string {
  return round === 0 ? 'First cut ready for review' : `Round ${round + 1} ready for review`;
}

/**
 * The history of a job, oldest first (rows at the same moment stay in the order of the table above).
 * A row whose time cannot be read is left out, and so is one whose source has not arrived: with
 * `runs` undefined the rows from the step runs are missing, with `notes` undefined the notes' rows
 * are.
 *
 * Notes: the rows say "You sent K notes · round N" from the notes that were sent. A round the
 * runs show was sent (it has a revise run) but whose notes are not among them says "You sent notes
 * · round N" at the moment its revise run started, which is when Send notes started it. That
 * count-less row is for the notes that failed to load (`notesFailed`) or a round they do not hold;
 * while they are still on their way there is no row yet, so the count never changes under the eye.
 */
export function historyRows(
  { job, runs, notes, notesFailed = false, music = null, noSong = null, generate }: HistorySource,
  now: TimeInput,
  timeZone?: string,
): HistoryRow[] {
  const events: Event[] = [];
  const add = (id: string, iso: string, text: string, tone?: HistoryTone) => {
    const at = parse(iso);
    const time = historyTime(iso, now, timeZone);
    if (!Number.isFinite(at) || time === '') return;
    events.push({ id, at, time, text, ...(tone ? { tone } : {}) });
  };

  const firstEdit = runs && firstRun(runs, (run) => run.runKind === 'edit');

  add('appeared', job.addedAt, 'Folder appeared');

  // `settledAt` is when the job last joined the queue. A retry or a resume joins it again, long
  // after the edit started; that is no settling of the folder, so such a time is left out.
  const settledAt = job.settledAt ?? job.heldSettledAt;
  if (settledAt !== null && (!firstEdit || parse(settledAt) <= parse(firstEdit.startedAt))) {
    const inputs = inputsText(job.inputs, ', ');
    add('settled', settledAt, inputs === '' ? 'Settled' : `Settled: ${inputs}`);
  }

  if (firstEdit) {
    add('started', firstEdit.startedAt, `Started · ${EFFORT_LABELS[runEffort(job.effort)]}`);
  }

  if (runs) {
    for (const [round, readyAt] of readyMoments(job, runs)) {
      add(`ready-${round}`, readyAt, readyText(round));
    }
  }

  // The notes that were sent, a row per round.
  const sentRounds = new Set<number>();
  if (notes) {
    const byRound = new Map<number, { count: number; sentAt: string }>();
    for (const note of notes) {
      if (note.round === null || note.sentAt === null) continue;
      const group = byRound.get(note.round);
      if (group === undefined) byRound.set(note.round, { count: 1, sentAt: note.sentAt });
      else {
        group.count += 1;
        if (parse(note.sentAt) < parse(group.sentAt)) group.sentAt = note.sentAt;
      }
    }
    for (const [round, { count, sentAt }] of byRound) {
      sentRounds.add(round);
      add(`sent-${round}`, sentAt, `You sent ${notesText(count)} · round ${round}`);
    }
  }
  if (runs && (notes !== undefined || notesFailed)) {
    // A round with a revise run was sent, whether or not its notes are known: say so at the moment
    // Send notes started the run.
    const started = new Map<number, string>();
    for (const run of runs) {
      if (run.runKind !== 'revise' || sentRounds.has(run.round)) continue;
      const known = started.get(run.round);
      if (known === undefined || parse(run.startedAt) < parse(known)) {
        started.set(run.round, run.startedAt);
      }
    }
    for (const [round, startedAt] of started) {
      add(`sent-${round}`, startedAt, `You sent notes · round ${round}`);
    }
  }

  if (music !== null) {
    // The Brief run is the first step of the first edit run: a song it found was named by then.
    const brief = runs && firstRun(runs, (run) => run.runKind === 'edit' && run.step === 1);
    const briefAt = brief?.endedAt ?? null;
    for (const line of musicHistoryRows(music, { briefAt })) {
      add(line.id, line.at, line.text, line.tone);
    }
  }

  // The Generate stage (a generated job): one row for each thing it did, at its own moment.
  let generateStopped = false;
  generate?.forEach((event, index) => {
    const tone = generateHistoryTone(event);
    add(
      `generate-${index}`,
      event.at,
      generateHistoryText(event),
      tone === 'failure' ? 'failure' : tone === 'warn' ? 'warn' : undefined,
    );
    if (event.kind === 'stopped') generateStopped = true;
  });

  if (job.approvedAt !== null) add('approved', job.approvedAt, 'Approved by you');

  if (runs) {
    // The export is ready when the render run ends; a job rendered again is ready as of the last.
    let rendered: string | undefined;
    for (const endedAt of lastEndsByRound(runs, RENDER_STEP).values()) {
      if (rendered === undefined || parse(endedAt) > parse(rendered)) rendered = endedAt;
    }
    if (rendered !== undefined)
      add('mp4', rendered, `MP4 ready in ${EXPORTS_FOLDER}/${job.client}`);
  }

  // The second file, the one without the song, is made after the MP4 (Songs).
  if (noSong !== null && noSong.state === 'ready') {
    add(
      'export-no-song',
      noSong.at,
      songEventText({ type: 'export.no-song', at: noSong.at, file: noSong.file }),
    );
  }

  const { delivery } = job;
  if (delivery !== null) {
    add(
      'delivered',
      delivery.deliveredAt,
      // An editor's job has no price: "Marked delivered" alone.
      isPriced(delivery)
        ? `Marked delivered · ${formatPrice(delivery.price, delivery.currency)}`
        : 'Marked delivered',
    );
    if (delivery.uploadedAt !== undefined) {
      // The reel was posted at its own moment, which can be before the video was marked delivered:
      // the row is never put before the delivery it follows, and its text keeps the real day.
      const when = Math.max(parse(delivery.deliveredAt), parse(delivery.uploadedAt));
      if (Number.isFinite(when)) {
        add(
          'uploaded',
          new Date(when).toISOString(),
          `Uploaded · posted ${postedDay(delivery, timeZone)}`,
        );
      }
    }
    if (delivery.paidOn != null) {
      // The money came in on a day, not at a moment: it is shown as that day, and sorted at the
      // start of it, but never before the delivery it pays for.
      const paidSort = Math.max(
        parse(delivery.deliveredAt),
        Date.parse(`${delivery.paidOn}T00:00:00Z`),
      );
      if (Number.isFinite(paidSort)) {
        events.push({
          id: 'paid',
          at: paidSort,
          time: paidDay(delivery.paidOn),
          text: 'Marked paid',
        });
      }
    }
  }

  if (job.archivedAt !== null) add('archived', job.archivedAt, 'Archived');

  if (job.state === 'failed') {
    // A stop of the Generate stage is already a row of its own ("Stopped: the Higgsfield balance is empty").
    const generateStop = generateFailureOf(job) !== null;
    if (!(generateStop && generateStopped)) {
      const text = generateStop
        ? `${GENERATE_STEP_NAME} failed`
        : job.failedAt === null
          ? 'Failed'
          : `${STEP_LABELS[job.failedAt]} failed`;
      add('failed', job.updatedAt, text, generateStop ? 'failure' : undefined);
    }
  }
  if (job.state === 'cancelled') {
    const text =
      job.stoppedAt === null
        ? 'Cancelled by you'
        : `Cancelled by you during ${STEP_LABELS[job.stoppedAt]}`;
    add('cancelled', job.updatedAt, text);
  }

  // Array.prototype.sort is stable: rows at the same moment stay in the order they were added in.
  return events
    .sort((a, b) => a.at - b.at)
    .map(({ id, time, text, tone }) => (tone ? { id, time, text, tone } : { id, time, text }));
}
