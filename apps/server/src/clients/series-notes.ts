// Add to series (Series plan §6): on Send, the notes the owner marked "Series" on an episode become one
// Markdown file in the series folder, "Review notes – <job> – round N.md". The file has the style
// notes' file's shape and name, but its own intro: the notes are rules for this series, not for the
// client (`renderSeriesNotesFile`). It is written into `_Series/<name>/` under the first free name;
// the service is told its name and size once it is in place (`SeriesService.addNotes`). Never
// throws: Send must not fail because of the series.
//
// Nothing goes into series.md at Send (C26): the revise run that this Send starts decides what the
// notes mean ("a beat later" becomes 0.5 s), so the file waits for the episode's approval. When the
// episode is approved it becomes the series' format, and that run turns each note into a rule with
// the value the episode has (`SeriesService.approved`). A note marked both Series and Style goes
// into both: Send calls the style's hook and this one with their own notes.

import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderSeriesNotesFile, styleNotesFileName } from '@studio/shared';
import type { SeriesRepository } from '../db/index.js';
import { type RunnerLogger, SILENT_LOGGER } from '../pipeline/claude-process.js';
import type { SeriesNotesHook } from '../review/review-service.js';
import { seriesDirFor } from './paths.js';
import type { SeriesService } from './series-service.js';
import { numberedName } from './style-upload.js';

export interface SeriesNotesOptions {
  /** `Config.inboxPath`: the series folder is `<inbox>/<Client>/_Series/<name>` (`seriesDirFor`). */
  inboxPath: string;
  /** The job's series, by `job.seriesId`: its folder's name. */
  seriesRepo: Pick<SeriesRepository, 'get'>;
  /** Whether series are on, and where the file waits for the episode's approval. */
  series: Pick<SeriesService, 'enabled' | 'addNotes'>;
  /** Default silent. */
  logger?: RunnerLogger;
}

/** More names than this are taken: something is wrong with the folder, not with the name. */
const MAX_NAME_TRIES = 1000;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Writes `content` into `dir` as `name`, or as the first of "name (1)", "name (2)", … that is free,
 * and answers the name it got. A file that is there already is never touched: the file is created
 * only if its name is free (`wx`), which the volume decides, so on a case-insensitive one "Notes.md"
 * is taken by "notes.md".
 */
async function writeUnderFreeName(dir: string, name: string, content: string): Promise<string> {
  for (let n = 0; n < MAX_NAME_TRIES; n += 1) {
    const candidate = n === 0 ? name : numberedName(name, n);
    try {
      await writeFile(join(dir, candidate), content, { flag: 'wx' });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`No free name for ${name} in ${dir}`);
}

export function createSeriesNotes(options: SeriesNotesOptions): SeriesNotesHook {
  const { inboxPath, seriesRepo, series, logger = SILENT_LOGGER } = options;
  return {
    get enabled() {
      return series.enabled;
    },

    async append(job, notes) {
      const ids = { jobId: job.id, clientId: job.clientId, seriesId: job.seriesId };
      try {
        // A note can't be marked Series while series are off, but they can be switched off after.
        if (!series.enabled) {
          logger.info(ids, 'series are off: the review notes are not added to a series');
          return;
        }
        const stored = job.seriesId === null ? null : seriesRepo.get(job.seriesId);
        if (stored === null) {
          logger.warn(ids, 'the job is in no series any more: the review notes are not added');
          return;
        }
        // `job.round` is the round just sent: the N of round-N.md, as it is.
        const markdown = renderSeriesNotesFile({
          series: stored.name,
          job: job.name,
          round: job.round,
          notes,
        });
        if (markdown === null) {
          logger.info(ids, 'no review note to add to the series');
          return;
        }
        // Never made here: a series folder that is gone stays gone.
        const seriesDir = seriesDirFor(inboxPath, job.client, stored.name);
        if (!(await isDirectory(seriesDir))) {
          logger.warn({ ...ids, seriesDir }, 'the series folder is missing');
          return;
        }
        const name = await writeUnderFreeName(
          seriesDir,
          styleNotesFileName(job.name, job.round),
          markdown,
        );
        const outcome = await series.addNotes(stored.id, job.id, [
          { name, size: Buffer.byteLength(markdown) },
        ]);
        if (!outcome.ok) {
          logger.warn(
            { ...ids, status: outcome.status, error: outcome.error },
            'could not add the review notes to the series',
          );
          return;
        }
        logger.info(
          { ...ids, file: name },
          'review notes written into the series folder: they wait for the episode’s approval',
        );
      } catch (err) {
        logger.warn({ ...ids, err }, 'could not add the review notes to the series');
      }
    },
  };
}
