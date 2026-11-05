// Add to style (Phase 3 §7, W7): on Send, the notes the owner marked "Add to style" become one Markdown
// file in the client's _Style folder, and one Read pass in add mode (Phase 2's C3) turns them into
// rules in style.md. Through the same path as an upload (`addStyleFiles`), so the _Style watcher
// doesn't queue it again. Never throws: Send must not fail because of the style.
//
// Send awaits `append`, so it returns once the pass is queued; the pass itself runs on the style
// worker, one at a time, behind the pass that is running now if there is one. A pass that fails
// shows on the client's Style page like any other.

import { writeFile } from 'node:fs/promises';
import { renderStyleNotesFile, styleNotesFileName } from '@studio/shared';
import { type RunnerLogger, SILENT_LOGGER } from '../pipeline/claude-process.js';
import type { StyleNotesHook } from '../review/review-service.js';
import { type AddStyleFilesDeps, addStyleFiles } from './add-style-files.js';

export interface StyleNotesOptions {
  /** What `addStyleFiles` needs: the inbox, the style repository, the style worker, the Finder drops. */
  styleFiles: AddStyleFilesDeps;
  /** Default silent. */
  logger?: RunnerLogger;
}

export function createStyleNotes(options: StyleNotesOptions): StyleNotesHook {
  const { styleFiles, logger = SILENT_LOGGER } = options;
  return {
    async append(job, notes) {
      const ids = { jobId: job.id, clientId: job.clientId };
      try {
        // `job.round` is the round just sent: the N of round-N.md, as it is.
        const markdown = renderStyleNotesFile({ job: job.name, round: job.round, notes });
        if (markdown === null) {
          logger.info(ids, 'no review note to add to the style');
          return;
        }
        const { fileNames } = await addStyleFiles(
          { ...styleFiles, logger: styleFiles.logger ?? logger },
          {
            clientId: job.clientId,
            client: job.client,
            files: [
              {
                name: styleNotesFileName(job.name, job.round),
                write: (path) => writeFile(path, markdown),
              },
            ],
            mode: 'add',
            whileAnalysing: 'queue',
          },
        );
        logger.info({ ...ids, file: fileNames[0] }, 'review notes added to the style');
      } catch (err) {
        logger.warn({ ...ids, err }, 'could not add the review notes to the style');
      }
    },
  };
}
