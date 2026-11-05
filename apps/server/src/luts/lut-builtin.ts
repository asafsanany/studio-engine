// The built-in LUTs (LUTs plan, "Built in"). OWNER: LU2.
//
// The catalog is `BUILTIN_LUTS` in shared: 19 rows. Their files are read from the installed
// colour-grade skill, `~/.claude/skills/color-grade-ai/correction_luts/` (the same place
// scripts/color-grade/grade_batch.py reads: `STUDIO_COLOR_GRADE_DIR` overrides it, and tests pass
// `skillDir`) and are never copied into the repo. Without the skill (or with any of the 18 files
// missing) nothing is available and the page says "Built-in LUTs need the colour grade. Run pnpm
// color-grade:install.".
//
// Cinematic is not a file: it is the wrapper's `--look cinematic` chain (film contrast and a light
// golden warmth). `grade_batch.py --bake-look cinematic` writes that chain, blends and all, as one
// .cube; this module calls it once, caches the cube in `<data>/lut-previews/_baked/` under a hash of
// the script and the skill's files, and uses it for Cinematic's previews and for a copy of it in
// Yours. No blend number is copied into TypeScript.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_LUTS,
  type BuiltInLut,
  type LutDetail,
  type LutSummary,
  lutSizeLabel,
  lutUsedLabel,
} from '@studio/shared';
import type { WorkerLogger } from '../pipeline/worker.js';
import {
  fileSha256,
  type LutPreviews,
  lutPreviewVersion,
  type PreviewSource,
} from './lut-previews.js';
import type { BuiltInLuts } from './lut-service.js';

/**
 * The grid of the baked Cinematic cube: `BAKE_GRID` in scripts/color-grade/grade_batch.py. Known
 * here so the list does not wait for the bake; a test bakes and checks the two agree.
 */
export const BAKED_LOOK_SIZE = 33;

/** The skill's folder: `STUDIO_COLOR_GRADE_DIR`, else `~/.claude/skills/color-grade-ai`. */
export function colorGradeSkillDir(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.STUDIO_COLOR_GRADE_DIR;
  return set !== undefined && set !== '' ? set : join(homedir(), '.claude/skills/color-grade-ai');
}

/** scripts/color-grade/grade_batch.py, from `src/luts/` or `dist/luts/` alike. */
const GRADE_BATCH_SCRIPT = fileURLToPath(
  new URL('../../../../scripts/color-grade/grade_batch.py', import.meta.url),
);

export interface BuiltInLutsOptions {
  /** The skill's folder. Default: {@link colorGradeSkillDir}. Tests pass a temp one. */
  skillDir?: string;
  /** `<data>`: where the baked Cinematic cube is kept (`lut-previews/_baked`). Default: a temp folder. */
  dataDir?: string;
  /** The Python that runs the bake. Default: the colour grade's venv if it is there, else `python3`. */
  python?: string;
  /** grade_batch.py. Default: the one in this repo. */
  bakeScript?: string;
  /** How long the bake may take. Default 60 s. */
  bakeTimeoutMs?: number;
  /** After a failed bake, how long before the next try. Default 30 s. */
  bakeRetryMs?: number;
  logger?: WorkerLogger;
  /** The clock for the retry wait. */
  now?: () => number;
}

function defaultPython(): string {
  const fromEnv = process.env.STUDIO_COLOR_GRADE_PYTHON;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const venv = join(homedir(), '.studio-engine/color-grade/venv/bin/python');
  return existsSync(venv) ? venv : 'python3';
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The grid of a .cube, from its header (it is within the first lines). */
async function gridSizeOf(path: string): Promise<number | null> {
  const handle = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4096), 0, 4096, 0);
    const match = /^\s*LUT_3D_SIZE\s+(\d+)/m.exec(buffer.toString('utf8', 0, bytesRead));
    return match?.[1] === undefined ? null : Number(match[1]);
  } finally {
    await handle.close();
  }
}

