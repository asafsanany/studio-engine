// Finalize (E6): the last thing a successful run does. The edit is done and `edit/final.mp4`
// exists; this reads its facts with ffprobe, copies it to the shared exports folder and hands the
// worker the `JobOutput` it applies with SUCCEED.
//
//   <inbox>/<Client>/<Job>/edit/final.mp4   --copy-->   <exportsDir>/<Client>/<Job>.mp4
//
// The export is a copy, never a move: the job folder keeps its `edit/` workspace, so a Retry or a
// re-edit still has everything.
//
// Rules
// - Name: `<Client>/<Job>.mp4`, relative to `exportsDir` (that is `JobOutput.fileName`, which the
//   download route resolves against `exportsDir` and the startup reconcile checks for). Unicode is
//   kept exactly (Hebrew, emoji, accents); the only characters replaced are the ones macOS cannot
//   have in a name, `/` and `:`, each by `-`. The path is written in Unicode NFC. The inbox scan
//   keeps names as the disk lists them and only hashes the NFC form, so a name that came back
//   from the disk in NFD still lands on the same export; APFS compares names regardless of the
//   spelling, so an export folder that was made in the other spelling is the same folder.
// - A half-copied file never has its real name: the copy goes to a hidden `.<id>.mp4.partial` in
//   the client folder (same volume, so the rename is atomic; dotfiles are ignored by the scanner
//   and Finder hides them) and is renamed into place only when every byte arrived.
// - If `<Job>.mp4` is already there, the old file is renamed to the first free `<Job> (n).mp4`
//   (n = 1, 2, ...) and the new export takes `<Job>.mp4`, after the copy succeeded, so a failed
//   export leaves the previous one untouched. Old exports are never deleted.
// - Earlier exports are kept, but nothing points at them: a `ready` job's `output.fileName` is
//   always its plain `<Client>/<Job>.mp4`. A re-edit of the same folder is the same job (same
//   id), so its new output replaces the old one and its download serves the new file; that is
//   what Phase 0 wants. Only two different jobs whose names come out the same after the `:`
//   replacement (`A: b` and `A- b`) would share a name, and then the older job's download serves
//   the newer file.
// - Rotation: the size is the picture as a player shows it, so a clip stored 1920x1080 with a
//   quarter-turn rotation (iPhone portrait) is reported 1080x1920. HDR/HLG changes nothing here.
// - Any failure throws an Error with a short, human message; the worker turns it into
//   "Export failed: <message>" at Render (the last step). An abort stops the copy and removes the
//   partial.
// - Formats (GN7): a render run of a job with two or more formats (`job.formats`) exports a file
//   for each: the main one as above, every other format from `edit/final-<id>.mp4` to
//   `<Client>/<Job> (<id>).mp4` (`Job (1x1).mp4`), each by the same rules, collisions included
//   (`Job (1x1) (1).mp4`). All the sources are checked and copied first, then all are put into
//   place; if one cannot be, the ones already placed are taken back out and the earlier exports
//   put back. `JobOutput` keeps describing the main file and gains `outputs`, one entry per file.
//   A job with one format is exported exactly as before, and an edit run (Review off) always is.

import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  extraExportSuffix,
  extraFormatsOf,
  type Job,
  type JobOutput,
  type JobOutputFile,
} from '@studio/shared';
import { resolveFfmpeg } from './fake-media.js';
import { extraFinalPath } from './preview-files.js';
import { ProbeError, probeVideo } from './probe-video.js';
import type { Finalize } from './worker.js';

/** Where the editor leaves the finished video, inside the job folder. */
export const FINAL_VIDEO_PATH = join('edit', 'final.mp4');

/** Most `<Job> (n).mp4` names tried before giving up. Far more than anyone re-edits a job. */
const MAX_COLLISIONS = 9_999;

/** An export problem whose message is already written for the person looking at the failed job. */
export class ExportError extends Error {
  override readonly name = 'ExportError';
}

/** Copies `source` to `target` (a new hidden file), stopping when `signal` fires. */
export type CopyFile = (source: string, target: string, signal: AbortSignal) => Promise<void>;

export interface FinalizeOptions {
  /** `Config.inboxPath`: a job's folder is `<inboxPath>/<job.relPath>`. */
  inboxPath: string;
  /** `Config.exportsDir`: where the exports go. Not necessarily inside the inbox. */
  exportsDir: string;
  /** The ffprobe executable: a bare name looked up on PATH, then in Homebrew's folders (default). */
  ffprobeBin?: string;
  /** Replaces the byte copy, for tests that need to see or break it half way. */
  copyFile?: CopyFile;
}

/** `name` as one file name: Unicode NFC, with the characters macOS cannot have in one replaced. */
export function exportFileNamePart(name: string): string {
  return name.normalize('NFC').replace(/[/:\0]/g, '-');
}

