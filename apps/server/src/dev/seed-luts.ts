// The LUTs library for the canvas seed (CVP-307, `pnpm seed:canvas --luts`): four LUTs of Yours with
// plausible used counts and added times, so the LUTs page can be compared with the LUPage and
// LUStates boards and walked through without importing anything first.
//
//   Golden Hour Warm        Look    2 days ago     used by 3 jobs
//   Teal Orange Soft        Look    2 days ago     not used yet
//   Sony S-Log3 to Rec709   Camera  6 days ago     used by 1 job
//   Soft Pastel             Look    2 minutes ago  not used yet, with the "New" tag
//
// Each is a small .cube made here (17 points a side: the identity with a tint that follows the
// colour, not a copy of anyone's file), written to `<inbox>/_LUTs/<Name>.cube`. The rows go in
// through the same repository the engine uses, with the clock moved to the added time. A few
// built-in LUTs get uses too (a built-in LUT's key is its slug), so "2 jobs" shows on Built in as
// well. The previews are the fake maker's, so nothing here needs ffmpeg.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LutKind } from '@studio/shared';
import type { LutRepository, StoredLut } from '../db/index.js';

/** The grid of the seeded files. */
export const SEED_LUT_SIZE = 17;

/** How long ago a LUT was added. */
export type LutSeedAge = { minutesAgo: number } | { daysAgo: number; hour: number };

export interface LutSeedSpec {
  name: string;
  kind: LutKind;
  /** What the LUT adds to red, green and blue (0..1), strongest in the highlights. */
  tint: readonly [number, number, number];
  added: LutSeedAge;
  /** How many jobs used it (`lut_uses` rows, round 0). */
  usedIn: number;
}

/** The four LUTs of Yours, newest first as the list shows them. */
export const LUT_SEED_SPECS: readonly LutSeedSpec[] = [
  {
    name: 'Soft Pastel',
    kind: 'look',
    tint: [0.03, 0.02, 0.05],
    added: { minutesAgo: 2 },
    usedIn: 0,
  },
  {
    name: 'Golden Hour Warm',
    kind: 'look',
    tint: [0.08, 0.03, -0.06],
    added: { daysAgo: 2, hour: 14 },
    usedIn: 3,
  },
  {
    name: 'Teal Orange Soft',
    kind: 'look',
    tint: [0.05, -0.01, -0.04],
    added: { daysAgo: 2, hour: 12 },
    usedIn: 0,
  },
  {
    name: 'Sony S-Log3 to Rec709',
    kind: 'camera',
    tint: [0.02, 0.0, 0.03],
    added: { daysAgo: 6, hour: 16 },
    usedIn: 1,
  },
];

/** Built-in LUTs that jobs are said to have used: slug → how many jobs. */
export const BUILT_IN_USES: Readonly<Record<string, number>> = {
  'film-contrast': 2,
  'golden-warm': 1,
  'studio-balanced': 4,
};

/** Jobs of the twelve that the uses point at (a use is a job id; there are no foreign keys). */
const USED_IN_JOBS = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'];

/**
 * The text of a .cube of {@link SEED_LUT_SIZE} points a side that leaves a colour as it is plus a
 * tint scaled by how bright it is: the identity, with a look. Red varies fastest, as in the format.
 */
export function seedCubeText(name: string, tint: readonly [number, number, number]): string {
  const n = SEED_LUT_SIZE;
  const lines = [`TITLE "${name}"`, '# made by the canvas seed', `LUT_3D_SIZE ${n}`];
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  for (let b = 0; b < n; b += 1) {
    for (let g = 0; g < n; g += 1) {
      for (let r = 0; r < n; r += 1) {
        const rgb = [r / (n - 1), g / (n - 1), b / (n - 1)] as const;
        const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        const out = rgb.map((v, i) => clamp(v + (tint[i] as number) * (0.4 + 0.6 * luma)));
        lines.push(out.map((v) => v.toFixed(6)).join(' '));
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The moment an age points at, from `now` (ms). A calendar day is the viewer's own. */
export function lutSeedTime(now: number, age: LutSeedAge): number {
  if ('minutesAgo' in age) return now - age.minutesAgo * 60_000;
  const day = new Date(now);
  day.setDate(day.getDate() - age.daysAgo);
  day.setHours(age.hour, 0, 0, 0);
  return day.getTime();
}

export interface SeedLutsOptions {
  /** A repository on the seed's database whose clock the seeding sets (`setNow`). */
  repo: LutRepository;
  /** Moves the repository's clock to this moment: every row is stamped with it. */
  setNow: (at: number) => void;
  /** The inbox, whose `_LUTs/` gets the files. */
  inboxPath: string;
  /** The moment the ages are counted from. */
  now: number;
  specs?: readonly LutSeedSpec[];
}

/**
 * Puts the LUTs into the seed: a file in `_LUTs/` and a row (with its uses) for each. Answers the
 * rows, in the order of the specs.
 */
export async function seedLuts({
  repo,
  setNow,
  inboxPath,
  now,
  specs = LUT_SEED_SPECS,
}: SeedLutsOptions): Promise<StoredLut[]> {
  const dir = join(inboxPath, '_LUTs');
  await mkdir(dir, { recursive: true });
  const made: StoredLut[] = [];
  // Oldest first, so the ids and the rows are made in the order a library would grow.
  const order = [...specs].sort((a, b) => lutSeedTime(now, a.added) - lutSeedTime(now, b.added));
  for (const spec of order) {
    const at = lutSeedTime(now, spec.added);
    const text = seedCubeText(spec.name, spec.tint);
    const file = `${spec.name}.cube`;
    await writeFile(join(dir, file), text);
    setNow(at);
    const lut = repo.create({
      name: spec.name,
      kind: spec.kind,
      size: SEED_LUT_SIZE,
      file,
      bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'),
      sourceName: file,
    });
    for (const jobId of USED_IN_JOBS.slice(0, spec.usedIn)) {
      repo.addUse(lut.id, jobId, 0, new Date(at + 3_600_000).toISOString());
    }
    made.push(lut);
  }
  for (const [slug, jobs] of Object.entries(BUILT_IN_USES)) {
    for (const jobId of USED_IN_JOBS.slice(0, jobs)) {
      repo.addUse(slug, jobId, 0, new Date(now - 3_600_000).toISOString());
    }
  }
  return specs.map((spec) => made.find((lut) => lut.name === spec.name) as StoredLut);
}
