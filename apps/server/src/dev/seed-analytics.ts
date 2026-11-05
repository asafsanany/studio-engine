// Dev fixture for the Analytics page (CVP-251): about forty finished jobs over 13 weeks with every
// record the page reads, so `pnpm seed:canvas --analytics` shows it the way the design canvas's
// ANPage board draws it, without waiting for weeks of real work. It is what `seed-canvas.ts` plugs
// in with `--analytics`; nothing in apps/ imports it.
//
// What it writes, for the clock it is given (everything is relative to "now", so the page looks the
// same on any day; the same call gives the same data):
//
//   jobs, step_runs   about 40 finished jobs of six clients, 2 to 5 a week and more of them lately.
//                     Every job has its eight steps timed and ended: queue wait, the seven edit
//                     steps, a revise run per round of notes, the wait for the owner, then the render.
//                     Old jobs were slower, and Cut is the slowest step.
//   review_notes      the notes of each revised round, sent, in English and Hebrew
//   note-topics.json  a topic for every note but the last three (those are "not grouped yet")
//   deliveries        most jobs delivered a day later, older ones paid
//   usage.jsonl       Client work lines (per job, from 10 weeks ago on: older app runs did not log),
//                     and the sessions' lines in the other three groups, so each of the last 8 weeks
//                     splits close to the board's 18% down to 13% client work; in the last three weeks
//                     the sessions' lines fall on every day from Sunday to Friday, so the page's
//                     Week period has a bar for each of its days
//                     The app's runs of the last day and a half too (about $50 on the newest jobs), for
//                     the API credits card
//   limits.jsonl      weekly readings of the last 8 limit windows; one of them hit the limit. The
//                     last 14 days also have a reading or two a day (none on Saturdays) with a
//                     five-hour use, one day at 100%, for Busiest day in the Week period
//
// Times are on the machine's calendar (weeks start on Sunday, work happens Sunday to Thursday), the
// calendar the engine's Analytics route uses too.

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type InputCounts,
  type LimitSnapshot,
  type ModelUsage,
  priceOf,
  type StepId,
  type UsageEntry,
  type UsageTag,
} from '@studio/shared';
import type { StudioDb } from '../db/index.js';
import { type StoredJob, storedToColumns } from '../db/mapping.js';
import { deliveries, jobs, reviewNotes, stepRuns } from '../db/schema.js';
import { clientIdFor, jobIdFor } from '../inbox/scan.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MB = 1_000_000;
const GB = 1_000_000_000;

/** The oldest of the 13 weeks the calendar shows is this many weeks before this one. */
const WEEKS_BACK = 12;
/** App runs logged no usage before this many weeks ago (the log began later than the work). */
const FIRST_LOGGED_WEEK = 9;

// --- a small deterministic random number generator (mulberry32) ---------------------------------

type Random = () => number;

function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (random: Random, low: number, high: number): number =>
  low + random() * (high - low);

