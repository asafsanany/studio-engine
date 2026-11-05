// Dev fixture for Quick fixes' design QA (CVP-380): `pnpm seed:canvas --quick-fixes` seeds eleven jobs
// in Review, one for each state of the design canvas's boards QFStates and QFEffort (page "Quick
// fixes"), so Review shows every line, footer and button of the boards on the Mac and on the phone.
// The switch is forced on for this app only (`/api/health` says `quickFixes: true`), and the real
// fix service, note routing and routes run over the seed's database with the fake router and the
// fake quick fix (the e2e's), so a note typed in any of the jobs is read, fixed and undone for real.
//
//   "Try it here"          Auto, no notes: type a note and watch it go through (board 1 to 5)
//   "Reading the note"     a note whose sorting is pending (board 2)
//   "Fixing it now"        a fix running, at step 1 of 4 (board 3)
//   "Fixed"                a fix landed, with Undo and Compare (boards 4 and 5)
//   "Two in a row"         one fix running (step 2), the next waiting: "next in line" (board 6)
//   "A bigger round"       one fixed, a shot and the music waiting for Send (boards 7 and 12)
//   "Whole video"          a note about the pacing: the full tier (board 8)
//   "Couldn’t do it here"  an escalated fix: the sign is part of the footage (board 9)
//   "Undone"               an Undo was pressed (board 10)
//   "All fixed"            three fixed notes, one in Hebrew: Approve (board 11)
//   "Extra high picked"    a level instead of Auto: no line under the notes (board 13)
//
// Written through the repositories (notes, fixes) with the files the states need: a fixed fix has
// its before/ copy (what Undo puts back) and its before.png / after.png (Compare), and the job's
// edit/preview/ already carries the change the fake quick fix makes (it is what the fake does to
// the sample composition's #title rule). The sample composition is stretched to the boards' 0:39 so
// the notes' times (0:12, 0:21 …) are inside the video, and its title stays up the whole time, so a
// change to it shows at any playhead.
//
// The running and queued fixes are rows only: no run is behind them, so they stay as they are for as
// long as the seed runs. A note typed afterwards goes through the real queue. Dev-only: nothing in
// apps/ imports it but the seed.

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type FixStatus, type NoteRoute, TIER_RUNS } from '@studio/shared';
import { NoteRepository, QuickFixRepository, type StudioDb } from '../db/index.js';
import { fakeQuickFixChange, solidPng } from '../review/fake-quick-fix.js';
import {
  FIX_PREVIEW_PATH,
  FIX_PROJECT_PATH,
  FIX_REPLY_FILE,
  fixDirPath,
} from '../review/quick-fix-files.js';
import type { CanvasJobSpec } from './seed-canvas.js';

const GB = 1_000_000_000;

/** The jobs of the quick fixes seed, by what they show. */
export const QUICK_FIX_IDS = {
  fresh: 'qf-fresh',
  reading: 'qf-reading',
  fixing: 'qf-fixing',
  fixed: 'qf-fixed',
  queue: 'qf-queue',
  mixed: 'qf-mixed',
  full: 'qf-full',
  escalated: 'qf-escalated',
  undone: 'qf-undone',
  allFixed: 'qf-all-fixed',
  manual: 'qf-manual',
} as const;

const OFEK = 'Horizon FPV';

/** The words of the boards' notes. */
const FONT = 'Change the caption font to Heebo Bold';
const SWAP = 'Swap this shot for the drone shot from the beach';
const MUSIC = 'The music should come in at 0:05, not at the start';
const PACING = 'The middle drags. Tighten the pacing and cut on the beat';
const SIGN = 'Change the sign behind her to English';
const YELLOW_HE = 'תעשה את הכתוביות צהובות';
const YELLOW = 'Make the captions yellow';
const NO_TITLE = 'Remove the title';

/** The cut's length on the boards: the player says 0:39. */
const CUT_SEC = 39;

const preview = { durationSec: CUT_SEC, width: 1080, height: 1920 } as const;

function spec(
  id: string,
  name: string,
  minutesAgo: number,
  extra: Partial<CanvasJobSpec> = {},
): CanvasJobSpec {
  const added = Date.parse('2026-10-20T13:42:00.000Z') - (minutesAgo + 12) * 60_000;
  const updated = Date.parse('2026-10-20T13:42:00.000Z') - minutesAgo * 60_000;
  return {
    id,
    client: OFEK,
    name,
    state: 'review',
    inputs: [12, 0, 0, 0],
    sizeBytes: 2.6 * GB,
    addedAt: new Date(added).toISOString(),
    updatedAt: new Date(updated).toISOString(),
    step: 7,
    preview,
    sampleShape: 'portrait',
    ...extra,
  };
}

