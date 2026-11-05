// Share video on the phone (PH15, boards MJobSheet "approved" and MJobSheetSent, canvas page
// Mobile): an Approved job's MP4 goes to the client through the iPhone share sheet (straight to
// WhatsApp), and the sheet then asks "Sent it to <client>?" with Mark delivered.
//
// Share replaces Download MP4 everywhere on the phone (U16): the same flow also serves a Delivered
// or Paid job's MP4 (fetched on the first tap, "Preparing the video…", then a second tap shares: ~30
// MB is not fetched for every sheet that opens) and the Review's small preview MP4 (fetched when it
// is ready). Only the Approved job asks "Sent it to <client>?" afterwards.
//
// iOS lets `navigator.share` open the share sheet only inside the tap that asks for it, and
// downloading 30 MB after the tap can use up that permission. So the sheet fetches the MP4 as soon
// as it opens ("Getting the video · 12 of 27 MB"), keeps it as a `File`, and the tap on Share video
// calls `share` with nothing awaited before it. A browser that cannot share a file (or a fetch that
// failed) gets Download MP4 instead.
//
//   idle ──start──▶ getting ──got──▶ ready ──share──▶ sharing ──shared──▶ asking
//                      │                ▲                │                  │
//                      │                ├───cancelled────┤                  ├─ Not yet ─▶ ready
//                      │                └────refused─────┘                  └─ the job is delivered
//                      ├──got, but the browser can't share it──▶ unsupported   (left) ─▶ ready
//                      └──failed──▶ failed
//
// Pure: the helpers that reach the browser take its `fetch` and `navigator` as parameters, so every
// state is tested in node with fakes. `use-share-video.ts` runs it in the sheet.

import { isFolderDeleted, type Job, type MoneyPriceResponse } from '@studio/shared';
import { downloadUrl, previewVideoUrl } from '@/data';
import { deliveredMonth, formatPrice, monthName } from '@/features/jobs/delivery-text';

/** Where the share flow is. `unsupported` and `failed` show Download MP4 instead of Share video. */
export type ShareFlow =
  /** Nothing asked yet (the job is not one to share, or the fetch has not started). */
  | { phase: 'idle' }
  /** The MP4 is on its way: `loaded` of `total` bytes (`total` unknown until the answer says). */
  | { phase: 'getting'; loaded: number; total: number | null }
  /** The MP4 is in hand: Share video. */
  | { phase: 'ready'; file: File }
  /** The share sheet is open. */
  | { phase: 'sharing'; file: File }
  /** It was shared: "Sent it to <client>?", Not yet and Mark delivered. */
  | { phase: 'asking'; file: File }
  /** This browser cannot share a file: Download MP4. */
  | { phase: 'unsupported' }
  /** The MP4 could not be fetched: Download MP4, with the reason. */
  | { phase: 'failed'; message: string };

export type ShareEvent =
  | { type: 'start'; total: number | null }
  | { type: 'progress'; loaded: number; total: number | null }
  /** The MP4 arrived; `shareable` is what `canShare` said of it. */
  | { type: 'got'; file: File; shareable: boolean }
  | { type: 'failed'; message: string }
  /** The browser cannot share files at all (found before fetching anything). */
  | { type: 'unsupported' }
  /** Share video was tapped: the share sheet opens. */
  | { type: 'share' }
  /** The share sheet closed with the video sent; `ask` false (not an Approved job) goes back to ready. */
  | { type: 'shared'; ask?: boolean }
  /** The share sheet was closed without sending (AbortError). */
  | { type: 'cancelled' }
  /** The share sheet did not open, or failed (any other error). */
  | { type: 'refused' }
  /** Not yet, on "Sent it to <client>?". */
  | { type: 'not-yet' }
  /** The job is no longer Approved (it was marked delivered): the question is answered. */
  | { type: 'left' };

export const SHARE_IDLE: ShareFlow = { phase: 'idle' };

/** The next state of the share flow. An event that does not apply to the state leaves it as it is. */
export function shareFlow(state: ShareFlow, event: ShareEvent): ShareFlow {
  switch (event.type) {
    case 'start':
      return { phase: 'getting', loaded: 0, total: event.total };
    case 'progress':
      return state.phase === 'getting'
        ? { phase: 'getting', loaded: event.loaded, total: event.total ?? state.total }
        : state;
    case 'got':
      if (state.phase !== 'getting') return state;
      return event.shareable ? { phase: 'ready', file: event.file } : { phase: 'unsupported' };
    case 'failed':
      return state.phase === 'getting' ? { phase: 'failed', message: event.message } : state;
    case 'unsupported':
      return { phase: 'unsupported' };
    case 'share':
      return state.phase === 'ready' ? { phase: 'sharing', file: state.file } : state;
    case 'shared':
      if (state.phase !== 'sharing') return state;
      return event.ask === false
        ? { phase: 'ready', file: state.file }
        : { phase: 'asking', file: state.file };
    case 'cancelled':
    case 'refused':
      return state.phase === 'sharing' ? { phase: 'ready', file: state.file } : state;
    case 'not-yet':
    case 'left':
      return state.phase === 'asking' ? { phase: 'ready', file: state.file } : state;
  }
}

