import { useCallback, useEffect, useRef, useState } from 'react';
import { reviewExportUrl } from '@/data';

export type ReviewExportState = 'idle' | 'making' | 'ready' | 'failed';

const POLL_MS = 3_000;

function stateOf(body: { state?: string }): ReviewExportState {
  if (body.state === 'ready') return 'ready';
  if (body.state === 'making') return 'making';
  if (body.state === 'failed') return 'failed';
  return 'idle';
}

/**
 * One ask of the engine about the export of a job's format (`formatId`: an extra format's id, `null`
 * or left out for the main one): `start` makes it render (POST), otherwise it only asks (GET). An
 * answer the page cannot use is `failed` (the button offers a new try); a 404 (nothing to export,
 * or a size the job no longer has) is `idle`.
 */
export async function askReviewExport(
  jobId: string,
  formatId: string | null | undefined,
  start: boolean,
): Promise<ReviewExportState> {
  try {
    const response = await fetch(reviewExportUrl(jobId, '', formatId), {
      method: start ? 'POST' : 'GET',
      cache: 'no-store',
    });
    if (response.ok) return stateOf((await response.json()) as { state?: string });
    if (response.status === 404) return 'idle';
  } catch {
    // Unreachable: the button offers a new try.
  }
  return 'failed';
}

/**
 * The full-quality MP4 of a job in Review. Opening the dialog only asks (a render made earlier in
 * this round shows `ready`); `start` makes the engine render it, and the hook asks again every 3 s
 * until it is `ready` or `failed`. A new round or music pick (`version`) asks again, since its edit makes the old
 * file stale.
 *
 * On a job with two formats (Formats, C65) each format has an export of its own: `formatId` is the
 * extra format on show (`null` for the main one, which also is every job with one format). Showing
 * the other format asks about its export; an answer that arrives for the format that was on show a
 * moment ago is dropped.
 */
export function useReviewExport(
  jobId: string,
  version: number | string,
  formatId: string | null = null,
) {
  const [state, setState] = useState<ReviewExportState>('idle');
  // Counts the times the question changed (another job, round, music or format) and the page went
  // away: an answer to an older question is not the answer to this one.
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const ask = useCallback(
    async (start: boolean, asked: number) => {
      const next = await askReviewExport(jobId, formatId, start);
      if (asked !== generation.current) return;
      setState(next);
      if (next === 'making') timer.current = setTimeout(() => void ask(false, asked), POLL_MS);
    },
    [jobId, formatId],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `version` makes the old file stale, so ask again
  useEffect(() => {
    generation.current += 1;
    const asked = generation.current;
    setState('idle');
    void ask(false, asked);
    return () => {
      generation.current += 1;
      clearTimeout(timer.current);
    };
  }, [ask, version]);

  const start = useCallback(() => {
    clearTimeout(timer.current);
    setState('making');
    void ask(true, generation.current);
  }, [ask]);

  return { state, start };
}