/** The jobs, newest first on the Jobs page (the order the boards walk through the states, top to bottom). */
export const QUICK_FIX_JOB_SPECS: readonly CanvasJobSpec[] = [
  spec(QUICK_FIX_IDS.fresh, 'Try it here', 1),
  spec(QUICK_FIX_IDS.reading, 'Reading the note', 2),
  spec(QUICK_FIX_IDS.fixing, 'Fixing it now', 3),
  spec(QUICK_FIX_IDS.fixed, 'Fixed', 4),
  spec(QUICK_FIX_IDS.queue, 'Two in a row', 5),
  spec(QUICK_FIX_IDS.mixed, 'A bigger round', 6),
  spec(QUICK_FIX_IDS.full, 'Whole video', 7),
  spec(QUICK_FIX_IDS.escalated, 'Couldn’t do it here', 8),
  spec(QUICK_FIX_IDS.undone, 'Undone', 9),
  spec(QUICK_FIX_IDS.allFixed, 'All fixed', 10),
  spec(QUICK_FIX_IDS.manual, 'Extra high picked', 11, { reviewEffort: 'xhigh' }),
];

// --- the notes and their fixes -----------------------------------------------------------------------

/** What Auto's router answered for a note, in the fake router's words. */
const QUICK = (kind: string): NoteRoute => ({ tier: 'quick', kind, why: '' });
const CUT_ROUTE: NoteRoute = {
  tier: 'revise',
  kind: 'Changing the cut',
  why: 'it changes the cut',
};
const MUSIC_ROUTE: NoteRoute = {
  tier: 'revise',
  kind: 'Changing the music',
  why: 'it changes the music',
};
const FULL_ROUTE: NoteRoute = {
  tier: 'full',
  kind: 'Changing the pacing',
  why: 'it changes the whole video',
};

interface SeedFix {
  id: string;
  status: Extract<FixStatus, 'queued' | 'running' | 'fixed' | 'escalated' | 'undone'>;
  /** Running: the step it is at (0 to 3). */
  step?: 0 | 1 | 2 | 3;
  /** Fixed: how long it took, in seconds. */
  durationSec?: number;
  /** Escalated: why. */
  why?: string;
}

interface SeedNote {
  id: string;
  atSec: number;
  text: string;
  /** `pending`: Auto is reading it. A route: Auto answered. Left out: Auto never read it. */
  route?: 'pending' | NoteRoute;
  fix?: SeedFix;
}

interface SeedJob {
  jobId: string;
  notes: readonly SeedNote[];
}