/** The built-in catalog of this Mac. */
export function createBuiltInLuts(options: BuiltInLutsOptions = {}): BuiltInLuts {
  const skillDir = options.skillDir ?? colorGradeSkillDir();
  const lutsDir = join(skillDir, 'correction_luts');
  const bakedDir = join(
    options.dataDir ?? join(tmpdir(), 'studio-engine'),
    'lut-previews',
    '_baked',
  );
  const bakeScript = options.bakeScript ?? GRADE_BATCH_SCRIPT;
  const timeoutMs = options.bakeTimeoutMs ?? 60_000;
  const retryMs = options.bakeRetryMs ?? 30_000;
  const now = options.now ?? Date.now;
  const logger = options.logger;

  const fileOf = (row: BuiltInLut): string | null =>
    row.files[0] === undefined ? null : join(lutsDir, row.files[0]);

  // --- the Cinematic bake -------------------------------------------------------------------------

  /** A hash of the script and every .cube of the skill: when either changes, the bake is redone. */
  async function bakeInputsKey(): Promise<string> {
    const hash = createHash('sha256');
    hash.update(await readFile(bakeScript));
    for (const name of (await readdir(lutsDir)).filter((n) => n.endsWith('.cube')).sort()) {
      hash.update(`\n${name}:${await fileSha256(join(lutsDir, name))}`);
    }
    return hash.digest('hex').slice(0, 16);
  }

  async function bake(out: string): Promise<void> {
    const scratch = `${out}.part`;
    await mkdir(bakedDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      execFile(
        options.python ?? defaultPython(),
        [bakeScript, '--bake-look', 'cinematic', '--color-grade-dir', skillDir, '--out', scratch],
        { timeout: timeoutMs, killSignal: 'SIGKILL' },
        (err, _stdout, stderr) => {
          if (err) reject(new Error(`${err.message}\n${stderr}`.trim().slice(0, 600)));
          else resolve();
        },
      );
    });
    await rename(scratch, out);
  }

  const baking = new Map<string, Promise<string | null>>();
  let failedAt: { key: string; at: number } | null = null;

  /** The baked Cinematic .cube (made once per skill version), or `null` when it cannot be made. */
  async function bakedCinematic(): Promise<string | null> {
    let key: string;
    try {
      key = await bakeInputsKey();
    } catch {
      return null;
    }
    const out = join(bakedDir, `cinematic-${key}.cube`);
    if (await isFile(out)) return out;
    if (failedAt !== null && failedAt.key === key && now() - failedAt.at < retryMs) return null;
    let running = baking.get(key);
    if (running === undefined) {
      running = bake(out)
        .then(() => out)
        .catch(async (err: unknown) => {
          failedAt = { key, at: now() };
          logger?.warn({ err }, 'could not bake the Cinematic look into one LUT file');
          await rm(`${out}.part`, { force: true });
          return null;
        })
        .finally(() => baking.delete(key));
      baking.set(key, running);
    }
    return running;
  }

  // --- the catalog --------------------------------------------------------------------------------

  async function cubeFile(slug: string): Promise<string | null> {
    const row = BUILTIN_LUTS.find((lut) => lut.slug === slug);
    if (row === undefined) return null;
    if (row.look !== null) return bakedCinematic();
    const path = fileOf(row);
    return path !== null && (await isFile(path)) ? path : null;
  }

  async function available(): Promise<boolean> {
    for (const row of BUILTIN_LUTS) {
      const path = fileOf(row);
      if (path !== null && !(await isFile(path))) return false;
    }
    return true;
  }

  async function summaryOf(
    row: BuiltInLut,
    used: number,
  ): Promise<{ summary: LutSummary; path: string | null; size: number }> {
    const path = row.look === null ? fileOf(row) : null;
    const size = path === null ? BAKED_LOOK_SIZE : ((await gridSizeOf(path)) ?? BAKED_LOOK_SIZE);
    let sha: string | null = null;
    try {
      const file = await cubeFile(row.slug);
      sha = file === null ? null : await fileSha256(file);
    } catch {
      sha = null;
    }
    return {
      path,
      size,
      summary: {
        slug: row.slug,
        name: row.name,
        kind: row.kind,
        size,
        owner: 'builtIn',
        used,
        usedLabel: lutUsedLabel(used, row.usedBy),
        addedAt: null,
        isNew: false,
        previewKey: lutPreviewVersion(sha, row.kind),
      },
    };
  }

  return {
    available,
    list: async (usedCounts) => {
      if (!(await available())) return [];
      return Promise.all(
        BUILTIN_LUTS.map(
          async (row) => (await summaryOf(row, usedCounts.get(row.slug) ?? 0)).summary,
        ),
      );
    },
    get: async (slug, used, usedIn) => {
      const row = BUILTIN_LUTS.find((lut) => lut.slug === slug);
      if (row === undefined || !(await available())) return null;
      const { summary, path, size } = await summaryOf(row, used);
      const detail: LutDetail = {
        ...summary,
        description: row.description,
        note: row.note,
        file: row.files[0] ?? null,
        sizeLabel: lutSizeLabel(size),
        bytes: path === null ? null : (await stat(path)).size,
        usedIn,
      };
      return detail;
    },
    cubePath: async (slug) => {
      const row = BUILTIN_LUTS.find((lut) => lut.slug === slug);
      const path = row === undefined || row.look !== null ? null : fileOf(row);
      return path !== null && (await isFile(path)) ? path : null;
    },
    cubeFile,
  };
}

/**
 * What a built-in row's stills are made from: its file (Cinematic: the baked chain) and the hash of
 * it. `null` when the file is not there (the skill is missing or the bake failed).
 */
export async function builtInPreviewSource(
  builtIn: BuiltInLuts,
  row: BuiltInLut,
): Promise<PreviewSource | null> {
  const cubePath = await builtIn.cubeFile(row.slug);
  if (cubePath === null) return null;
  return {
    key: row.slug,
    kind: row.kind,
    cubePath,
    look: row.look,
    sha256: await fileSha256(cubePath),
  };
}

/**
 * Starts the three "after" stills of every built-in row in the background (the engine calls it
 * after boot while LUTs are on): the previews queue runs them two at a time at low priority, so a
 * still the page asks for goes first. Never throws.
 */
export async function warmBuiltInLuts(builtIn: BuiltInLuts, previews: LutPreviews): Promise<void> {
  try {
    if (!(await builtIn.available())) return;
    for (const row of BUILTIN_LUTS) {
      const source = await builtInPreviewSource(builtIn, row);
      if (source !== null) previews.warm(source);
    }
  } catch {
    // The page asks for the stills it needs when it needs them.
  }
}