function pick<T>(random: Random, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

function shuffled<T>(random: Random, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

// --- the cast -----------------------------------------------------------------------------------

/** The clients of the board (ANPage, the notes card), and the videos they ask for. */
const CLIENT_JOBS: readonly { client: string; names: readonly string[]; vertical: boolean }[] = [
  {
    client: 'Kova Coffee',
    vertical: true,
    names: [
      'Spring menu launch',
      'Latte art reel',
      'Barista tips',
      'New blend teaser',
      'Winter specials',
      'Loyalty card promo',
      'Cold brew season',
      'Meet the roaster',
    ],
  },
  {
    client: 'Arc Fitness',
    vertical: true,
    names: [
      'Class schedule',
      'Coach intro reel',
      'Studio tour',
      'Member story',
      'Summer challenge',
      'Trainer spotlight',
      'New classes',
      'Open week',
    ],
  },
  {
    client: 'Lumen Yoga',
    vertical: true,
    names: [
      'Morning flow',
      'Breathing basics',
      'Workshop promo',
      'Teacher spotlight',
      'Beginner series',
      'Retreat teaser',
      'Evening stretch',
      'Studio opening',
    ],
  },
  {
    client: 'Noa Ceramics',
    vertical: false,
    names: [
      'Glaze process',
      'Wheel throwing',
      'Studio open day',
      'Autumn collection',
      'Kiln day',
      'Workshop recap',
      'Gift sets',
      'Behind the pottery',
    ],
  },
  {
    client: 'North Bakery',
    vertical: true,
    names: [
      'Weekend promo',
      'Morning pastries',
      'Fresh bread',
      'Holiday cakes',
      'Behind the scenes',
      'Weekly deal',
      'Bakery tour',
      'Family recipe',
    ],
  },
  {
    client: 'Mira Clinic',
    vertical: true,
    names: [
      'Whitening tips',
      'Patient testimonial',
      'First consultation',
      'Teeth cleaning',
      'Meet the team',
      'Common questions',
      'Care for kids',
      'Before and after',
    ],
  },
];

/** What the review notes are about, with how often (the board's counts), and how they are said. */
const TOPICS: readonly { topic: string; weight: number; texts: readonly string[] }[] = [
  {
    topic: 'intro too long',
    weight: 8,
    texts: [
      'The intro is too long, get to the point faster',
      'Cut the first five seconds, it drags',
      'Shorter intro please',
    ],
  },
  {
    topic: 'captions too small',
    weight: 7,
    texts: ['Captions are too small on the phone', 'Make the subtitles bigger'],
  },
  {
    topic: 'logo late',
    weight: 4,
    texts: ['Show the logo at the start, not at the end', 'The logo comes in too late'],
  },
  {
    topic: 'music too loud',
    weight: 4,
    texts: ['The music is too loud over the voice', 'The music is too loud'],
  },
  {
    topic: 'pause before CTA',
    weight: 3,
    texts: ['Add a short pause before the call to action'],
  },
  { topic: 'wrong take', weight: 3, texts: ['Wrong take in the middle, use the second one'] },
  {
    topic: 'colour too warm',
    weight: 3,
    texts: ['The colours look too warm', 'Cooler grade please'],
  },
  {
    topic: 'subtitle typo',
    weight: 2,
    texts: ['Typo in the subtitle at 0:12', 'Spelling mistake in a caption'],
  },
  { topic: 'end card missing', weight: 2, texts: ['Add the end card with the phone number'] },
  { topic: 'too many zooms', weight: 2, texts: ['Too many zooms, calm it down'] },
  { topic: 'b-roll repeats', weight: 2, texts: ['The same b-roll shows twice'] },
  { topic: 'volume dip', weight: 2, texts: ['The volume drops in the middle of a sentence'] },
];

/**
 * The plan for each week, oldest (12 weeks ago) to this one: how many jobs finished and how many
 * of them the owner approved first time. The first-time share climbs from 50% to about 80%, and the
 * work picks up, as the board's numbers do.
 */
const WEEK_PLAN: readonly { jobs: number; firstTime: number }[] = [
  { jobs: 2, firstTime: 1 },
  { jobs: 2, firstTime: 1 },
  { jobs: 2, firstTime: 1 },
  { jobs: 2, firstTime: 1 },
  { jobs: 3, firstTime: 2 },
  { jobs: 3, firstTime: 2 },
  { jobs: 3, firstTime: 2 },
  { jobs: 3, firstTime: 2 },
  { jobs: 4, firstTime: 3 },
  { jobs: 4, firstTime: 3 },
  { jobs: 4, firstTime: 3 },
  { jobs: 5, firstTime: 4 },
  { jobs: 4, firstTime: 3 },
];

/** The target share of Client work in each of the last 8 weeks (the board: 18% down to 13%). */
const CLIENT_SHARE_TARGET: readonly number[] = [0.18, 0.17, 0.15, 0.15, 0.16, 0.15, 0.13, 0.13];

/** The editor's seven steps, Brief to Check, in minutes for a job of today (Cut is the slowest). */
const EDIT_MINUTES: readonly number[] = [2, 3, 4, 6, 16, 13, 8];
/** The revise run's steps, Plan to Check. */
const REVISE_MINUTES: readonly number[] = [3, 8, 6, 5];

// --- the shapes this file builds ----------------------------------------------------------------

interface SeedRun {
  step: StepId;
  runKind: 'edit' | 'revise' | 'render';
  startedAt: number;
  endedAt: number;
}

interface SeedNote {
  id: string;
  jobId: string;
  round: number;
  text: string;
  topic: string;
  atSec: number;
  createdAt: number;
  sentAt: number;
}

interface SeedJob {
  id: string;
  client: string;
  name: string;
  weeksAgo: number;
  vertical: boolean;
  addedAt: number;
  startedAt: number;
  approvedAt: number;
  finishedAt: number;
  round: number;
  footageSec: number;
  durationSec: number;
  inputs: InputCounts;
  sizeBytes: number;
  reviewSec: number;
  runs: SeedRun[];
  notes: SeedNote[];
  delivery: { deliveredAt: number; paidOn: string | null } | null;
  archivedAt: number | null;
}

/** Everything `writeAnalyticsSeed` puts into a data folder and its database. */
export interface AnalyticsSeed {
  jobs: SeedJob[];
  /** The usage lines, oldest first. */
  usage: UsageEntry[];
  /** The limit readings, oldest first. */
  limits: LimitSnapshot[];
  /** A note's topic, by note id. Notes of the last days are not in it. */
  topics: Record<string, string>;
  /** The exports of the jobs, as `Client/Job.mp4`. */
  exports: string[];
}

// --- the calendar -------------------------------------------------------------------------------

/** Local midnight of the Sunday that starts the week `now` is in. */
function sundayOf(now: number): Date {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - date.getDay());
  return date;
}

/** A moment on the machine's calendar: `weeksAgo` weeks before this one, on weekday 0 (Sunday) to 6. */
function localMoment(
  sunday: Date,
  weeksAgo: number,
  weekday: number,
  hour: number,
  minute: number,
) {
  return new Date(
    sunday.getFullYear(),
    sunday.getMonth(),
    sunday.getDate() - weeksAgo * 7 + weekday,
    hour,
    minute,
  ).getTime();
}

// --- tokens for a price -------------------------------------------------------------------------

/**
 * How a usage line spends: the share of its API value in each kind of token. Claude Code mostly
 * reads cached context, so cache reads and writes carry most of it.
 */
const SPEND_MIX = { input: 0.08, output: 0.26, cacheRead: 0.38, cacheWrite: 0.28 } as const;

/** Tokens of `model` that are worth `usd` at API list prices, spent as `SPEND_MIX` says. */
function usageWorth(model: string, usd: number): Record<string, ModelUsage> {
  const price = priceOf(model);
  if (price === null) throw new Error(`The seed needs a price for ${model}.`);
  const tokens = (share: number, perMillion: number): number =>
    Math.round(((usd * share) / perMillion) * 1_000_000);
  const usage: ModelUsage = {
    requests: Math.max(1, Math.round(usd * 4)),
    input: tokens(SPEND_MIX.input, price.input),
    output: tokens(SPEND_MIX.output, price.output),
    cacheRead: tokens(SPEND_MIX.cacheRead, price.cacheRead),
    cacheWrite: tokens(SPEND_MIX.cacheWrite, price.cacheWrite),
  };
  return { [model]: usage };
}

// --- the jobs -----------------------------------------------------------------------------------

/**
 * Seconds a step takes on a job `weeksAgo` weeks back: today's minutes, slower the older the job
 * (up to 45% more twelve weeks ago), and a little different every time.
 */
function stepSeconds(random: Random, minutes: number, weeksAgo: number): number {
  const slower = 1 + (weeksAgo / WEEKS_BACK) * 0.45;
  return Math.round(minutes * 60 * slower * between(random, 0.75, 1.25));
}

/** Plays steps one after the other from `from`, with a few seconds between them; returns the runs. */
function playSteps(
  random: Random,
  from: number,
  steps: readonly { step: StepId; seconds: number }[],
  runKind: SeedRun['runKind'],
): SeedRun[] {
  const runs: SeedRun[] = [];
  let at = from;
  for (const { step, seconds } of steps) {
    const endedAt = at + seconds * 1000;
    runs.push({ step, runKind, startedAt: at, endedAt });
    at = endedAt + Math.round(between(random, 4, 20)) * 1000;
  }
  return runs;
}

const lastEnd = (runs: readonly SeedRun[]): number => runs[runs.length - 1]?.endedAt ?? 0;

/** The wait for the owner after a preview is ready: usually an hour or two, now and then most of a day. */
function waitForOwner(random: Random, weeksAgo: number): number {
  if (random() < 0.03) return Math.round(between(random, 8, 12) * HOUR);
  // An hour and a half, from half as long again twelve weeks ago, give or take a fifth.
  const slower = 1 + (weeksAgo / WEEKS_BACK) * 0.8;
  return Math.round(95 * MIN * slower * between(random, 0.8, 1.2));
}

interface JobShape {
  client: (typeof CLIENT_JOBS)[number];
  name: string;
  weeksAgo: number;
  firstTime: boolean;
  /** Where its finish falls: a weekday 0 to 4 (Sunday to Thursday) and an hour of the day. */
  weekday: number;
  hour: number;
}

/** Who gets which job in which week, with first-time approvals spread through each week. */
function shapeJobs(random: Random, now: number): JobShape[] {
  // Clients take turns in a shuffled order, so every client works in every month.
  const turns = shuffled(
    random,
    CLIENT_JOBS.flatMap((client) => [client, client, client, client, client, client, client]),
  );
  const nextName = new Map<string, number>();
  const shapes: JobShape[] = [];
  let turn = 0;
  WEEK_PLAN.forEach((plan, index) => {
    const weeksAgo = WEEKS_BACK - index;
    const firstTimeFlags = shuffled(
      random,
      Array.from({ length: plan.jobs }, (_, i) => i < plan.firstTime),
    );
    // Sunday to Thursday, no two jobs of a week on the same day when it can be helped.
    const days = shuffled(random, [0, 1, 2, 3, 4]);
    for (let i = 0; i < plan.jobs; i += 1) {
      const client = turns[turn++ % turns.length] as (typeof CLIENT_JOBS)[number];
      const used = nextName.get(client.client) ?? 0;
      nextName.set(client.client, used + 1);
      const name = client.names[used % client.names.length] as string;
      let weekday = days[i % days.length] as number;
      // This week: only days that are over, and today only when the morning is.
      if (weeksAgo === 0) {
        const today = new Date(now).getDay();
        weekday = Math.min(weekday, Math.max(0, Math.min(today - 1, 4)));
      }
      shapes.push({
        client,
        name,
        weeksAgo,
        firstTime: firstTimeFlags[i] as boolean,
        weekday,
        hour: Math.round(between(random, 12, 20)),
      });
    }
  });
  return shapes;
}

function buildJob(
  random: Random,
  now: number,
  sunday: Date,
  shape: JobShape,
  footageScale: number,
): SeedJob {
  const { client, name, weeksAgo, firstTime } = shape;
  const rounds = firstTime ? 0 : random() < 0.2 ? 2 : 1;

  // The timeline, from the moment the job is added, in order; moved afterwards to land where the
  // plan says it finishes.
  const queueWait = Math.round(between(random, 2, 6) * (1 + weeksAgo / WEEKS_BACK) * MIN);
  const editRuns = playSteps(
    random,
    queueWait,
    EDIT_MINUTES.map((minutes, i) => ({
      step: (i + 1) as StepId,
      seconds: stepSeconds(random, minutes, weeksAgo),
    })),
    'edit',
  );
  const runs: SeedRun[] = [...editRuns];
  const notes: { round: number; sentAt: number }[] = [];
  let checkEnd = lastEnd(editRuns);
  for (let round = 1; round <= rounds; round += 1) {
    const sentAt = checkEnd + Math.round(between(random, 10, 70) * MIN);
    notes.push({ round, sentAt });
    const reviseRuns = playSteps(
      random,
      sentAt + Math.round(between(random, 30, 70)) * 1000,
      REVISE_MINUTES.map((minutes, i) => ({
        step: (i + 4) as StepId,
        seconds: stepSeconds(random, minutes, weeksAgo),
      })),
      'revise',
    );
    runs.push(...reviseRuns);
    checkEnd = lastEnd(reviseRuns);
  }
  const approvedAt = checkEnd + waitForOwner(random, weeksAgo);
  const render = playSteps(
    random,
    approvedAt + Math.round(between(random, 20, 60)) * 1000,
    [{ step: 8, seconds: Math.round(between(random, 3, 5) * 60) }],
    'render',
  );
  runs.push(...render);
  const finishedAt = lastEnd(render) + Math.round(between(random, 5, 15)) * 1000;

  // Move it so that it finishes where the plan puts it, and never in the future.
  const target = Math.min(
    localMoment(sunday, weeksAgo, shape.weekday, shape.hour, Math.round(between(random, 0, 59))),
    now - 2 * HOUR,
  );
  const shift = target - finishedAt;
  const moved = (at: number): number => at + shift;

  const durationSec = Math.round(between(random, 28, 95));
  const videoCount = Math.round(between(random, 4, 15));
  const id = jobIdFor(`${client.client}/${name}`);
  const seedNotes: SeedNote[] = notes
    .map(({ round, sentAt }) => ({ round, sentAt: moved(sentAt) }))
    .flatMap(({ round, sentAt }) => {
      // Mostly two or three notes in a round, one now and then.
      const roll = random();
      const count = roll < 0.15 ? 1 : roll < 0.65 ? 2 : 3;
      return Array.from({ length: count }, (_, k) => ({
        id: randomUUID(),
        jobId: id,
        round,
        text: '',
        topic: '',
        atSec: Math.round(between(random, 2, durationSec - 2) * 10) / 10,
        createdAt: sentAt - Math.round(between(random, 2, 9) * MIN) + k * 20_000,
        sentAt,
      }));
    });

  return {
    id,
    client: client.client,
    name,
    weeksAgo,
    vertical: client.vertical,
    addedAt: moved(0),
    startedAt: moved(queueWait),
    approvedAt: moved(approvedAt),
    finishedAt: moved(finishedAt),
    round: rounds,
    // More footage in newer jobs, so footage per week roughly doubles (about 25 min a job to 50).
    footageSec: Math.round(between(random, 18, 32) * 60 * footageScale),
    durationSec,
    inputs: {
      video: videoCount,
      audio: random() < 0.5 ? Math.round(between(random, 1, 3)) : 0,
      image: random() < 0.6 ? Math.round(between(random, 1, 6)) : 0,
      doc: random() < 0.3 ? 1 : 0,
    },
    sizeBytes: Math.round(between(random, 0.5, 3.6) * GB),
    reviewSec: Math.round(between(random, 90, 480)),
    runs: runs.map((run) => ({
      ...run,
      startedAt: moved(run.startedAt),
      endedAt: moved(run.endedAt),
    })),
    notes: seedNotes,
    delivery: null,
    archivedAt: null,
  };
}

// --- notes, topics ------------------------------------------------------------------------------

/** Puts a topic and its words on every note, and returns the topic of each note by id. */
function writeNotes(random: Random, all: SeedJob[]): Record<string, string> {
  const pool = shuffled(
    random,
    TOPICS.flatMap(({ topic, weight }) => Array.from({ length: weight }, () => topic)),
  );
  const hebrew = (client: string): boolean => /[֐-׿]/.test(client);
  const notes = all.flatMap((job) => job.notes.map((note) => ({ job, note })));
  notes.sort((a, b) => a.note.sentAt - b.note.sentAt);
  let next = 0;
  for (const { job, note } of notes) {
    const topic = pool[next++ % pool.length] as string;
    const texts = (TOPICS.find((candidate) => candidate.topic === topic)?.texts ?? []).filter(
      (text) => hebrew(job.client) === /[֐-׿]/.test(text),
    );
    const any = TOPICS.find((candidate) => candidate.topic === topic)?.texts ?? [];
    note.topic = topic;
    note.text = pick(random, texts.length > 0 ? texts : any);
  }
  // The three newest notes came in after the last topic pass: they are "not grouped yet".
  const topics: Record<string, string> = {};
  for (const { note } of notes.slice(0, Math.max(0, notes.length - 3)))
    topics[note.id] = note.topic;
  return topics;
}

// --- deliveries ---------------------------------------------------------------------------------

/** Marks most jobs delivered a day after they finished, and the older ones paid. */
function writeDeliveries(random: Random, now: number, all: SeedJob[]): void {
  for (const job of all) {
    const deliveredAt = job.finishedAt + Math.round(between(random, 1, 30) * HOUR);
    if (random() < 0.12 || deliveredAt > now - 5 * MIN) continue;
    let paidOn: string | null = null;
    const paidAt = deliveredAt + Math.round(between(random, 3, 21) * DAY);
    if (paidAt < now - DAY && random() < 0.85) {
      const day = new Date(paidAt);
      paidOn = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    }
    job.delivery = { deliveredAt, paidOn };
    // Paid and a month old: put away.
    if (paidOn !== null && job.finishedAt < now - 30 * DAY)
      job.archivedAt = job.delivery.deliveredAt + 2 * DAY;
  }
}

// --- usage --------------------------------------------------------------------------------------

const APP_MODEL = 'claude-sonnet-5-5';
const SESSION_MODEL = 'claude-opus-5-5';

interface ClientUsage {
  entries: UsageEntry[];
  /** API value of each entry, in the order of `entries`. */
  usd: number[];
}

/**
 * Client work: the runs of every job from `FIRST_LOGGED_WEEK` on: its edit run when it reached
 * Check, a revise run per round, the render, and the look learned from the first job of a client.
 * Older jobs cost more (the editor needed more passes), so API value per finished minute falls.
 */
function clientWorkUsage(random: Random, all: SeedJob[]): ClientUsage {
  const entries: UsageEntry[] = [];
  const usd: number[] = [];
  const seen = new Set<string>();
  const add = (
    job: SeedJob,
    tag: UsageTag,
    did: string,
    at: number,
    from: number,
    value: number,
  ): void => {
    entries.push({
      at: new Date(at).toISOString(),
      from: new Date(from).toISOString(),
      source: 'app',
      tag,
      did,
      session: `app-${job.id}-${tag}-${entries.length}`,
      client: job.client,
      job: { id: job.id, name: job.name },
      usage: usageWorth(APP_MODEL, value),
    });
    usd.push(value);
  };
  for (const job of all) {
    if (job.weeksAgo > FIRST_LOGGED_WEEK) continue;
    // What the job's runs cost together: so many dollars a finished minute, more for older jobs
    // (the editor needed more passes then). The edit is most of it, a revise run a third, the
    // render a tenth.
    const total =
      4.6 *
      (1 + (job.weeksAgo / FIRST_LOGGED_WEEK) * 0.42) *
      (job.durationSec / 60) *
      between(random, 0.92, 1.08);
    const unit = total / (1 + 0.35 * job.round + 0.1);
    const edit = job.runs.filter((run) => run.runKind === 'edit');
    add(job, 'edit', `Edited ${job.name}`, lastEnd(edit), job.startedAt, unit);
    for (let round = 1; round <= job.round; round += 1) {
      const revise = job.runs.filter((run) => run.runKind === 'revise');
      const own = revise.slice((round - 1) * REVISE_MINUTES.length, round * REVISE_MINUTES.length);
      add(
        job,
        'revise',
        `Revised ${job.name} (round ${round})`,
        lastEnd(own),
        own[0]?.startedAt ?? job.startedAt,
        unit * 0.35,
      );
    }
    const render = job.runs.filter((run) => run.runKind === 'render');
    add(
      job,
      'render',
      `Rendered ${job.name}`,
      lastEnd(render),
      render[0]?.startedAt ?? 0,
      unit * 0.1,
    );
    if (!seen.has(job.client)) {
      seen.add(job.client);
      add(
        job,
        'style-learn',
        `Learned the look of ${job.client} from ${job.name}`,
        job.finishedAt + 2 * MIN,
        job.finishedAt,
        between(random, 0.5, 0.9),
      );
    }
  }
  const order = entries
    .map((_, i) => i)
    .sort((a, b) => Date.parse(entries[a]?.at ?? '') - Date.parse(entries[b]?.at ?? ''));
  return {
    entries: order.map((i) => entries[i] as UsageEntry),
    usd: order.map((i) => usd[i] as number),
  };
}

interface SessionKind {
  tag: UsageTag;
  did: readonly string[];
  /** Its part of what is left over after Client work in the week. */
  part: number;
  /** How many lines a week. */
  perWeek: number;
}

/** The three groups that are not Client work, as sessions log them. */
const SESSION_KINDS: readonly SessionKind[] = [
  {
    tag: 'development',
    did: [
      'Built the Jobs table filters',
      'Fixed the Money page rounding',
      'Wired the job sheet to the steps route',
      'Added the archive switch',
    ],
    part: 0.5,
    perWeek: 3,
  },
  {
    tag: 'qa',
    did: ['Acceptance run of Review', 'Design QA of the Clients page'],
    part: 0.14,
    perWeek: 1,
  },
  {
    tag: 'planning',
    did: ['Planned the Analytics items in Plane', 'Wrote the Series plan page'],
    part: 0.1,
    perWeek: 1,
  },
  { tag: 'orchestration', did: ['Checked and merged three items'], part: 0.07, perWeek: 1 },
  {
    tag: 'design',
    did: ['Drew the options for the Money cards', 'Redrew the Jobs table as a quiet list'],
    part: 0.15,
    perWeek: 2,
  },
  { tag: 'research', did: ['Looked up the Tailscale Serve flags'], part: 0.02, perWeek: 1 },
  { tag: 'personal', did: ['A question about a recipe'], part: 0.02, perWeek: 1 },
];

/**
 * The sessions' lines for the last 8 weeks, sized so that Client work comes to the board's share
 * of the week (`CLIENT_SHARE_TARGET`): what the week's Client work lines are worth is divided by
 * the share to get the whole week, and the rest is spread over the other groups.
 */
function sessionUsage(
  random: Random,
  now: number,
  sunday: Date,
  clientUsd: ClientUsage,
): UsageEntry[] {
  const entries: UsageEntry[] = [];
  const lastAt = new Map<string, string>();
  const weeks = CLIENT_SHARE_TARGET.length;
  const today = new Date(now).getDay();
  for (let index = 0; index < weeks; index += 1) {
    const weeksAgo = weeks - 1 - index;
    // The Week period draws the last 14 days, which reach back into the third week: in the last
    // three weeks the lines take the days of the week in turn (Sunday to Friday, this week up to
    // today), so no workday is empty. The other
    // weeks keep the random day. The week a line is in does not change, so the weeks add up as before.
    const days = weeksAgo === 0 ? today + 1 : weeksAgo <= 2 ? 6 : 0;
    let line = 0;
    const from = localMoment(sunday, weeksAgo, 0, 0, 0);
    const to = from + 7 * DAY;
    const client = clientUsd.entries.reduce((sum, entry, i) => {
      const at = Date.parse(entry.at);
      return at >= from && at < to ? sum + (clientUsd.usd[i] ?? 0) : sum;
    }, 0);
    const total = client / (CLIENT_SHARE_TARGET[index] as number);
    const rest = total - client;
    for (const kind of SESSION_KINDS) {
      for (let k = 0; k < kind.perWeek; k += 1) {
        const value = ((rest * kind.part) / kind.perWeek) * between(random, 0.8, 1.2);
        const randomDay = Math.floor(between(random, 0, 5));
        const weekday = days > 0 ? line++ % days : randomDay;
        const at = Math.min(
          localMoment(
            sunday,
            weeksAgo,
            weekday,
            Math.round(between(random, 9, 22)),
            Math.round(between(random, 0, 59)),
          ),
          now - 20 * MIN,
        );
        const session = `session-${kind.tag}-${weeksAgo}-${k}`;
        entries.push({
          at: new Date(at).toISOString(),
          from: lastAt.get(session) ?? null,
          source: 'session',
          tag: kind.tag,
          did: pick(random, kind.did),
          session,
          usage: usageWorth(SESSION_MODEL, value),
        });
        lastAt.set(session, new Date(at).toISOString());
      }
    }
  }
  return entries;
}

/**
 * The app's runs of the last day and a half, billed to the API key (the credits card): a few
 * revise runs on the three newest jobs, one first edit, a graphic and a topic pass, worth about
 * $50 together. They sit on jobs the seed already has, so their names show in "what the API
 * credits paid for". Relative to `now`, so the card has a month-to-date on any day (a run from
 * before the credit month began is simply not counted).
 */
function recentCreditUsage(now: number, all: SeedJob[]): UsageEntry[] {
  const newest = all.slice(-3).reverse();
  const runs: { job: number; tag: UsageTag; did: string; hoursAgo: number; usd: number }[] = [
    { job: 0, tag: 'revise', did: 'Re-edit after notes', hoursAgo: 30, usd: 6.4 },
    { job: 0, tag: 'revise', did: 'Re-edit after notes', hoursAgo: 20, usd: 6.1 },
    { job: 0, tag: 'revise', did: 'Re-edit after notes', hoursAgo: 9, usd: 5.2 },
    { job: 1, tag: 'revise', did: 'Re-edit after notes', hoursAgo: 28, usd: 6.6 },
    { job: 1, tag: 'revise', did: 'Re-edit after notes', hoursAgo: 14, usd: 7.0 },
    { job: 1, tag: 'revise', did: 'Re-edit after notes', hoursAgo: 4, usd: 6.2 },
    { job: 2, tag: 'edit', did: 'First edit', hoursAgo: 32, usd: 11.8 },
    { job: 0, tag: 'graphic', did: 'Made a title graphic', hoursAgo: 12, usd: 1.15 },
    { job: 2, tag: 'note-topics', did: 'Grouped review notes', hoursAgo: 6, usd: 0.06 },
  ];
  return runs.flatMap((run, i) => {
    const job = newest[run.job];
    if (job === undefined) return [];
    const at = now - run.hoursAgo * HOUR;
    return [
      {
        at: new Date(at).toISOString(),
        from: new Date(at - 10 * MIN).toISOString(),
        source: 'app' as const,
        tag: run.tag,
        did: run.did,
        session: `app-recent-${job.id}-${run.tag}-${i}`,
        client: job.client,
        job: { id: job.id, name: job.name },
        usage: usageWorth(APP_MODEL, run.usd),
      },
    ];
  });
}

// --- limits -------------------------------------------------------------------------------------

/** The week's peak use of the limit, oldest of the 8 windows first; the third one hit it. */
const WEEKLY_PEAKS: readonly number[] = [0.31, 0.44, 1, 0.52, 0.61, 0.47, 0.58, 0.38];

/**
 * Readings of the weekly (and five-hour) limit, three per window, for the last 8 windows. The
 * weekly limit resets on Saturdays at 18:00 UTC, as the real one does; the newest window ends at
 * the next reset. The week of the third window ends with Claude saying no (`rejected`).
 */
function limitReadings(random: Random, now: number): LimitSnapshot[] {
  const reset = new Date(now);
  reset.setUTCHours(18, 0, 0, 0);
  reset.setUTCDate(reset.getUTCDate() + ((6 - reset.getUTCDay() + 7) % 7));
  if (reset.getTime() <= now) reset.setUTCDate(reset.getUTCDate() + 7);
  const newestEnd = reset.getTime();

  const readings: LimitSnapshot[] = [];
  WEEKLY_PEAKS.forEach((peak, index) => {
    const end = newestEnd - (WEEKLY_PEAKS.length - 1 - index) * 7 * DAY;
    const start = end - 7 * DAY;
    const current = index === WEEKLY_PEAKS.length - 1;
    const hit = peak >= 1;
    const span = current ? now - start - 5 * MIN : 6.5 * DAY;
    [0.3, 0.65, 1].forEach((fraction, k) => {
      const at = start + Math.round(span * fraction);
      const last = k === 2;
      const weekly = last ? peak : peak * fraction * between(random, 0.85, 1);
      readings.push({
        at: new Date(at).toISOString(),
        status: hit && last ? 'rejected' : 'allowed',
        fiveHour: {
          utilization: hit && last ? 1 : Math.round(between(random, 0.15, 0.9) * 100) / 100,
          resetsAt: new Date(at + Math.round(between(random, 1, 4.5) * HOUR)).toISOString(),
        },
        sevenDay: {
          utilization: Math.round(weekly * 100) / 100,
          resetsAt: new Date(end).toISOString(),
        },
      });
    });
  });
  return [...readings, ...dailyReadings(now, newestEnd)].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  );
}

