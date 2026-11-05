import { useEffect, useReducer, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  canShareFile,
  getVideo,
  probeFile,
  SHARE_IDLE,
  type ShareFlow,
  type ShareNavigator,
  type ShareTarget,
  shareFile,
  shareFlow,
} from './share-video';

export interface ShareVideoOptions {
  /**
   * Fetch the MP4 as soon as there is one to share (an Approved job's sheet, the Review's preview).
   * Off, the first tap on Share fetches it ("Preparing the video…") and a second one shares it: a
   * Delivered or Paid job's sheet does not pull ~30 MB each time it opens.
   */
  eager: boolean;
  /** After a share, ask "Sent it to <client>?" (an Approved job only); otherwise back to Share. */
  asks: boolean;
}

export interface ShareVideo {
  /** Where the flow is (share-video.ts). */
  flow: ShareFlow;
  /** What is shared: the job's MP4 (or its preview's), or `null` when there is none. */
  target: ShareTarget | null;
  /**
   * Share video. From idle (a lazy flow) it starts fetching the MP4; once the MP4 is in hand it
   * opens the share sheet with it, so call it from the tap itself.
   */
  share: () => void;
  /** Not yet, on "Sent it to <client>?": back to Share video. */
  notYet: () => void;
}

/** The browser's navigator, or none (node, in tests). */
function browserNavigator(): ShareNavigator | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Where the flow starts: a browser that can't share the video says so from the first frame (Download
 * MP4, no bar that flashes first); otherwise idle until the fetch starts.
 */
function initialFlow(target: ShareTarget | null): ShareFlow {
  if (target === null || canShareFile(browserNavigator(), probeFile(target))) return SHARE_IDLE;
  return { phase: 'unsupported' };
}

/**
 * How full the bar is, to the percent (to the megabyte while the length is unknown): the bar is
 * drawn again only when this changes, not for each of the hundreds of chunks a video comes in.
 */
function progressStep(loaded: number, total: number | null): number {
  return total === null || total <= 0
    ? Math.floor(loaded / 1e6)
    : Math.floor((loaded / total) * 100);
}

/**
 * The share flow of the phone for `target` (share-video.ts): the job sheet's (an Approved job's big
 * button, a Delivered or Paid job's row) and the Review's preview icon. It lives as long as its
 * screen:
 *
 * - Eager (`options.eager`): when there is a target and this browser can share a file, it fetches
 *   the MP4 at once, so the tap on Share video only has to open the share sheet. A browser that
 *   cannot share a file fetches nothing (Download MP4).
 * - Lazy: the first `share()` starts the fetch (Preparing the video…); the next one shares.
 * - The video is fetched once per address. The fetch stops, and the file in hand is let go of, when
 *   the screen closes (it unmounts with it): nothing outlives it, and no object URL is made.
 * - With `options.asks` (an Approved job), once the job leaves Approved (Mark delivered, here or
 *   anywhere) "Sent it to <client>?" is answered; Undo brings back Share video with the file still
 *   in hand. Without it, a share that was sent goes straight back to Share video.
 * - A share sheet that does not open says why in a message; one closed without sending is silent.
 */
export function useShareVideo(
  target: ShareTarget | null,
  { eager, asks }: ShareVideoOptions,
): ShareVideo {
  const url = target?.url ?? null;
  const [flow, dispatch] = useReducer(shareFlow, target, initialFlow);
  // A lazy flow starts fetching once Share was tapped.
  const [tapped, setTapped] = useState(false);
  // Once wanted it stays wanted: Mark delivered turns an Approved job's eager flow into a lazy one
  // while its fetch may still be on its way, and that fetch must not be dropped.
  const fetchWanted = useRef(false);
  if (eager || tapped) fetchWanted.current = true;
  const go = fetchWanted.current;

  // The question is answered once the job is no longer Approved.
  useEffect(() => {
    if (!asks) dispatch({ type: 'left' });
  }, [asks]);

  // The target of this render, for the fetch below (which must not restart when the job object
  // is replaced by a newer copy of the same job).
  const latest = useRef(target);
  latest.current = target;
  // The address of the video in hand: it is not fetched again (Undo after Mark delivered).
  const inHand = useRef<string | null>(null);

  useEffect(() => {
    const wanted = latest.current;
    if (!go || url === null || wanted === null || inHand.current === url) return;
    const nav = browserNavigator();
    if (!canShareFile(nav, probeFile(wanted))) {
      dispatch({ type: 'unsupported' });
      return;
    }
    const controller = new AbortController();
    dispatch({ type: 'start', total: wanted.sizeBytes });
    let step = -1;
    getVideo(wanted, {
      signal: controller.signal,
      onProgress: (loaded, total) => {
        const next = progressStep(loaded, total);
        if (next === step) return;
        step = next;
        dispatch({ type: 'progress', loaded, total });
      },
    }).then(
      (file) => {
        inHand.current = wanted.url;
        dispatch({ type: 'got', file, shareable: canShareFile(nav, file) });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        dispatch({ type: 'failed', message: messageOf(error) });
      },
    );
    return () => controller.abort();
  }, [url, go]);

  return {
    flow,
    target,
    share() {
      if (flow.phase === 'idle') {
        // Lazy: this tap fetches the video; the next one shares it.
        setTapped(true);
        return;
      }
      const nav = browserNavigator();
      if (flow.phase !== 'ready' || nav === undefined) return;
      dispatch({ type: 'share' });
      // `shareFile` calls `navigator.share` before it awaits anything: still inside the tap.
      void shareFile(nav, flow.file, target?.text).then(({ outcome, error }) => {
        dispatch(outcome === 'shared' ? { type: 'shared', ask: asks } : { type: outcome });
        if (outcome === 'refused') {
          toast.error('Couldn’t open the share sheet', { description: messageOf(error) });
        }
      });
    },
    notYet() {
      dispatch({ type: 'not-yet' });
    },
  };
}