/**
 * The export's path relative to the exports folder, `Client/Job.mp4`, with a forward slash. With a
 * format id (an extra format, GN7) it is `Client/Job (1x1).mp4`.
 */
export function exportRelPath(job: Pick<Job, 'client' | 'name'>, formatId?: string): string {
  const suffix = formatId === undefined ? '' : extraExportSuffix(formatId);
  return `${exportFileNamePart(job.client)}/${exportFileNamePart(job.name)}${suffix}.mp4`;
}

/** `Client/Job.mp4` -> `Client/Job (n).mp4`, the name an older export is moved to. */
export function numberedName(fileName: string, n: number): string {
  return `${fileName.slice(0, -'.mp4'.length)} (${n}).mp4`;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** The streamed copy: fsynced, and cut short (both streams destroyed) when `signal` fires. */
export const copyFileStreamed: CopyFile = async (source, target, signal) => {
  await pipeline(createReadStream(source), createWriteStream(target, { flags: 'w' }), { signal });
  // So that a rename into place cannot be followed by a power cut that leaves an empty file.
  const written = await open(target, 'r+');
  try {
    await written.sync();
  } finally {
    await written.close();
  }
};

/** What went wrong, in words for the job's error line (no stack). */
function describeProblem(error: unknown, exportsFolder: string): string {
  const code = errorCode(error);
  switch (code) {
    case 'ENOSPC':
    case 'EDQUOT':
      return `Not enough disk space to copy the video to ${exportsFolder}`;
    case 'EACCES':
    case 'EPERM':
      return `No permission to write to ${exportsFolder}`;
    case 'EROFS':
      return `${exportsFolder} is read-only, so the video can't be copied there`;
    case 'ENAMETOOLONG':
      return 'The client or job name is too long to use as an export file name';
    case 'EEXIST':
    case 'ENOTDIR':
      return `Can't make the client folder in ${exportsFolder}: a file has the same name`;
    case 'ENOENT':
      return `The video or the ${exportsFolder} folder disappeared while it was being copied`;
    case undefined:
      return `Could not copy the video to ${exportsFolder}: ${
        error instanceof Error && error.message.trim() !== '' ? error.message : 'unknown error'
      }`;
    default:
      return `Could not copy the video to ${exportsFolder} (${code})`;
  }
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/** The first `<name> (n).mp4` that does not exist yet. */
async function firstFreeName(absPath: string): Promise<string> {
  for (let n = 1; n <= MAX_COLLISIONS; n += 1) {
    const candidate = numberedName(absPath, n);
    if ((await lstatOrNull(candidate)) === null) return candidate;
  }
  throw new ExportError(`There are too many earlier exports named ${basename(absPath)}`);
}

function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new ExportError('The export was stopped');
}

/** One video the export puts in the exports folder: the main format's, or an extra format's. */
interface ExportTarget {
  /** The format's id for an extra format (`Job (1x1).mp4`); `null` for the main video. */
  formatId: string | null;
  /** The finished video, relative to the job folder. */
  sourceRel: string;
  /** Where it goes, relative to the exports folder. */
  fileName: string;
}

/** A target after its source was checked: where it is, what it holds, and where it is copied. */
interface PreparedTarget extends ExportTarget {
  sourceSize: number;
  facts: { durationSec: number; width: number; height: number };
  destination: string;
  partial: string;
  copiedSize: number;
}

/** The exports to make for a job: its main video, and a video of every other format of a render run. */
function targetsOf(job: Job): ExportTarget[] {
  const main: ExportTarget = {
    formatId: null,
    sourceRel: FINAL_VIDEO_PATH,
    fileName: exportRelPath(job),
  };
  // Only a render run has the other formats' videos; an edit run that skips Review makes one video.
  const extras =
    job.runKind === 'render'
      ? extraFormatsOf(job.formats).map(
          (format): ExportTarget => ({
            formatId: format.id,
            sourceRel: extraFinalPath(format.id),
            fileName: exportRelPath(job, format.id),
          }),
        )
      : [];
  return [main, ...extras];
}

/**
 * Builds the `finalize` the queue worker calls after a successful run. It resolves with the job's
 * `JobOutput` once the export is in place, and rejects with an {@link ExportError} (or a
 * {@link ProbeError}) whose message says what to fix.
 */
export function createFinalize(options: FinalizeOptions): Finalize {
  const { inboxPath, ffprobeBin = 'ffprobe', copyFile = copyFileStreamed } = options;
  const exportsRoot = resolve(options.exportsDir);
  const exportsFolder = basename(exportsRoot);

  return async (job, signal) => {
    const partials: string[] = [];
    /** What was put into place so far: undone if a later file cannot be. */
    const placed: { destination: string; movedTo: string | null }[] = [];
    try {
      throwIfStopped(signal);
      const targets = targetsOf(job);

      // 1. The finished videos: there and not empty (all of them, before any is looked into), then
      // readable as a video.
      const sourceSizes: number[] = [];
      for (const target of targets) {
        const source = join(inboxPath, job.relPath, target.sourceRel);
        const sourceStat = await stat(source).catch((error: unknown) => {
          if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
            throw new ExportError(
              `The edit finished but there is no ${target.sourceRel} to export`,
            );
          }
          throw error;
        });
        if (!sourceStat.isFile()) {
          throw new ExportError(`${target.sourceRel} is not a file, so it can't be exported`);
        }
        if (sourceStat.size === 0) {
          throw new ExportError(`The finished video (${target.sourceRel}) is empty`);
        }
        sourceSizes.push(sourceStat.size);
      }

      const probe = await resolveFfmpeg(ffprobeBin);
      const prepared: PreparedTarget[] = [];
      for (const [index, target] of targets.entries()) {
        if (probe === null) {
          throw new ExportError(
            `ffprobe was not found, so the video can't be checked (looked for "${ffprobeBin}"). Install ffmpeg (brew install ffmpeg) and make sure it is on PATH`,
          );
        }
        const facts = await probeVideo(
          probe,
          join(inboxPath, job.relPath, target.sourceRel),
          signal,
        );

        // 2. Where it goes. Must stay inside the exports folder whatever the names are.
        const destination = resolve(exportsRoot, target.fileName);
        const inside = relative(exportsRoot, destination);
        if (
          inside === '' ||
          inside === '..' ||
          inside.startsWith(`..${sep}`) ||
          isAbsolute(inside)
        ) {
          throw new ExportError(
            `The names of this job don't make a valid export path (${target.fileName})`,
          );
        }
        await mkdir(dirname(destination), { recursive: true });
        prepared.push({
          ...target,
          sourceSize: sourceSizes[index] ?? 0,
          facts,
          destination,
          partial: join(
            dirname(destination),
            target.formatId === null
              ? `.${job.id}.mp4.partial`
              : `.${job.id}.${target.formatId}.mp4.partial`,
          ),
          copiedSize: 0,
        });
      }

      // 3. The copies, under hidden names. A leftover of a crashed export of this job is replaced.
      for (const item of prepared) {
        partials.push(item.partial);
        await rm(item.partial, { force: true });
        await copyFile(join(inboxPath, job.relPath, item.sourceRel), item.partial, signal);
        throwIfStopped(signal);
        item.copiedSize = (await stat(item.partial)).size;
        if (item.copiedSize !== item.sourceSize) {
          throw new ExportError(
            `The copy of the video is incomplete (${item.copiedSize} of ${item.sourceSize} bytes)`,
          );
        }
      }

      // 4. Into place. The earlier export, if any, moves to the first free "(n)" first; if the
      // new one cannot take its name after that, the earlier one is put back.
      for (const item of prepared) {
        const existing = await lstatOrNull(item.destination);
        let movedTo: string | null = null;
        if (existing !== null) {
          if (!existing.isFile()) {
            throw new ExportError(`${item.fileName} is already there and is not a video file`);
          }
          movedTo = await firstFreeName(item.destination);
          await rename(item.destination, movedTo);
        }
        try {
          await rename(item.partial, item.destination);
        } catch (error) {
          if (movedTo !== null) await rename(movedTo, item.destination).catch(() => undefined);
          throw error;
        }
        placed.push({ destination: item.destination, movedTo });
        partials.splice(partials.indexOf(item.partial), 1);
      }

      const [first, ...others] = prepared;
      if (first === undefined) throw new ExportError('There is no video to export');
      const output: JobOutput = {
        fileName: first.fileName,
        durationSec: first.facts.durationSec,
        width: first.facts.width,
        height: first.facts.height,
        sizeBytes: first.copiedSize,
      };
      if (others.length === 0) return output;
      // Formats (GN7): one entry for each file, the main one first.
      const mainFormat = job.formats?.[0]?.id;
      const outputs: JobOutputFile[] = prepared.map((item) => ({
        format: item.formatId ?? mainFormat ?? '',
        fileName: item.fileName,
        bytes: item.copiedSize,
      }));
      return { ...output, outputs };
    } catch (error) {
      for (const partial of partials) await rm(partial, { force: true }).catch(() => undefined);
      // A file that was already placed goes back out and its earlier export back in.
      for (const done of placed.reverse()) {
        await rm(done.destination, { force: true }).catch(() => undefined);
        if (done.movedTo !== null) {
          await rename(done.movedTo, done.destination).catch(() => undefined);
        }
      }
      if (signal.aborted) throw new ExportError('The export was stopped');
      if (error instanceof ExportError || error instanceof ProbeError) throw error;
      throw new ExportError(describeProblem(error, exportsFolder), { cause: error });
    }
  };
}
