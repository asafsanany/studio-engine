// Types of song-beats.mjs, the beat finder of the song measuring (Songs, SG3 and SG10).

import type { HyperframesAudio } from './song-part.mjs';

export const HYPERFRAMES_TIMEOUT_MS: number;

/** The beats from `npx hyperframes audio … --json` on a WAV: `data` is `null` (with `why`) when it did not run. */
export function findBeats(
  wav: string,
  env: Record<string, string | undefined>,
  cwd: string,
  options: {
    /** The caller's lookup for `npx` on this Mac. */
    findTool: (name: string, env: Record<string, string | undefined>) => string | null;
    timeoutMs?: number;
  },
): Promise<{ data: HyperframesAudio | null; why: string | null }>;