/**
 * A reading or two on each of the last 14 days, for "Busiest day" in the Week period: work days
 * (Sunday to Thursday) at 10:30 and 17:30, a Friday at 12:00, no reading on a Saturday (a gap).
 * Each carries a five-hour use, and the weekly use of its window rising towards that window's
 * peak without passing it, so the weekly bars of the Month period stay as they are. One work day
 * five days back (or the first before that) reaches 100% of the five hours; its status stays
 * `allowed`, as the weekly windows count a refusal, and so it makes a red day and no red week.
 * Today has the readings that are over by now. Its own random numbers keep the rest of the seed
 * what it was.
 */
function dailyReadings(now: number, newestEnd: number): LimitSnapshot[] {
  const random = mulberry32(2026_10_23);
  const today = new Date(now);
  const readings: LimitSnapshot[] = [];
  let hitDay: number | null = null;
  for (let back = 5; back <= 13 && hitDay === null; back += 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    if (day.getDay() <= 4) hitDay = back;
  }
  for (let back = 13; back >= 0; back -= 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    if (day.getDay() === 6) continue;
    const times =
      day.getDay() === 5
        ? [[12, 0]]
        : [
            [10, 30],
            [17, 30],
          ];
    for (const [hour, minute] of times) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).getTime();
      if (at > now - 5 * MIN) continue;
      const hit = back === hitDay && hour === 17;
      const week = Math.floor((newestEnd - at) / (7 * DAY));
      const end = newestEnd - week * 7 * DAY;
      const peak = WEEKLY_PEAKS[WEEKLY_PEAKS.length - 1 - week] ?? 0.4;
      const reached = Math.min(1, (at - (end - 7 * DAY)) / (6.5 * DAY));
      readings.push({
        at: new Date(at).toISOString(),
        status: 'allowed',
        fiveHour: {
          utilization: hit ? 1 : Math.round(between(random, 0.12, 0.88) * 100) / 100,
          resetsAt: new Date(at + Math.round(between(random, 1, 4.5) * HOUR)).toISOString(),
        },
        sevenDay: {
          utilization: Math.round(Math.min(peak, peak * reached) * 100) / 100,
          resetsAt: new Date(end).toISOString(),
        },
      });
    }
  }
  return readings;
}

