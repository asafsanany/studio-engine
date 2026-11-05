// Jobs that wait for a camera LUT (LUTs build 2, LU10), as the page sees them. OWNER: LU10.
//
// The engine ends such a job as failed, with one plain sentence as its error ("Waiting for a camera
// LUT: the clips are Sony S-Log3."); the page finds the waiting jobs by reading that sentence back
// (`parseCameraLutWait`), so there is no new job state and nothing more to keep in step. Which
// camera LUTs of the library fit a waiting job is the same rule the engine uses (`matchCameraLuts`):
// exactly one that names the footage's curve.
//
// The banner on the LUTs page (board LUPage, state `needed`) shows the first of them:
//   waiting   "<job> is waiting for a camera LUT. Its clips are Sony S-Log3 and none of your LUTs match."
//   ready     "Imported. Resume <job> to use it."          (a camera LUT now names the job's curve)
//   resumed   "Resumed <job>."                              (a moment after Resume)

import {
  type CameraLutCandidate,
  type CameraLutWait,
  cameraCurveLabel,
  cameraLutAskedFor,
  isArchived,
  type Job,
  type LutSummary,
  matchCameraLuts,
  parseCameraLutWait,
} from '@studio/shared';

/** A failed job whose error says it waits for a camera LUT. */
export interface CameraWaitingJob {
  job: Job;
  /** "Ofek · FPV 3": the client and the job, as the board writes them. */
  title: string;
  wait: CameraLutWait;
  /** What the library has for the footage's curve now. */
  fit: CameraLutFit;
}

/**
 * The library's camera LUTs for a waiting job's curve: `ready` (exactly one, which the next run will
 * use by itself), `several` (more than one: the person names one in the job's note), `none`, or
 * `unknown` (the footage does not say which curve, so nothing is matched on its own).
 */
export type CameraLutFit =
  | { kind: 'ready'; lut: Pick<LutSummary, 'slug' | 'name'> }
  | { kind: 'several'; names: string[] }
  | { kind: 'none' }
  | { kind: 'unknown' };

/** "Ofek · FPV 3". */
export function waitingJobTitle(job: Pick<Job, 'client' | 'name'>): string {
  return `${job.client} · ${job.name}`;
}

function candidates(luts: readonly LutSummary[]): CameraLutCandidate[] {
  return luts.map((lut) => ({ slug: lut.slug, name: lut.name, kind: lut.kind, file: null }));
}

/** What the library (Yours and Built in) has for a waiting job's footage. */
export function cameraLutFit(wait: CameraLutWait, luts: readonly LutSummary[]): CameraLutFit {
  if (wait.curve === null) return { kind: 'unknown' };
  const match = matchCameraLuts(wait.curve, candidates(luts));
  if (match.kind === 'one') return { kind: 'ready', lut: match.lut };
  if (match.kind === 'several') return { kind: 'several', names: match.luts.map((l) => l.name) };
  return { kind: 'none' };
}

/**
 * The jobs that wait for a camera LUT, the one that has waited longest first: failed, not archived,
 * with the sentence for an error.
 */
export function cameraWaitingJobs(
  jobs: readonly Job[],
  luts: readonly LutSummary[],
): CameraWaitingJob[] {
  const waiting: CameraWaitingJob[] = [];
  for (const job of jobs) {
    if (job.state !== 'failed' || isArchived(job)) continue;
    const wait = parseCameraLutWait(job.error);
    if (wait === null) continue;
    waiting.push({ job, title: waitingJobTitle(job), wait, fit: cameraLutFit(wait, luts) });
  }
  return waiting.sort((a, b) => Date.parse(a.job.updatedAt) - Date.parse(b.job.updatedAt));
}

/** What the clips are, in the banner's words: "Sony S-Log3" or "log footage". */
export function clipsText(wait: Pick<CameraLutWait, 'curve'>): string {
  return wait.curve === null ? 'log footage' : cameraCurveLabel(wait.curve);
}

/** The banner's second sentence for a job that waits, by what the library has. */
export function waitingExplanation(item: CameraWaitingJob): string {
  const clips = `Its clips are ${clipsText(item.wait)}`;
  switch (item.fit.kind) {
    case 'several':
      return `${clips} and more than one of your camera LUTs match: name one in the job’s note.`;
    case 'unknown':
      return `${clips} and the files do not say which camera. Import its camera LUT, then name it in the job’s note.`;
    default:
      return `${clips} and none of your LUTs match.`;
  }
}

/** How many other jobs wait, said as the banner does: "and 2 other jobs". */
export function otherJobsText(count: number): string {
  return count === 1 ? 'and 1 other job' : `and ${count} other jobs`;
}

/** "Ofek · FPV 3", "Ofek · FPV 3 and Falcon · Reel", "Ofek · FPV 3 and 2 other jobs". */
export function jobsText(titles: readonly string[]): string {
  const [first, second] = titles;
  if (first === undefined) return '';
  if (titles.length === 1) return first;
  if (titles.length === 2 && second !== undefined) return `${first} and ${second}`;
  return `${first} ${otherJobsText(titles.length - 1)}`;
}

/** The dialog's line under its title when it was opened for a job: "For Ofek · FPV 3: a Sony S-Log3 to Rec709 camera LUT." */
export function importForText(title: string, wait: CameraLutWait): string {
  return `For ${title}: ${cameraLutAskedFor(wait)}.`;
}

/** The row's words for a waiting job (instead of "Failed at Cut"). */
export const CAMERA_WAIT_DETAIL = 'Waiting for a camera LUT';

/** The ghost button's label in the row and the job sheet. */
export const IMPORT_LUT_LABEL = 'Import LUT';
