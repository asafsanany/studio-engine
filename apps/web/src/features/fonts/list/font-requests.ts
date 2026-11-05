import type { FontRequest, Job } from '@studio/shared';

// The words and the pick of the banner on top of the Fonts page (board FOPage `start=missing`, and
// FOStates 9, "A note asked for a font you don’t have"; Fonts plan, FN16): a note named a font the
// library does not have, the edit did not wait and used the closest font it has, and the banner
// stays until the font is imported, or until the owner says it was never a font ("Not a font", C52:
// then the bar moves on to the next request). The server sends the requests that are open and newer than
// seven days; this picks the one to show and counts the rest. While the job that asked is still
// editing the sentence says the edit "is using" the closest font (C51: the run has not finished);
// once it has, "used". When the page does not know the job's state, it keeps "used".

export const MISSING_FONT_TEXT = {
  asked: ' asked for ',
  // The board names the font the edit used ("so the edit used Heebo Bold"); the engine does not
  // know which one the run chose, so the banner says it used the closest font it has.
  rest: ' in a note. It isn’t in your library, so the edit used the closest font it has.',
  /** The same sentence while the job's run is still going. */
  restRunning:
    ' in a note. It isn’t in your library, so the edit is using the closest font it has.',
  import: 'Import fonts',
  /** C52: the word after the @ was never a font ("send it to @Falcon"). */
  dismiss: 'Not a font',
  /** The hint on "Not a font": what pressing it does. */
  dismissHint: 'That word was not a font. This bar will not ask about it again for this job.',
} as const;

/**
 * Whether the run that asked is still going: the job the request is for is editing now. `false`
 * when the jobs are not known yet, or the job is not among them (a job deleted since, say): the
 * sentence then stays as it always was.
 */
export function requestRunning(
  request: Pick<FontRequest, 'jobId'>,
  jobs: readonly Pick<Job, 'id' | 'state'>[] | undefined,
): boolean {
  return jobs?.find((job) => job.id === request.jobId)?.state === 'editing';
}

/** The newest request first; requests made at the same moment keep the order they came in. */
export function newestFirst(requests: readonly FontRequest[]): FontRequest[] {
  return [...requests].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The request the banner shows and how many others are open; `null` when none is. */
export function bannerRequest(
  requests: readonly FontRequest[],
): { request: FontRequest; others: number } | null {
  const [newest] = newestFirst(requests);
  return newest === undefined ? null : { request: newest, others: requests.length - 1 };
}

/** "(+2 more)": after the sentence, when more than one request is open. */
export function moreText(others: number): string {
  return `(+${others} more)`;
}
