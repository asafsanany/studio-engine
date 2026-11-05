// A LUT's slug to the file that makes its look (LUTs plan). Shared by the LUTs page's test stills
// (routes/lut-previews.ts, LU2) and the look on the paused frame in Review (LU11).
//
//   slug ─▶ Yours (a row of the `luts` table: its file in <inbox>/_LUTs)
//        ─▶ Built in (the colour-grade skill's file; Cinematic is the chain baked into one cube)
//        ─▶ not found / the file left _LUTs / the Cinematic bake failed

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { builtInLut, LUT_MESSAGES, type LutKind } from '@studio/shared';
import type { LutRepository } from '../db/lut-repository.js';
import { builtInPreviewSource } from './lut-builtin.js';
import { lutPreviewVersion, type PreviewSource } from './lut-previews.js';
import type { BuiltInLuts } from './lut-service.js';

export interface LutSourceDeps {
  /** Which LUTs of Yours exist, with their files' names and hashes. */
  luts: Pick<LutRepository, 'getBySlug'>;
  /** The built-in rows and their files in the skill. */
  builtIn: BuiltInLuts;
  /** The inbox, whose `_LUTs/` holds the files of Yours. */
  inboxPath: string;
}

/** The LUT a still is asked for: what it is made from, and the `?v=` that goes with it. */
export type ResolvedLutSource =
  | { ok: true; source: PreviewSource; version: string | null }
  | { ok: false; status: 404 | 500; error: string };

/**
 * The source of the LUT `slug`. `needsFile` says whether the kind asked about is one whose file is
 * run (a Camera LUT's stills need none, so a Camera LUT whose file left `_LUTs` still has them).
 */
export async function resolveLutSource(
  { luts, builtIn, inboxPath }: LutSourceDeps,
  slug: string,
  needsFile: (kind: LutKind) => boolean,
): Promise<ResolvedLutSource> {
  const own = luts.getBySlug(slug);
  if (own !== null) {
    const cubePath = join(inboxPath, '_LUTs', own.file);
    if (needsFile(own.kind) && !existsSync(cubePath)) {
      return { ok: false, status: 404, error: LUT_MESSAGES.fileMissing };
    }
    return {
      ok: true,
      source: { key: own.id, kind: own.kind, cubePath, look: null, sha256: own.sha256 },
      version: lutPreviewVersion(own.sha256, own.kind),
    };
  }
  const row = builtInLut(slug);
  if (row === undefined || !(await builtIn.available())) {
    return { ok: false, status: 404, error: LUT_MESSAGES.notFound };
  }
  let source: PreviewSource | null;
  try {
    source = await builtInPreviewSource(builtIn, row);
  } catch {
    source = null;
  }
  // The Cinematic look's chain could not be baked, or a file went missing since the check.
  if (source === null) return { ok: false, status: 500, error: LUT_MESSAGES.previewFailed };
  return { ok: true, source, version: lutPreviewVersion(source.sha256, row.kind) };
}
