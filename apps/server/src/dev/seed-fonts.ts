// The Fonts library for the canvas seed (CVP-343, `pnpm seed:canvas --fonts`): the five families of
// the test fonts (fixtures/fonts/) filed into the seed inbox's `_Fonts` the way an import files
// them, with plausible added times and "Used in" counts, so the Fonts page can be compared with the
// FOPage and FOStates boards and walked through without importing anything first.
//
//   Secular One    Hebrew + English   3 days ago     used by 3 jobs
//   Bellefair      Hebrew + English   9 days ago     not used yet
//   Varela Round   Hebrew + English   9 days ago     not used yet
//   Outfit         English only       1 day ago      used by 1 job (its Bold); two weights
//   Oswald         English only       2 minutes ago  not used yet, with the "New" tag
//
// The six real font files are COPIED from fixtures/fonts/ (never the real `_Fonts` of the Mac); the
// copies get the added time as their modified time, which is where a family's "added" comes from.
// The use rows go in through the same repository the engine uses. `Outfit-Bold.woff`, `.woff2` and
// `broken-cut-short.ttf`, which sit in the same fixtures folder, are not seeded: they are for the
// reader's and the import's tests.

import { copyFile, mkdir, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT_SCRIPT_LABELS } from '@studio/shared';
import type { FontRepository } from '../db/font-repository.js';
import { fontsDirFor } from '../pipeline/shared-fonts.js';

/** The folder of the test fonts at the root of the repo. */
export const FONT_FIXTURES_DIR = fileURLToPath(
  new URL('../../../../fixtures/fonts/', import.meta.url),
);

/** How long ago a family was added. */
export type FontSeedAge = { minutesAgo: number } | { daysAgo: number; hour: number };

export interface FontSeedSpec {
  /** The family's name (also the folder it is filed in). */
  family: string;
  /** Which of the two folders it is filed in. */
  script: keyof typeof FONT_SCRIPT_LABELS;
  /** Its files in fixtures/fonts/. */
  files: readonly string[];
  added: FontSeedAge;
  /** How many jobs used it (`font_uses` rows, round 0). */
  usedIn: number;
  /** The weight those jobs used (default 400). */
  usedWeight?: number;
}

/** The five families, in the order the page lists them (A to Z; Oswald is new, so it comes first). */
export const FONT_SEED_SPECS: readonly FontSeedSpec[] = [
  {
    family: 'Oswald',
    script: 'english',
    files: ['Oswald-Regular.ttf'],
    added: { minutesAgo: 2 },
    usedIn: 0,
  },
  {
    family: 'Bellefair',
    script: 'hebrew',
    files: ['Bellefair-Regular.ttf'],
    added: { daysAgo: 9, hour: 11 },
    usedIn: 0,
  },
  {
    family: 'Outfit',
    script: 'english',
    files: ['Outfit-Regular.ttf', 'Outfit-Bold.ttf'],
    added: { daysAgo: 1, hour: 18 },
    usedIn: 1,
    usedWeight: 700,
  },
  {
    family: 'Secular One',
    script: 'hebrew',
    files: ['SecularOne-Regular.ttf'],
    added: { daysAgo: 3, hour: 15 },
    usedIn: 3,
  },
  {
    family: 'Varela Round',
    script: 'hebrew',
    files: ['VarelaRound-Regular.ttf'],
    added: { daysAgo: 9, hour: 11 },
    usedIn: 0,
  },
];

/** Jobs of the twelve that the uses point at (a use is a job id; there are no foreign keys). */
const USED_IN_JOBS = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'];

/** The moment an age points at, from `now` (ms). A calendar day is the viewer's own. */
export function fontSeedTime(now: number, age: FontSeedAge): number {
  if ('minutesAgo' in age) return now - age.minutesAgo * 60_000;
  const day = new Date(now);
  day.setDate(day.getDate() - age.daysAgo);
  day.setHours(age.hour, 0, 0, 0);
  return day.getTime();
}

export interface SeedFontsOptions {
  /** A repository on the seed's database. */
  repo: FontRepository;
  /** The inbox, whose `_Fonts/` gets the files. */
  inboxPath: string;
  /** The moment the ages are counted from (ms). */
  now: number;
  /** Where the font files are copied from (default: fixtures/fonts/ of the repo). */
  fixturesDir?: string;
  specs?: readonly FontSeedSpec[];
}

/**
 * Makes `<inbox>/_Fonts/` and puts the families into it: a copy of each fixture file in
 * `<Hebrew + English | English only>/<Family>/`, its modified time set to the added time, and the
 * "used by" rows. With no specs it only makes the folder.
 */
export async function seedFonts({
  repo,
  inboxPath,
  now,
  fixturesDir = FONT_FIXTURES_DIR,
  specs = FONT_SEED_SPECS,
}: SeedFontsOptions): Promise<void> {
  const root = fontsDirFor(inboxPath);
  await mkdir(root, { recursive: true });
  for (const spec of specs) {
    const at = fontSeedTime(now, spec.added);
    const folder = join(root, FONT_SCRIPT_LABELS[spec.script], spec.family);
    await mkdir(folder, { recursive: true });
    for (const file of spec.files) {
      const target = join(folder, file);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(fixturesDir, file), target);
      await utimes(target, new Date(at), new Date(at));
    }
    for (const jobId of USED_IN_JOBS.slice(0, spec.usedIn)) {
      repo.addUse(
        {
          family: spec.family,
          weight: spec.usedWeight ?? 400,
          italic: false,
          jobId,
          round: 0,
          source: 'token',
        },
        new Date(at + 3_600_000).toISOString(),
      );
    }
  }
}

/**
 * The fonts that notes of the seed's jobs asked for and the library does not have (FN16), newest
 * first, with how long ago each was asked: the board's "Demo · Horizon FPV asked for Gotham Bold".
 */
export const FONT_SEED_REQUESTS: readonly { name: string; minutesAgo: number }[] = [
  { name: 'Gotham Bold', minutesAgo: 5 },
  { name: 'Avenir Next', minutesAgo: 40 },
  { name: 'Proxima Nova Bold', minutesAgo: 120 },
];

/**
 * Writes the first `count` of {@link FONT_SEED_REQUESTS} for the seed's jobs, one job each in the
 * order given (the edit's own notes are round 0, the others are review rounds), so the Fonts page
 * shows its "a note asked for a font you don't have" banner with `count` open requests. With no
 * jobs it writes nothing.
 */
export function seedFontRequests({
  repo,
  jobIds,
  count,
  now,
}: {
  repo: FontRepository;
  jobIds: readonly string[];
  count: number;
  now: number;
}): void {
  const asked = FONT_SEED_REQUESTS.slice(
    0,
    Math.max(0, Math.min(count, FONT_SEED_REQUESTS.length)),
  );
  asked.forEach((request, index) => {
    const jobId = jobIds[index];
    if (jobId === undefined) return;
    repo.addRequest(
      request.name,
      jobId,
      index,
      new Date(now - request.minutesAgo * 60_000).toISOString(),
    );
  });
}