const SEEDS: readonly SeedJob[] = [
  { jobId: QUICK_FIX_IDS.fresh, notes: [] },
  {
    jobId: QUICK_FIX_IDS.reading,
    notes: [{ id: 'qn-reading-1', atSec: 12, text: FONT, route: 'pending' }],
  },
  {
    jobId: QUICK_FIX_IDS.fixing,
    notes: [
      {
        id: 'qn-fixing-1',
        atSec: 12,
        text: FONT,
        route: QUICK('Changing the caption font'),
        fix: { id: 'qx-fixing-1', status: 'running', step: 1 },
      },
    ],
  },
  {
    jobId: QUICK_FIX_IDS.fixed,
    notes: [
      {
        id: 'qn-fixed-1',
        atSec: 12,
        text: FONT,
        route: QUICK('Changing the caption font'),
        fix: { id: 'qx-fixed-1', status: 'fixed', durationSec: 38 },
      },
    ],
  },
  {
    jobId: QUICK_FIX_IDS.queue,
    notes: [
      {
        id: 'qn-queue-1',
        atSec: 12,
        text: FONT,
        route: QUICK('Changing the caption font'),
        fix: { id: 'qx-queue-1', status: 'running', step: 2 },
      },
      {
        id: 'qn-queue-2',
        atSec: 12,
        text: YELLOW,
        route: QUICK('Changing the caption colour'),
        fix: { id: 'qx-queue-2', status: 'queued' },
      },
    ],
  },
  {
    jobId: QUICK_FIX_IDS.mixed,
    notes: [
      {
        id: 'qn-mixed-1',
        atSec: 12,
        text: FONT,
        route: QUICK('Changing the caption font'),
        fix: { id: 'qx-mixed-1', status: 'fixed', durationSec: 44 },
      },
      { id: 'qn-mixed-2', atSec: 21, text: SWAP, route: CUT_ROUTE },
      { id: 'qn-mixed-3', atSec: 5, text: MUSIC, route: MUSIC_ROUTE },
    ],
  },
  {
    jobId: QUICK_FIX_IDS.full,
    notes: [{ id: 'qn-full-1', atSec: 18, text: PACING, route: FULL_ROUTE }],
  },
  {
    jobId: QUICK_FIX_IDS.escalated,
    notes: [
      {
        id: 'qn-escalated-1',
        atSec: 12,
        text: SIGN,
        route: QUICK('Changing the sign'),
        fix: {
          id: 'qx-escalated-1',
          status: 'escalated',
          why: 'the sign is part of the footage',
        },
      },
    ],
  },
  {
    jobId: QUICK_FIX_IDS.undone,
    notes: [
      {
        id: 'qn-undone-1',
        atSec: 12,
        text: FONT,
        route: QUICK('Changing the caption font'),
        fix: { id: 'qx-undone-1', status: 'undone' },
      },
    ],
  },
  {
    jobId: QUICK_FIX_IDS.allFixed,
    notes: [
      {
        id: 'qn-all-1',
        atSec: 12,
        text: FONT,
        route: QUICK('Changing the caption font'),
        fix: { id: 'qx-all-1', status: 'fixed', durationSec: 41 },
      },
      {
        id: 'qn-all-2',
        atSec: 12,
        text: YELLOW_HE,
        route: QUICK('Changing the caption colour'),
        fix: { id: 'qx-all-2', status: 'fixed', durationSec: 39 },
      },
      {
        id: 'qn-all-3',
        atSec: 2,
        text: NO_TITLE,
        route: QUICK('Changing the title'),
        fix: { id: 'qx-all-3', status: 'fixed', durationSec: 47 },
      },
    ],
  },
  {
    jobId: QUICK_FIX_IDS.manual,
    notes: [
      { id: 'qn-manual-1', atSec: 12, text: FONT },
      { id: 'qn-manual-2', atSec: 21, text: SWAP },
    ],
  },
];

// --- the files -------------------------------------------------------------------------------------

/** The grey of every "before" still the fake makes, and the size of both: 9:16, a twentieth of the cut. */
const BEFORE_RGB = [58, 58, 60] as const;
const STILL_SIZE = [54, 96] as const;

/** The sample composition for a 0:39 cut whose title stays up (see the header). */
function stretched(html: string): string {
  return html
    .replaceAll('data-duration="6"', `data-duration="${CUT_SEC}"`)
    .replace('duration: 6, ease: "none"', `duration: ${CUT_SEC}, ease: "none"`)
    .replace(
      'duration: 0.4, ease: "power2.in" }, 4.8)',
      `duration: 0.4, ease: "power2.in" }, ${CUT_SEC - 0.5})`,
    );
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}

export interface SeedQuickFixesOptions {
  db: StudioDb;
  /** The seed's inbox: each job's folder is `<inboxPath>/<client>/<name>/`. */
  inboxPath: string;
  /** Every time moves by this much, as the jobs' did (the gap between the canvas moment and now). */
  shiftMs?: number;
  specs?: readonly CanvasJobSpec[];
}

/**
 * Stretches each job's sample composition to the cut, writes project.md, the notes (routed as the
 * boards show) and the fixes with the files their state needs. The jobs and the sample
 * compositions are already there (`seedCanvasJobs`, `writeReviewPreviews`).
 */
