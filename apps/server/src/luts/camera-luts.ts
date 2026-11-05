// Camera LUTs for an edit run: what the footage says, and the one LUT that matches (LUTs build 2,
// LU10). OWNER: LU10.
//
//   an edit run starts (lutsInEdits on)
//     ─▶ the job's video files: the texts that could name a log curve are each file's tags (ffprobe)
//        and its path ("C0003_S-Log3.MP4")                         shared/camera-luts.ts reads them
//     ─▶ per curve named, the library's Camera LUTs that name the same curve
//          exactly one ─▶ copied into <job>/edit/luts/<slug>.cube, the use counted, handed to the editor
//          none / several ─▶ nothing is copied; the editor is told what to end with if the grade
//                            reports that footage as log (the "Waiting for a camera LUT: …" line)
//     ─▶ RunLibraryRefs.camera on the run's context (the Claude runner puts it in the prompt; the
//        fake runner records it)
//
// What this does not decide: whether the footage is log. Only the colour-grade wrapper can say that
// (it measures the frames), so a curve found here is a hint and the editor applies the LUT only to
// a source the wrapper's report calls log. Nothing here can fail a run: a file ffprobe cannot read
// just has no tags, a LUT that cannot be copied counts as no match (the job then waits for one, and
// the log says why).
//
// Wired by `withLutRefs` (lut-job-files.ts) through its `camera` option.

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import {
  BUILTIN_LUTS,
  type CameraCurveId,
  type CameraLutCandidate,
  cameraCurveLabel,
  cameraCurveOfClip,
  matchCameraLuts,
} from '@studio/shared';
import { listJobFiles } from '../inbox/scan.js';
import type { RunCameraCurve, RunCameraLuts, RunLut } from '../pipeline/runner.js';
import type { WorkerLogger } from '../pipeline/worker.js';
import {
  type CameraPreparer,
  copyWhole,
  EDIT_LUTS_DIR,
  type LutJobFilesOptions,
} from './lut-job-files.js';

const SILENT: WorkerLogger = { info() {}, warn() {}, error() {} };

/** Reads the texts a file carries in its tags (every value, container and streams). Never rejects. */
export type CameraTagProbe = (absPath: string) => Promise<string[]>;

/** The most files whose tags are read for one run (a folder of hundreds of clips costs seconds). */
const MAX_FILES = 200;

/** How many of a curve's files the prompt names. */
const MAX_FILES_PER_CURVE = 5;

/** Longest tag value that counts as text a person wrote (a binary blob does not). */
const MAX_TAG_LENGTH = 200;

/** ffprobe's tags of one file as plain strings; an unreadable file has none. */
export function createTagProbe(bin = 'ffprobe', timeoutMs = 15_000): CameraTagProbe {
  return (absPath) =>
    new Promise((resolve) => {
      execFile(
        bin,
        ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', '-i', absPath],
        { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout) => resolve(error ? [] : tagTexts(stdout)),
      );
    });
}

/** Every string value of ffprobe's `-of json` tags output. */
export function tagTexts(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const texts: string[] = [];
  const collect = (tags: unknown): void => {
    if (typeof tags !== 'object' || tags === null) return;
    for (const value of Object.values(tags)) {
      if (typeof value === 'string' && value !== '' && value.length <= MAX_TAG_LENGTH) {
        texts.push(value);
      }
    }
  };
  if (typeof parsed !== 'object' || parsed === null) return texts;
  const { format, streams } = parsed as { format?: { tags?: unknown }; streams?: unknown };
  collect(format?.tags);
  if (Array.isArray(streams)) {
    for (const stream of streams as unknown[]) {
      if (typeof stream === 'object' && stream !== null) {
        collect((stream as { tags?: unknown }).tags);
      }
    }
  }
  return texts;
}

