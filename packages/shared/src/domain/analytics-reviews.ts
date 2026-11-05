import {
  ANALYTICS_SIZES,
  type AnalyticsApprovalBucket,
  type AnalyticsNoteTopic,
  type AnalyticsReviews,
} from './analytics.ts';
import type { ComputeAnalyticsInput } from './analytics-compute.ts';
import { median } from './analytics-jobs.ts';
import {
  bucketIndexOf,
  bucketStartsEnding,
  inputPeriod,
  localDayOf,
  msOf,
} from './analytics-time.ts';

// Section "Reviews" of the Analytics page: Approved first time, by week, and What your notes are
// about.
//
// - Approved first time: each of the last 12 weeks (Sunday to Saturday, this week last; in the week
//   period each of the last 14 days, today last) counts the jobs approved in it (`approvedAt`) and
//   how many of those were approved at round 0, with no notes ever sent. The share is the second
//   over the first, `null` for a week (or day) with no approvals. `medianReruns` is the median
//   `round` (rounds of notes sent, i.e. re-runs) of those jobs. Archived jobs count: an approval
//   is a fact whether or not the job is still on the list.
// - What your notes are about: every sent note whose topic is known (`noteTopics`, note id to a
//   short topic, written by the background topic pass) is counted under its topic, together with
//   the client of its job. A note without a topic yet is counted in `notGroupedYet`, so the page
//   can say how many are still waiting. Topics are all-time, not a window: they rank what the notes
//   have been about since the first one.

function approvalBuckets(
  input: Pick<ComputeAnalyticsInput, 'now' | 'timeZone' | 'jobs' | 'period'>,
): AnalyticsApprovalBucket[] {
  const { now, timeZone, jobs } = input;
  const period = inputPeriod(input);
  const starts = bucketStartsEnding(now, timeZone, period, ANALYTICS_SIZES[period].approval);
  const firstTime = starts.map(() => 0);
  const approved = starts.map(() => 0);
  const rounds = starts.map((): number[] => []);
  for (const job of jobs) {
    const approvedAt = msOf(job.approvedAt);
    if (approvedAt === null) continue;
    const bucket = bucketIndexOf(approvedAt, timeZone, period, starts);
    if (bucket < 0) continue;
    approved[bucket] = (approved[bucket] ?? 0) + 1;
    rounds[bucket]?.push(job.round);
    // Round 0: the job went from the edit to the approval without a note being sent.
    if (job.round === 0) firstTime[bucket] = (firstTime[bucket] ?? 0) + 1;
  }
  return starts.map((start, i) => {
    const jobsApproved = approved[i] ?? 0;
    const jobsFirstTime = firstTime[i] ?? 0;
    return {
      start,
      share: jobsApproved === 0 ? null : jobsFirstTime / jobsApproved,
      firstTime: jobsFirstTime,
      approved: jobsApproved,
      medianReruns: median(rounds[i] ?? []),
    };
  });
}

/** A topic as the page says it: the pass's words, with the space around them trimmed. */
function topicOf(noteTopics: Readonly<Record<string, string>>, noteId: string): string | null {
  // `hasOwn`: a note id is never looked up on the prototype of a plain object.
  if (!Object.hasOwn(noteTopics, noteId)) return null;
  const topic = noteTopics[noteId]?.trim() ?? '';
  return topic === '' ? null : topic;
}

/** Biggest count first; the same count in the order of the words, so the answer never depends on the order of the input. */
function ranked<T>(items: T[], count: (item: T) => number, name: (item: T) => string): T[] {
  return items.sort((a, b) => {
    if (count(a) !== count(b)) return count(b) - count(a);
    const [x, y] = [name(a), name(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

function noteSection({
  timeZone,
  jobs,
  sentNotes,
  noteTopics,
}: Pick<ComputeAnalyticsInput, 'timeZone' | 'jobs' | 'sentNotes' | 'noteTopics'>): Pick<
  AnalyticsReviews,
  'noteTopics' | 'notGroupedYet' | 'notesSince'
> {
  const clientOfJob = new Map(jobs.map((job) => [job.id, job.client]));
  /** topic -> client (or '' when the note's job is not known) -> sent notes */
  const byTopic = new Map<string, Map<string, number>>();
  let notGroupedYet = 0;
  let oldestSent: number | null = null;

  for (const note of sentNotes) {
    // `NoteRepository.listAllSent` has only sent notes; a draft handed in anyway is not a note yet.
    if (note.sentAt === null) continue;
    const sentAt = msOf(note.sentAt);
    if (sentAt !== null && (oldestSent === null || sentAt < oldestSent)) oldestSent = sentAt;

    const topic = topicOf(noteTopics, note.id);
    if (topic === null) {
      notGroupedYet += 1;
      continue;
    }
    const clients = byTopic.get(topic) ?? new Map<string, number>();
    const client = clientOfJob.get(note.jobId) ?? '';
    clients.set(client, (clients.get(client) ?? 0) + 1);
    byTopic.set(topic, clients);
  }

  const topics: AnalyticsNoteTopic[] = [...byTopic].map(([topic, clients]) => ({
    topic,
    count: [...clients.values()].reduce((sum, n) => sum + n, 0),
    // A note whose job is gone still counts for its topic; it has no client to name.
    clients: ranked(
      [...clients]
        .filter(([client]) => client !== '')
        .map(([client, count]) => ({ client, count })),
      (entry) => entry.count,
      (entry) => entry.client,
    ),
  }));

  return {
    noteTopics: ranked(
      topics,
      (entry) => entry.count,
      (entry) => entry.topic,
    ),
    notGroupedYet,
    notesSince: oldestSent === null ? null : localDayOf(oldestSent, timeZone),
  };
}

export function computeReviewsSection(input: ComputeAnalyticsInput): AnalyticsReviews {
  return {
    approvedFirstTime: approvalBuckets(input),
    ...noteSection(input),
  };
}
