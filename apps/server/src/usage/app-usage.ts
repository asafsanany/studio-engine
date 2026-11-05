// The usage tag and the "what it did" line of each run the app starts (CLAUDE.md › Usage tags).

import { formatMusicLength, type Job, type MusicVersion } from '@studio/shared';
import type { SeriesPass, StylePass } from '../clients/style-pass.js';
import type { AppUsage } from './usage-log.js';

type JobRef = Pick<Job, 'id' | 'client' | 'name'>;

function files(count: number): string {
  return `${count} file${count === 1 ? '' : 's'}`;
}

function onJob(job: JobRef, tag: AppUsage['tag'], did: string): AppUsage {
  return { tag, did, client: job.client, job: { id: job.id, name: job.name } };
}

/** An edit, revise or render run, tagged with its run kind. */
export function jobRunUsage(job: JobRef & Pick<Job, 'runKind' | 'round'>): AppUsage {
  const where = `${job.client} / ${job.name}`;
  switch (job.runKind) {
    case 'revise':
      return onJob(job, 'revise', `Revised ${where} (round ${job.round})`);
    case 'render':
      return onJob(job, 'render', `Rendered ${where}`);
    default:
      return onJob(job, 'edit', `Edited ${where}`);
  }
}

/** The Brief run is part of the job's edit. */
export function briefUsage(job: JobRef): AppUsage {
  return onJob(job, 'edit', `Wrote the brief for ${job.client} / ${job.name}`);
}

/**
 * The Generate run of a job with no footage (Generated videos): planning the shots and making the
 * voice and the clips with the two scripts. Tagged `generate`; the money the scripts spend is
 * Higgsfield's and ElevenLabs', not Claude's, and is on the job (`job_generate`).
 */
export function generateUsage(job: JobRef): AppUsage {
  return onJob(job, 'generate', `Planned and made the shots for ${job.client} / ${job.name}`);
}

export function stylePassUsage(client: string, pass: StylePass): AppUsage {
  if (pass.kind === 'read') {
    return {
      tag: 'style-read',
      did: `Read ${files(pass.files.length)} into ${client}'s style`,
      client,
    };
  }
  return {
    tag: 'style-learn',
    did: `Learned ${client}'s style from ${pass.job}`,
    client,
    job: { id: pass.jobId, name: pass.job },
  };
}

/**
 * A series pass. (`series-read`, which read review notes into series.md at Send, is no longer run
 * since C26; its tag stays in the list for the lines already logged.)
 */
export function seriesPassUsage(client: string, pass: SeriesPass): AppUsage {
  const did =
    pass.mode === 'start'
      ? `Started the series ${pass.series} from ${pass.job}`
      : pass.notes === undefined
        ? `Made ${pass.job} the format of the series ${pass.series}`
        : `Made ${pass.job} the format of the series ${pass.series} after its review notes`;
  return { tag: 'series', did, client, job: { id: pass.jobId, name: pass.job } };
}

/** A review voice note turned into text (ElevenLabs, no Claude session). */
export function transcribeUsage(job: JobRef): AppUsage {
  return onJob(job, 'transcribe', `Transcribed a voice note for ${job.client} / ${job.name}`);
}

/** A voice note in a graphic's chat turned into text (ElevenLabs, no Claude session). */
export function graphicVoiceUsage(): AppUsage {
  return { tag: 'transcribe', did: 'Transcribed a voice note for a graphic' };
}

/** The background pass that gives the sent review notes their topics (Analytics). */
export function noteTopicsUsage(noteCount: number): AppUsage {
  return {
    tag: 'note-topics',
    did: `Grouped ${noteCount} review note${noteCount === 1 ? '' : 's'} into topics`,
  };
}

/** A run of the Graphics library that made (or tried to make) a version of a graphic. */
export function graphicRunUsage(name: string, version: number): AppUsage {
  return { tag: 'graphic', did: `Made v${version} of ${name}` };
}

/**
 * A version of the music made by ElevenLabs for a job (Soundtrack): no Claude session, no tokens.
 * One line per version made, by the edit run or by Make another: "Made music v2 for Horizon FPV /
 * Demo (0:39)".
 */
export function musicUsage(job: JobRef, version: Pick<MusicVersion, 'id' | 'lengthMs'>): AppUsage {
  return onJob(
    job,
    'music',
    `Made music ${version.id} for ${job.client} / ${job.name} (${formatMusicLength(version.lengthMs)})`,
  );
}

/**
 * Sorting one review note with the difficulty index (quick fixes): a short Haiku run, one line per
 * note. Tagged `fix-route`, on the job's client and job.
 */
export function fixRouteUsage(job: JobRef): AppUsage {
  return onJob(job, 'fix-route', `Sorted a review note for ${job.client} / ${job.name}`);
}

/**
 * A quick fix of one review note, done live in Review (quick fixes): one line per run, whether or
 * not it worked. `kind` is what the note asks for, in the router's words ("Changing the caption
 * font"); it is trimmed and left out when empty. Tagged `quick-fix`, on the job's client and job.
 */
export function quickFixUsage(job: JobRef, kind: string): AppUsage {
  const what = kind.trim();
  const where = `${job.client} / ${job.name}`;
  return onJob(
    job,
    'quick-fix',
    what === '' ? `Fixed a review note for ${where}` : `Fixed a review note for ${where}: ${what}`,
  );
}
