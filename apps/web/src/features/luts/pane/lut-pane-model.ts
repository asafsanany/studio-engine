// What the LUT pane decides, apart from how it looks (LUTs plan, "The page (web)"; boards LUPage and
// LUStates): the words, the facts, the address of each still, which frame was last chosen, and the
// load state of one preview. Plain functions, so the tests need no browser.

import {
  LUT_FRAME_CREDITS,
  LUT_FRAME_LABELS,
  LUT_FRAMES,
  LUT_KIND_LABELS,
  type LutDetail,
  type LutFrame,
  type LutPreviewSide,
  lutFrameSchema,
  relativeTime,
} from '@studio/shared';
import { lutPreviewUrl } from '@/data/luts-api';

/** The words of the pane. */
export const LUT_PANE_TEXT = {
  empty: 'Pick a LUT to see it on a frame.',
  gone: 'This LUT could not be opened.',
  before: 'Before',
  beforeCamera: 'Log',
  after: 'After',
  slider: 'Before and after',
  frames: 'Frame',
  notReady: 'Preview not ready.',
  tryAgain: 'Try again',
  cameraNote: 'Camera LUTs expect flat log footage, so this is shown on a log sample of the frame.',
  fixNote: 'Made for footage with one problem, so a clean test frame can look off.',
  addedBuiltIn: 'Comes with the grade',
  useLead: 'To use it, write',
  useTail: 'in a note on a job.',
} as const;

/** The frame on the very first visit. */
export const DEFAULT_LUT_FRAME: LutFrame = 'person';

/** Where the chosen frame is remembered in the browser. */
export const LUT_FRAME_STORAGE_KEY = 'studio.luts.frame';

/** The slider's first position: the divider in the middle. */
export const DEFAULT_LUT_SPLIT = 50;

/** The frame is 9:16, shown at this size in pixels (the board). */
export const LUT_PANE_FRAME = { width: 252, height: 448 } as const;

/** The least of `localStorage` the pane uses, so a test can hand in a stand-in. */
export type FrameStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The browser's storage, or `null` where there is none (a private window, a server). */
export function browserFrameStorage(): FrameStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The frame they chose last time, or the first one when none was stored or it cannot be read. */
export function readStoredFrame(storage: FrameStorage | null = browserFrameStorage()): LutFrame {
  try {
    const parsed = lutFrameSchema.safeParse(storage?.getItem(LUT_FRAME_STORAGE_KEY));
    return parsed.success ? parsed.data : DEFAULT_LUT_FRAME;
  } catch {
    return DEFAULT_LUT_FRAME;
  }
}

/** Remembers the chosen frame. The page works without it, so a failure is silent. */
export function storeFrame(
  frame: LutFrame,
  storage: FrameStorage | null = browserFrameStorage(),
): void {
  try {
    storage?.setItem(LUT_FRAME_STORAGE_KEY, frame);
  } catch {
    // Nothing to do: the choice just is not remembered.
  }
}

/** The chips, in order, with their words. */
export const LUT_FRAME_CHIPS: readonly { frame: LutFrame; label: string }[] = LUT_FRAMES.map(
  (frame) => ({ frame, label: LUT_FRAME_LABELS[frame] }),
);

/** "Photo: Benjamin Combs, Unsplash". */
export function frameCredit(frame: LutFrame): string {
  return `Photo: ${LUT_FRAME_CREDITS[frame]}`;
}

/**
 * Changes whenever the LUT's file (or its kind) does, so a browser that kept an older still asks
 * again. It is the engine's `previewKey` (a hash of the file and the kind), which lets the engine
 * say the still may be cached for good; a detail without one falls back to the file name, its size
 * and the grid, which move when a rename or a replaced file makes the stills different.
 */
export function previewVersion(detail: LutDetail): string {
  if (detail.previewKey) return detail.previewKey;
  return `${detail.file ?? detail.slug}-${detail.bytes ?? 0}-${detail.size}`;
}

/** The address of one still: the server's route, with the version (and a retry count) as `?v=`. */
export function paneImageUrl(
  detail: LutDetail,
  frame: LutFrame,
  side: LutPreviewSide,
  retry = 0,
): string {
  const version = previewVersion(detail) + (retry > 0 ? `-r${retry}` : '');
  return lutPreviewUrl(detail.slug, frame, side, version);
}

/** Where the divider stands, as a whole percent between 0 and 100. */
export function clampSplit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LUT_SPLIT;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** The CSS that clips the after image: everything left of the divider is hidden. */
export function afterClip(split: number): string {
  return `inset(0 0 0 ${clampSplit(split)}%)`;
}

/** The line under the name: the catalog's words, or kind and size for a LUT that has none. */
export function paneDescription(detail: LutDetail): string {
  if (detail.description.trim() !== '') return detail.description;
  return `${LUT_KIND_LABELS[detail.kind]} · ${detail.sizeLabel}`;
}

/** The pill at the left of the frame: a Camera LUT shows the log twin, so it says "Log". */
export function beforeLabel(detail: LutDetail): string {
  return detail.kind === 'camera' ? LUT_PANE_TEXT.beforeCamera : LUT_PANE_TEXT.before;
}

/** The note under the chips, when the kind needs one; the catalog's own note wins for a Fix. */
export function paneNote(detail: LutDetail): string | null {
  if (detail.kind === 'camera') return LUT_PANE_TEXT.cameraNote;
  if (detail.kind === 'fix') return detail.note ?? LUT_PANE_TEXT.fixNote;
  return detail.note;
}

/** One line of the facts. */
export interface PaneFact {
  label: string;
  value: string;
}

/**
 * Kind, Size, File, Used in, Added. "Used in" is left out while notes cannot name a LUT (its count
 * is `null` then); a built-in LUT "comes with the grade", a LUT of Yours says when it came.
 */
export function paneFacts(detail: LutDetail, now: number): PaneFact[] {
  const facts: PaneFact[] = [
    { label: 'Kind', value: LUT_KIND_LABELS[detail.kind] },
    { label: 'Size', value: detail.sizeLabel },
    { label: 'File', value: detail.file ?? '—' },
  ];
  if (detail.usedIn !== null) facts.push({ label: 'Used in', value: detail.usedLabel });
  const added =
    detail.addedAt === null || detail.owner === 'builtIn'
      ? LUT_PANE_TEXT.addedBuiltIn
      : relativeTime(detail.addedAt, now);
  facts.push({ label: 'Added', value: added === '' ? '—' : added });
  return facts;
}

// --- one preview's load state ---------------------------------------------------------------------

/** What the two stills of the shown frame are doing. */
export interface PreviewLoad {
  before: boolean;
  after: boolean;
  failed: boolean;
}

export type PreviewLoadAction =
  | { type: 'loaded'; side: LutPreviewSide }
  | { type: 'failed' }
  | { type: 'reset' };

export const PREVIEW_LOADING: PreviewLoad = { before: false, after: false, failed: false };

/** Both stills must arrive for the frame to show; one that fails sends the whole frame to "not ready". */
export function previewLoadReducer(state: PreviewLoad, action: PreviewLoadAction): PreviewLoad {
  switch (action.type) {
    case 'loaded':
      return state[action.side] ? state : { ...state, [action.side]: true };
    case 'failed':
      return state.failed ? state : { ...state, failed: true };
    case 'reset':
      return PREVIEW_LOADING;
  }
}

/** True while there is something to wait for (the skeleton may come after its delay). */
export function previewLoading(load: PreviewLoad): boolean {
  return !load.failed && !(load.before && load.after);
}