/** A job's video files and the curve each one says, in the order the files are listed. */
export async function curvesOfFootage(
  jobDir: string,
  probe: CameraTagProbe,
): Promise<{ relPath: string; curve: CameraCurveId }[]> {
  const files = (await listJobFiles(jobDir)).filter((file) => file.kind === 'video');
  const found: { relPath: string; curve: CameraCurveId }[] = [];
  for (const file of files.slice(0, MAX_FILES)) {
    // The path first: it costs nothing and is usually where a person wrote the curve down.
    const named = cameraCurveOfClip([file.relPath]);
    const curve = named ?? cameraCurveOfClip([file.relPath, ...(await probe(file.absPath))]);
    if (curve !== null) found.push({ relPath: file.relPath, curve });
  }
  return found;
}

/** The Camera LUTs of the library a match can be made from: Yours, and the built-in ones. */
interface LibraryCamera extends CameraLutCandidate {
  owner: 'yours' | 'builtIn';
  /** The use's key: a Yours LUT's id, a built-in one's slug. */
  useKey: string;
}

async function libraryCameraLuts(options: LutJobFilesOptions): Promise<LibraryCamera[]> {
  const yours = options.luts.list().map(
    (row): LibraryCamera => ({
      slug: row.slug,
      name: row.name,
      kind: row.kind,
      file: row.file,
      owner: 'yours',
      useKey: row.id,
    }),
  );
  const builtIn = (await options.builtIn.available())
    ? BUILTIN_LUTS.map(
        (row): LibraryCamera => ({
          slug: row.slug,
          name: row.name,
          kind: row.kind,
          file: row.files[0] ?? null,
          owner: 'builtIn',
          useKey: row.slug,
        }),
      )
    : [];
  return [...yours, ...builtIn].filter((lut) => lut.kind === 'camera');
}

/**
 * The camera preparer `withLutRefs` calls before an edit run. `probe` reads a file's tags (ffprobe
 * by default); tests pass a canned one.
 */
export function createCameraPreparer(
  options: LutJobFilesOptions,
  probe: CameraTagProbe = createTagProbe(),
): CameraPreparer {
  const logger = options.logger ?? SILENT;
  return async ({ job, jobDir, byNote, pending }): Promise<RunCameraLuts> => {
    if (byNote) return { curves: [], byNote: true };

    const footage = await curvesOfFootage(jobDir, probe);
    if (footage.length === 0) return { curves: [], byNote: false };

    const library = await libraryCameraLuts(options);
    const curves: RunCameraCurve[] = [];
    for (const curve of new Set(footage.map((entry) => entry.curve))) {
      const files = footage
        .filter((entry) => entry.curve === curve)
        .map((entry) => entry.relPath)
        .slice(0, MAX_FILES_PER_CURVE);
      const answer = matchCameraLuts(curve, library);
      const base = { curve, label: cameraCurveLabel(curve), files };
      if (answer.kind === 'several') {
        curves.push({ ...base, match: { kind: 'several', names: answer.luts.map((l) => l.name) } });
        continue;
      }
      if (answer.kind === 'none') {
        curves.push({ ...base, match: { kind: 'none' } });
        continue;
      }
      const lut = answer.lut;
      try {
        const source =
          lut.owner === 'yours'
            ? join(options.inboxPath, '_LUTs', lut.file ?? '')
            : await options.builtIn.cubePath(lut.slug);
        if (source === null || lut.file === null) throw new Error('the LUT has no file');
        const path = `${EDIT_LUTS_DIR}/${lut.slug}.cube`;
        await copyWhole(source, join(jobDir, path));
        const run: RunLut & { path: string } = {
          slug: lut.slug,
          name: lut.name,
          kind: 'camera',
          owner: lut.owner,
          path,
          look: null,
        };
        curves.push({ ...base, match: { kind: 'one', lut: run } });
        pending.push({ key: lut.useKey, slug: lut.slug, owner: lut.owner, round: 0 });
      } catch (err) {
        logger.warn(
          { err, jobId: job.id, lut: lut.slug },
          'could not copy the matching camera LUT into the job',
        );
        curves.push({ ...base, match: { kind: 'none' } });
      }
    }
    return { curves, byNote: false };
  };
}
