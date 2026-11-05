import { useEffect, useRef, useState } from 'react';
import { previewUrl, previewVideoStatusUrl, previewVideoUrl } from '@/data';

/** `making`: the engine is rendering it; `ready`: play it; `unavailable`: use the live preview. */
export type PreviewVideoState = 'making' | 'ready' | 'unavailable';

export interface PreviewVideo {
  state: PreviewVideoState;
  /** The music `rev` the ready MP4 was asked for, for its address (`previewVideoUrl`'s musicRev). */
  readyRev: number | undefined;
  /** The quick fixes' `rev` it was asked for (`previewVideoUrl`'s fixRev); `undefined` with no fix. */
  readyFixRev?: number | undefined;
}

const POLL_MS = 3_000;

/**
 * What the phone shows after the engine answered `server` about the MP4: `ready` plays it (asked for
 * `musicRev` and `fixRev`); `making` waits only for the first MP4 of this opening (`everReady`
 * false), and after a music change or a quick fix plays the live preview until the new MP4 is ready,
 * so what's picked is what's heard and what's fixed is what's seen.
 */
export function previewVideoAnswer(
  server: PreviewVideoState,
  everReady: boolean,
  musicRev: number | undefined,
  fixRev?: number | null,
): PreviewVideo {
  if (server === 'ready') {
    return { state: 'ready', readyRev: musicRev, readyFixRev: fixRev ?? undefined };
  }
  if (server === 'making')
    return { state: everReady ? 'unavailable' : 'making', readyRev: undefined };
  return { state: 'unavailable', readyRev: undefined };
}

/**
 * The address the phone's player plays: a sample (`src`) as it is; the MP4 once it is ready, with
 * the revs it was made for; otherwise the live preview with the music's and the quick fixes' current
 * revs.
 */
export function phonePreviewSrc({
  jobId,
  round,
  src,
  musicRev,
  fixRev,
  video,
}: {
  jobId: string;
  round: number;
  src: string | undefined;
  musicRev: number | undefined;
  /** The quick fixes' rev (`useReviewFix`); `null` or left out with no fix. */
  fixRev?: number | null;
  video: PreviewVideo;
}): string {
  if (src !== undefined) return src;
  if (video.state === 'ready') {
    return previewVideoUrl(jobId, round, { musicRev: video.readyRev, fixRev: video.readyFixRev });
  }
  return previewUrl(jobId, round, musicRev, '', null, fixRev);
}

/**
 * Whether the small MP4 of the job's preview is ready (the phone plays it instead of the live
 * composition, which lags there). The first ask makes the engine start the render; asking again
 * every 3 s tells when it is done. A failed render, a missing preview or an unreachable engine is
 * `unavailable`: the phone falls back to the live preview. `enabled` false asks nothing.
 *
 * `musicRev` (Soundtrack) is the music's rev: when it changes the engine renders the MP4 again with
 * the new music.mp3. Until that one is ready the answer is `unavailable`, so the live preview plays
 * the music that was picked; `making` (the "Making the preview video…" wait) is only for the first
 * MP4 of this opening. `fixRev` (Quick fixes) does the same for a fix that landed: the engine
 * renders the changed composition again, and the live preview plays meanwhile.
 */
export function usePreviewVideo(
  jobId: string,
  enabled: boolean,
  musicRev?: number,
  fixRev?: number | null,
): PreviewVideo {
  const [answer, setAnswer] = useState<PreviewVideo>({ state: 'making', readyRev: undefined });
  const everReady = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function ask() {
      let next: PreviewVideoState = 'unavailable';
      try {
        const response = await fetch(previewVideoStatusUrl(jobId), { cache: 'no-store' });
        if (response.ok) {
          const body = (await response.json()) as { state?: string };
          next =
            body.state === 'ready' ? 'ready' : body.state === 'making' ? 'making' : 'unavailable';
        }
      } catch {
        // Unreachable: the live preview.
      }
      if (gone) return;
      setAnswer(previewVideoAnswer(next, everReady.current, musicRev, fixRev));
      if (next === 'ready') everReady.current = true;
      if (next === 'making') timer = setTimeout(() => void ask(), POLL_MS);
    }
    void ask();
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [jobId, enabled, musicRev, fixRev]);

  return answer;
}
