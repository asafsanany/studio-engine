// The stand-in preview maker of STUDIO_RUNNER=fake (LUTs plan, "Previews"). OWNER: LU2.
//
// It needs no ffmpeg: the "after" is the "before" frame, copied into the cache, so dev, tests and
// e2e get the same files and the same routes and caches as the real maker, and the same answer
// every time.

import { copyFile } from 'node:fs/promises';
import type { WorkerLogger } from '../pipeline/worker.js';
import { lutFrameFile } from './lut-frames.js';
import { type LutPreviews, lutPreviewPath } from './lut-previews.js';
import { createQueuedPreviews } from './lut-still-queue.js';

export interface FakeLutPreviewsOptions {
  /** `<data>`, whose `lut-previews/` is the cache. */
  dataDir: string;
  logger?: WorkerLogger;
}

/** The fake maker: the "after" of a LUT is a copy of the plain frame. */
export function createFakeLutPreviews(options: FakeLutPreviewsOptions): LutPreviews {
  const { dataDir, logger } = options;
  return createQueuedPreviews({
    concurrency: 8,
    logger,
    pathFor: (source, frame, side) => lutPreviewPath(dataDir, source, frame, side),
    make: (source, frame, outPath) => copyFile(lutFrameFile(frame, 'before', source.kind), outPath),
  });
}
