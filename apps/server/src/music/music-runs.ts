// The runner with the music looked at after every edit or revise run (Soundtrack plan, "The
// engine"): the edit run may have made music itself (it calls the music script from Bash), so once
// it has ended the music service logs the versions in the usage log and tells the page the job's
// music (`job.music`). Like `withGraphicUses`, it is a Runner around the engine's: the outcome is the
// runner's own whatever the hook does, and a hook that throws is only logged.
//
// It runs after a failed or stopped run too: the music was paid for even if the video was not
// finished. A render run edits nothing, so it is left alone.

import type { Job } from '@studio/shared';
import type { Runner } from '../pipeline/runner.js';
import type { WorkerLogger } from '../pipeline/worker.js';

const SILENT: WorkerLogger = { info() {}, warn() {}, error() {} };

export function withMusicRuns(
  runner: Runner,
  afterRun: (job: Job) => Promise<unknown>,
  logger: WorkerLogger = SILENT,
): Runner {
  return {
    async start(job, mode, context) {
      try {
        return await runner.start(job, mode, context);
      } finally {
        if (job.runKind === 'edit' || job.runKind === 'revise') {
          try {
            await afterRun(job);
          } catch (err) {
            logger.warn({ err, jobId: job.id }, 'could not look at the music the run left');
          }
        }
      }
    },
  };
}