/** The file in hand, if any: what Free on close lets go of. */
export function fileOf(state: ShareFlow): File | null {
  return 'file' in state ? state.file : null;
}

// --- what is shared ------------------------------------------------------------------------------

/** What the sheet fetches and shares: an MP4's address, file name and size. */
export interface ShareTarget {
  /** `GET /api/jobs/:id/download` (the finished video), or the preview MP4's address. */
  url: string;
  /** The name it is shared under: `<job name>.mp4`, or `<job name> (preview).mp4`. */
  fileName: string;
  /** The MP4's size, for "of 27 MB" until the answer says its length; `null` when not known. */
  sizeBytes: number | null;
  /**
   * Words to share with the video (Songs: the line for adding the song in Instagram, with the file
   * that has no song). Left out for a video shared alone. iOS hands them to the app that is picked;
   * an app that takes only the file drops them.
   */
  text?: string;
}

/** Which video of a job: its finished export, or the preview the Review plays. */
export type ShareKind = 'export' | 'preview';

/** The round and the music and quick-fix revisions the preview MP4 is asked for (`previewVideoUrl`). */
export interface PreviewShare {
  round: number;
  musicRev?: number | undefined;
  fixRev?: number | undefined;
}

/**
 * The video to share for a job, or `null` when there is none:
 *
 * - `'export'`: any ready job that has its MP4 and its folder (Approved, Delivered, Paid, a series
 *   episode), at the Mac download's address, named `<job name>.mp4`.
 * - `'preview'`: the Review's small preview MP4 for `preview.round` (the Review only asks once it
 *   is ready), named `<job name> (preview).mp4`.
 */
export function shareTargetFor(job: Job, kind: 'export'): ShareTarget | null;
export function shareTargetFor(
  job: Pick<Job, 'id' | 'name'>,
  kind: 'preview',
  preview: PreviewShare,
): ShareTarget;
export function shareTargetFor(
  job: Job | Pick<Job, 'id' | 'name'>,
  kind: ShareKind,
  preview?: PreviewShare,
): ShareTarget | null {
  if (kind === 'preview') {
    if (preview === undefined) return null;
    return {
      url: previewVideoUrl(job.id, preview.round, {
        musicRev: preview.musicRev,
        fixRev: preview.fixRev,
      }),
      fileName: `${job.name} (preview).mp4`,
      sizeBytes: null,
    };
  }
  if (!('state' in job) || job.state !== 'ready' || job.output === null) return null;
  if (isFolderDeleted(job)) return null;
  return {
    url: downloadUrl(job.id),
    fileName: `${job.name}.mp4`,
    sizeBytes: job.output.sizeBytes,
  };
}

// --- the button's words --------------------------------------------------------------------------

/** Under a Download MP4 that stands in because this browser cannot share a file. */
export const SHARE_UNSUPPORTED_REASON = 'This browser can’t share files, so it downloads instead.';

/** Under a Download MP4 that stands in because the video could not be fetched. */
export const SHARE_FAILED_REASON = (message: string): string =>
  `Couldn’t get the video to share: ${message}`;

/** "27": whole megabytes, rounded as the sheet's "27 MB" is (`fileSize`). */
const megabytes = (bytes: number): number => Math.round(bytes / 1e6);

/**
 * The button while the MP4 comes in: "Getting the video · 12 of 27 MB", and how full its fill is
 * (0 to 100). Without a size, or under a megabyte, it is "Getting the video…". A row that waits for
 * a tap before fetching (a Delivered or Paid job) says "Preparing the video" instead (`verb`).
 */
export function gettingLabel(
  loaded: number,
  total: number | null,
  verb: 'Getting' | 'Preparing' = 'Getting',
): { label: string; pct: number } {
  if (total === null || total <= 0) return { label: `${verb} the video…`, pct: 0 };
  const pct = Math.max(0, Math.min(100, Math.floor((loaded / total) * 100)));
  if (total < 1e6) return { label: `${verb} the video…`, pct };
  const of = megabytes(total);
  return {
    label: `${verb} the video · ${Math.min(megabytes(loaded), of)} of ${of} MB`,
    pct,
  };
}

