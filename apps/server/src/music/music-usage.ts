// The usage line of the music (Soundtrack plan, "The engine"): one `music` line in
// <dataDir>/usage.jsonl for every version ElevenLabs made, "Made music v2 for <client> / <job>
// (0:39)", no tokens. A version is made by the edit or revise run (found in music.json once the
// run ends) or by Make another (found when the engine's call ends); both come through here, and a
// version is logged once.
//
// How a version is not counted twice: the usage log itself is the memory. A version is already
// logged when the log has a `music` line for the same job that says "Made music <id> for …" and was
// written at or after the version's `madeAt`. The `madeAt` part keeps a job that was deleted and
// made again (its versions start at v1 again) from being skipped. Nothing else is stored.
//
// Versions made by the fake path (`model: 'fake'`: the fake runner, STUDIO_RUNNER=fake) are never
// logged: they cost nothing.

import type { Job, MusicRecord, MusicVersion, UsageEntry } from '@studio/shared';
import type { RunnerLogger } from '../pipeline/claude-process.js';
import { musicUsage } from '../usage/app-usage.js';
import { logAppUsage, readUsageLog } from '../usage/usage-log.js';

/** The model name the music script writes for a version made without ElevenLabs. */
export const FAKE_MUSIC_MODEL = 'fake';

type JobRef = Pick<Job, 'id' | 'client' | 'name'>;

/** Logs the versions of `record` that are not in the usage log yet. Never rejects. */
export type MusicUsageLogger = (job: JobRef, record: MusicRecord) => Promise<void>;

export interface MusicUsageOptions {
  /** Config.dataDir: the log is <dataDir>/usage.jsonl. */
  dataDir: string;
  home: string;
  env: Record<string, string | undefined>;
  logger: RunnerLogger;
}

/** Whether the usage log already has the line of `version` of `job`. */
export function versionIsLogged(
  entries: readonly UsageEntry[],
  job: Pick<Job, 'id'>,
  version: Pick<MusicVersion, 'id' | 'madeAt'>,
): boolean {
  const prefix = `Made music ${version.id} for `;
  const madeAt = Date.parse(version.madeAt);
  return entries.some(
    (entry) =>
      entry.tag === 'music' &&
      entry.job?.id === job.id &&
      entry.did.startsWith(prefix) &&
      !(Date.parse(entry.at) < madeAt),
  );
}

export function createMusicUsageLogger(options: MusicUsageOptions): MusicUsageLogger {
  const { dataDir, home, env, logger } = options;
  // One at a time, so two callers that see the same version cannot both log it.
  let chain: Promise<unknown> = Promise.resolve();

  async function logNew(job: JobRef, record: MusicRecord): Promise<void> {
    const made = record.versions.filter((version) => version.model !== FAKE_MUSIC_MODEL);
    if (made.length === 0) return;
    const entries = await readUsageLog(dataDir);
    for (const version of made) {
      if (versionIsLogged(entries, job, version)) continue;
      await logAppUsage({ dataDir, home, env, logger }, musicUsage(job, version), null);
    }
  }

  return (job, record) => {
    const run = chain.then(() => logNew(job, record));
    chain = run.catch(() => {});
    return run.catch((err: unknown) => {
      logger.warn({ err, jobId: job.id }, 'could not log the usage of the music');
    });
  };
}