// --- the whole seed -----------------------------------------------------------------------------

/** Builds the seed for the moment `now` (milliseconds since the epoch). Pure: same `now`, same data. */
export function buildAnalyticsSeed(now: number): AnalyticsSeed {
  const random = mulberry32(2026_10_22);
  const sunday = sundayOf(now);
  const shapes = shapeJobs(random, now);

  const all = shapes.map((shape) => {
    // 0.9 twelve weeks ago to 1.8 now: about 25 minutes of footage a job, then 50.
    const footageScale = 0.9 + 0.9 * (1 - shape.weeksAgo / WEEKS_BACK);
    return buildJob(random, now, sunday, shape, footageScale);
  });
  all.sort((a, b) => a.finishedAt - b.finishedAt);

  const topics = writeNotes(random, all);
  writeDeliveries(random, now, all);

  const clientUsage = clientWorkUsage(random, all);
  const usage = [
    ...clientUsage.entries,
    ...recentCreditUsage(now, all),
    ...sessionUsage(random, now, sunday, clientUsage),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return {
    jobs: all,
    usage,
    limits: limitReadings(random, now),
    topics,
    exports: all.map((job) => `${job.client}/${job.name}.mp4`),
  };
}

function storedJob(job: SeedJob): StoredJob {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const width = job.vertical ? 1080 : 1920;
  const height = job.vertical ? 1920 : 1080;
  return {
    id: job.id,
    clientId: clientIdFor(job.client),
    client: job.client,
    name: job.name,
    relPath: `${job.client}/${job.name}`,
    state: 'ready',
    step: 8,
    subProgress: null,
    etaSec: null,
    placeInLine: null,
    settlesAt: null,
    failedAt: null,
    error: null,
    stoppedAt: null,
    inputs: job.inputs,
    sizeBytes: job.sizeBytes,
    addedAt: iso(job.addedAt),
    lastChangeAt: iso(job.finishedAt),
    settledAt: iso(job.addedAt + MIN),
    heldSettledAt: null,
    runKind: 'render',
    round: job.round,
    preview: { durationSec: job.durationSec, width, height },
    approvedAt: iso(job.approvedAt),
    delivery: null,
    effort: null,
    reviewEffort: null,
    reviseTier: null,
    fixing: null,
    fixedCount: 0,
    reviseMinutes: null,
    seriesId: null,
    episode: null,
    archivedAt: job.archivedAt === null ? null : iso(job.archivedAt),
    updatedAt: iso(job.finishedAt),
    output: {
      fileName: `${job.client}/${job.name}.mp4`,
      durationSec: job.durationSec,
      width,
      height,
      sizeBytes: Math.round((job.durationSec * 1.1 + 4) * MB),
    },
    note: null,
    footageSec: job.footageSec,
    startedAt: iso(job.startedAt),
    finishedAt: iso(job.finishedAt),
    attempt: 1,
    reviewSec: job.reviewSec,
    seriesPinned: false,
  };
}

/**
 * Writes the seed: the jobs, their timed steps, notes and deliveries into `db`, and
 * usage.jsonl, limits.jsonl and note-topics.json into `dataDir`, plus placeholder exports (16 KB
 * each, not real videos) into `exportsDir` so Download answers 200.
 */
export async function writeAnalyticsSeed(
  db: StudioDb,
  dataDir: string,
  exportsDir: string,
  seed: AnalyticsSeed,
): Promise<void> {
  for (const job of seed.jobs) {
    db.orm
      .insert(jobs)
      .values({ id: job.id, ...storedToColumns(storedJob(job)) })
      .run();
    // In the order they happened: the review round of a run is read off that order.
    for (const run of [...job.runs].sort((a, b) => a.startedAt - b.startedAt)) {
      db.orm
        .insert(stepRuns)
        .values({
          jobId: job.id,
          step: run.step,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          footageSeconds: job.footageSec,
          runKind: run.runKind,
        })
        .run();
    }
    for (const note of job.notes) {
      db.orm
        .insert(reviewNotes)
        .values({
          id: note.id,
          jobId: job.id,
          round: note.round,
          atSec: note.atSec,
          kind: 'text',
          text: note.text,
          audioFile: null,
          audioSec: null,
          transcriptStatus: null,
          addToStyle: false,
          addToSeries: false,
          createdAt: note.createdAt,
          sentAt: note.sentAt,
        })
        .run();
    }
    if (job.delivery !== null) {
      db.orm
        .insert(deliveries)
        .values({
          jobId: job.id,
          clientId: clientIdFor(job.client),
          client: job.client,
          name: job.name,
          relPath: `${job.client}/${job.name}`,
          deliveredAt: job.delivery.deliveredAt,
          price: 40,
          currency: 'ILS',
          reviewSec: job.reviewSec,
          paidOn: job.delivery.paidOn,
        })
        .run();
    }
  }

  const lines = (items: readonly unknown[]): string =>
    items
      .map((item) => JSON.stringify(item))
      .join('\n')
      .concat('\n');
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'usage.jsonl'), lines(seed.usage));
  await writeFile(join(dataDir, 'limits.jsonl'), lines(seed.limits));
  await writeFile(join(dataDir, 'note-topics.json'), JSON.stringify(seed.topics, null, 2));
  for (const name of seed.exports) {
    const path = join(exportsDir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.alloc(16_000));
  }
}