/**
 * The line under "Sent it to <client>?": "Mark it delivered, and ₪40 counts in October.", with the
 * price Mark delivered would record and the month it counts in, from the money data (`GET
 * /api/money/price`). Until that answer is in (or without it) the month is this one on the
 * browser's calendar and the price is left out: "Mark it delivered, and it counts in October."
 */
export function sentItLine(price: MoneyPriceResponse | undefined, now: Date): string {
  if (price === undefined) {
    return `Mark it delivered, and it counts in ${deliveredMonth({ deliveredAt: now.toISOString() })}.`;
  }
  const amount = formatPrice(price.price, price.currency);
  return `Mark it delivered, and ${amount} counts in ${monthName(price.month)}.`;
}

// --- the browser ---------------------------------------------------------------------------------

/** What the share flow needs of `navigator` (Web Share Level 2); a test passes a fake. */
export interface ShareNavigator {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
}

/**
 * Whether this browser can share a file like `file` (iPhone Safari can, desktop browsers mostly
 * cannot). Before fetching, a stand-in with no bytes asks the same question, so a browser that
 * cannot share never downloads the video for nothing.
 */
export function canShareFile(nav: ShareNavigator | undefined, file: File): boolean {
  if (nav === undefined || typeof nav.share !== 'function') return false;
  if (typeof nav.canShare !== 'function') return false;
  try {
    return nav.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/** A file with the MP4's name and type and no bytes: what `canShareFile` asks about before fetching. */
export function probeFile(target: Pick<ShareTarget, 'fileName'>): File {
  return new File([], target.fileName, { type: 'video/mp4' });
}

/** How the share sheet closed: sent, closed without sending, or not opened at all. */
export type ShareOutcome = 'shared' | 'cancelled' | 'refused';

/**
 * Opens the share sheet with the MP4. It calls `nav.share` before anything is awaited, so it must
 * be called from the tap itself: iOS refuses a share that is not inside a tap. `text` goes with the
 * file as the share text (a song's line for Instagram) when there is one. An AbortError is the
 * person closing the sheet without sending; any other error (NotAllowedError when iOS no longer
 * counts the tap, a type it will not share) is `refused`, with the error.
 */
export async function shareFile(
  nav: ShareNavigator,
  file: File,
  text?: string,
): Promise<{ outcome: ShareOutcome; error?: unknown }> {
  try {
    if (typeof nav.share !== 'function') throw new Error('This browser cannot share files.');
    await nav.share(
      text === undefined || text === '' ? { files: [file] } : { files: [file], text },
    );
    return { outcome: 'shared' };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { outcome: 'cancelled' };
    return { outcome: 'refused', error };
  }
}

/**
 * The file name a `Content-Disposition` header gives (`filename*=UTF-8''…` first, which carries a
 * Hebrew name intact, then `filename="…"`), or `fallback` when it gives none.
 */
export function fileNameOf(disposition: string | null, fallback: string): string {
  if (disposition === null) return fallback;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded !== undefined) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      // A name that is not valid percent-encoding: try the plain one.
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(disposition)?.[1];
  return plain !== undefined && plain !== '' ? plain : fallback;
}

/** What `getVideo` reports while it reads: the bytes so far, and the length when known. */
export type VideoProgress = (loaded: number, total: number | null) => void;

/**
 * Fetches the MP4 at `target.url` as a `File` with the Mac download's name, reporting progress as
 * the bytes arrive (the answer's Content-Length, else the export's size). `signal` stops it (the
 * sheet closed). Rejects with the server's error text, or a plain one, when the answer is not the
 * video.
 */
export async function getVideo(
  target: ShareTarget,
  {
    fetch: fetchVideo = fetch,
    signal,
    onProgress,
  }: { fetch?: typeof fetch; signal?: AbortSignal; onProgress?: VideoProgress } = {},
): Promise<File> {
  const response = await fetchVideo(target.url, { signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const said = typeof body?.error === 'string' ? body.error : null;
    throw new Error(said ?? `The video could not be fetched (${response.status}).`);
  }
  const length = Number(response.headers.get('Content-Length'));
  const total = Number.isFinite(length) && length > 0 ? length : target.sizeBytes;
  const name = fileNameOf(response.headers.get('Content-Disposition'), target.fileName);

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  if (response.body === null) {
    chunks.push(new Uint8Array(await response.arrayBuffer()));
  } else {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(loaded, total);
    }
  }
  return new File(chunks as BlobPart[], name, { type: 'video/mp4' });
}