export async function seedQuickFixes({
  db,
  inboxPath,
  shiftMs = 0,
  specs = QUICK_FIX_JOB_SPECS,
}: SeedQuickFixesOptions): Promise<void> {
  let nowMs = 0;
  const notes = new NoteRepository(db, { clock: () => new Date(nowMs) });
  const fixes = new QuickFixRepository(db);
  const jobSpecs = new Map(specs.map((one) => [one.id, one]));
  const base = Date.parse('2026-10-20T13:30:00.000Z') + shiftMs;

  for (const spec of specs) {
    const jobDir = join(inboxPath, spec.client, spec.name);
    const indexPath = join(jobDir, FIX_PREVIEW_PATH, 'index.html');
    await writeFile(indexPath, stretched(await readFile(indexPath, 'utf8')));
    await writeFile(
      join(jobDir, FIX_PROJECT_PATH),
      `# ${spec.name}\n\nA vertical cut for ${spec.client}. The captions are in Noto Sans Hebrew.\n`,
    );
  }

  for (const seed of SEEDS) {
    const spec = jobSpecs.get(seed.jobId);
    if (spec === undefined) continue;
    const jobDir = join(inboxPath, spec.client, spec.name);
    // Each note a minute after the one before, in the order the boards list them.
    let minute = 0;
    for (const note of seed.notes) {
      minute += 1;
      nowMs = base + minute * 60_000;
      notes.create({
        id: note.id,
        jobId: seed.jobId,
        kind: 'text',
        atSec: note.atSec,
        text: note.text,
      });
      if (note.route === 'pending') notes.setRoute(note.id, { status: 'pending' });
      else if (note.route !== undefined) {
        notes.setRoute(note.id, { status: 'routed', route: note.route });
      }
      if (note.fix === undefined) continue;
      const fix = note.fix;
      const run = TIER_RUNS.quick;
      const startedAt = fix.status === 'queued' ? null : new Date(nowMs + 10_000).toISOString();
      const done = fix.status === 'fixed' || fix.status === 'escalated' || fix.status === 'undone';
      const durationSec = fix.durationSec ?? (done ? 30 : null);
      const endedAt =
        done && startedAt !== null
          ? new Date(Date.parse(startedAt) + (durationSec ?? 0) * 1000).toISOString()
          : null;
      const change = fakeQuickFixChange(note.text);
      const said = 'why' in change ? null : change.said;
      const stepLabel =
        fix.status === 'running'
          ? [
              'Reading the edit',
              note.route !== undefined && note.route !== 'pending'
                ? note.route.kind
                : 'Changing the edit',
              'Checking it',
              'Looking at the frames',
            ][fix.step ?? 0]
          : null;
      fixes.insert({
        id: fix.id,
        jobId: seed.jobId,
        noteId: note.id,
        round: 1,
        status: fix.status,
        step: fix.status === 'running' ? (fix.step ?? 0) : null,
        stepLabel: stepLabel ?? null,
        said: fix.status === 'fixed' ? said : null,
        why: fix.status === 'escalated' ? (fix.why ?? null) : null,
        model: run.model ?? 'sonnet',
        effort: run.effort,
        startedAt,
        endedAt,
        durationSec,
        hasCompare: fix.status === 'fixed',
      });
      if (fix.status === 'fixed') {
        // The fix's fixedAt is the end of the run; the note's fixId says it landed.
        notes.setFix(note.id, { fixId: fix.id, fixedAt: endedAt });
        await landFix(jobDir, fix.id, note, nowMs);
      }
    }
  }
}

/**
 * What a fix that landed leaves behind: the copy Undo puts back (the preview and project.md as they
 * were just before it), the change itself in edit/preview/, and the two stills Compare serves.
 */
async function landFix(
  jobDir: string,
  fixId: string,
  note: SeedNote,
  _nowMs: number,
): Promise<void> {
  const fixDir = join(jobDir, fixDirPath(fixId));
  const preview = join(jobDir, FIX_PREVIEW_PATH);
  await cp(preview, join(fixDir, 'before', 'preview'), { recursive: true });
  if (await exists(join(jobDir, FIX_PROJECT_PATH))) {
    await cp(join(jobDir, FIX_PROJECT_PATH), join(fixDir, 'before', 'project.md'));
  }

  const change = fakeQuickFixChange(note.text);
  let afterRgb: readonly [number, number, number] = BEFORE_RGB;
  let said = 'Done.';
  if (!('why' in change)) {
    const indexPath = join(preview, 'index.html');
    const html = await readFile(indexPath, 'utf8');
    const rule = /#title\s*\{[^}]*\}/.exec(html)?.[0];
    if (rule !== undefined) {
      const changed = change.apply(rule);
      await writeFile(
        indexPath,
        html.replace(rule, () => changed),
      );
      afterRgb = change.rgb;
      said = change.said;
      const projectPath = join(jobDir, FIX_PROJECT_PATH);
      if (await exists(projectPath)) {
        const project = (await readFile(projectPath, 'utf8')).trimEnd();
        const heading = '## Round 1 · fixed in Review';
        await writeFile(
          projectPath,
          project.includes(heading)
            ? `${project}\n- ${said}\n`
            : `${project}\n\n${heading}\n- ${said}\n`,
        );
      }
    }
  }
  await mkdir(fixDir, { recursive: true });
  await writeFile(join(fixDir, 'before.png'), solidPng(...STILL_SIZE, BEFORE_RGB));
  await writeFile(join(fixDir, 'after.png'), solidPng(...STILL_SIZE, afterRgb));
  await writeFile(join(fixDir, FIX_REPLY_FILE), `${JSON.stringify({ done: true, said })}\n`);
  await mkdir(dirname(join(fixDir, 'before.png')), { recursive: true });
}
