// The Import fonts dialog's steps as plain TypeScript with no React or network of its own, so the
// rules are tested without a browser; `useFontImportSession` shows it.
//
//   take(files) ─▶ sending (the files go up, `stage` checks them and groups them by family)
//                    ├─ fail ─▶ failed (the picked files stay; "Try again")
//                    └─ ok ───▶ listed (a verdict per family or bad file; remove)
//   importNow() ─▶ importing ─▶ every family in: the dialog closes (`onClose`)
//                              └ some failed: back to listed with the reasons, the dialog stays
//   cancel() throws the stage away (`cancelStage`) and resets; it is refused while importing.

import type {
  FontFamilySummary,
  FontImportRequest,
  FontImportResponse,
  FontStageItem,
  FontStageResponse,
} from '@studio/shared';
import { ApiError, type FontStageSend } from '@/data';
import { FONT_IMPORT_TEXT } from './font-import-text';

export type FontImportStep = 'pick' | 'sending' | 'listed' | 'failed' | 'importing';

export interface FontImportState {
  step: FontImportStep;
  /** One line per family (or per file that is not a font), in the engine's words. */
  items: readonly FontStageItem[];
  /** Where the checked files wait on the engine; null before the upload's answer. */
  stageId: string | null;
  /** How many files were picked: what "Checking 237 files…" and the failed line count. */
  picked: number;
  /** The upload's progress, 0 to 100, while `sending`. */
  percent: number;
  /** What went wrong, in the engine's words (or ours when it did not answer). */
  error: string | null;
  /** A hint at step 1 that is not a failure ("no font files in that folder"). */
  notice: string | null;
}

export interface FontImportDeps {
  stage: (send: FontStageSend) => Promise<FontStageResponse>;
  cancelStage: (stageId: string) => Promise<unknown>;
  importStaged: (request: FontImportRequest) => Promise<FontImportResponse>;
  /** An import came back: the families it added (maybe none) and how many items could not be added. */
  onResult: (imported: readonly FontFamilySummary[], failedCount: number) => void;
  /** Every family went in: the dialog is done and should close. */
  onClose: () => void;
}

export interface FontImportSession {
  getState(): FontImportState;
  subscribe(listener: () => void): () => void;
  /**
   * Files were chosen (the picker, a drop on the zone or on the page). An empty list is a folder
   * with no fonts in it. Ignored unless the dialog is at step 1 or after a failed upload.
   */
  take(files: readonly File[]): void;
  /** The × of a row: that family or file will not be imported. The last one out sends the dialog back to step 1. */
  remove(id: string): void;
  /** "Try again" after a failed upload: sends the same files. */
  retry(): void;
  /** The filled button. */
  importNow(): void;
  /**
   * Cancel, Escape or a click outside: throws the upload away and starts over. Answers false (and
   * does nothing) while the fonts are being copied, because that cannot be taken back.
   */
  cancel(): boolean;
}

const IDLE: FontImportState = {
  step: 'pick',
  items: [],
  stageId: null,
  picked: 0,
  percent: 0,
  error: null,
  notice: null,
};

/** Only a family that is new, or that gains weights, is copied; the other verdicts are information. */
export function isImportable(item: Pick<FontStageItem, 'status'>): boolean {
  return item.status === 'new' || item.status === 'adds';
}

/** How many items the Import button will copy: "Import N fonts". */
export function importableCount(items: readonly Pick<FontStageItem, 'status'>[]): number {
  return items.filter(isImportable).length;
}

/** 0 is "no answer at all"; a proxy or a gateway in front of a stopped engine answers 502, 503 or 504. */
const UNREACHABLE_STATUSES: readonly number[] = [0, 502, 503, 504];

/** What the dialog says when a request did not succeed: the engine's sentence, or that it did not answer. */
export function importErrorText(error: unknown): string {
  if (error instanceof ApiError && !UNREACHABLE_STATUSES.includes(error.status)) {
    return error.message;
  }
  return FONT_IMPORT_TEXT.unreachable;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function createFontImportSession(deps: FontImportDeps): FontImportSession {
  let state = IDLE;
  const listeners = new Set<() => void>();
  /** The files of the upload, kept for "Try again". */
  let picked: readonly File[] = [];
  /** Counts uploads, so the answer of one that was cancelled is recognised and thrown away. */
  let generation = 0;
  let aborter: AbortController | null = null;

  function change(next: Partial<FontImportState>): void {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  }

  function reset(): void {
    generation += 1;
    aborter?.abort();
    aborter = null;
    picked = [];
    state = IDLE;
    for (const listener of [...listeners]) listener();
  }

  function throwAway(stageId: string): void {
    // A stage that is already gone (reaped, or consumed by an import) is not a problem.
    void deps.cancelStage(stageId).catch(() => {});
  }

  async function send(): Promise<void> {
    generation += 1;
    const mine = generation;
    const control = new AbortController();
    aborter = control;
    change({
      step: 'sending',
      items: [],
      stageId: null,
      picked: picked.length,
      percent: 0,
      error: null,
      notice: null,
    });
    try {
      const answer = await deps.stage({
        files: picked,
        signal: control.signal,
        onProgress: (percent) => {
          if (generation === mine) change({ percent });
        },
      });
      if (generation !== mine) {
        throwAway(answer.stageId);
        return;
      }
      aborter = null;
      if (answer.items.length === 0) {
        // Nothing in the upload was a font file (every one was ignored): back to step 1.
        throwAway(answer.stageId);
        picked = [];
        change({ ...IDLE, notice: FONT_IMPORT_TEXT.emptyFolder });
        return;
      }
      change({ step: 'listed', stageId: answer.stageId, percent: 100, items: answer.items });
    } catch (error) {
      if (generation !== mine || isAbort(error)) return;
      aborter = null;
      change({ step: 'failed', items: [], error: importErrorText(error) });
    }
  }

  async function runImport(): Promise<void> {
    const { stageId, items } = state;
    const ids = items.filter(isImportable).map((item) => item.id);
    if (stageId === null || ids.length === 0) return;
    generation += 1;
    const mine = generation;
    change({ step: 'importing', error: null });
    try {
      const answer = await deps.importStaged({ stageId, items: ids });
      if (generation !== mine) return;
      if (answer.failed.length === 0) {
        reset();
        deps.onResult(answer.imported, 0);
        deps.onClose();
        return;
      }
      // Partly failed: the added families leave the list, the others stay, the failed ones with the
      // reason in red.
      const reasons = new Map(answer.failed.map((one) => [one.id, one.error]));
      const sent = new Set(ids);
      change({
        step: 'listed',
        items: items.flatMap((item): FontStageItem[] => {
          const reason = reasons.get(item.id);
          if (reason !== undefined) return [{ ...item, status: 'bad', info: reason }];
          return sent.has(item.id) ? [] : [item];
        }),
      });
      deps.onResult(answer.imported, answer.failed.length);
    } catch (error) {
      if (generation !== mine) return;
      change({ step: 'listed', error: importErrorText(error) });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    take(files) {
      if (state.step !== 'pick' && state.step !== 'failed') return;
      if (files.length === 0) {
        change({ notice: FONT_IMPORT_TEXT.emptyFolder });
        return;
      }
      if (files.length > FONT_IMPORT_TEXT.maxFiles) {
        change({ notice: FONT_IMPORT_TEXT.tooMany });
        return;
      }
      picked = [...files];
      void send();
    },
    remove(id) {
      if (state.step !== 'listed') return;
      const items = state.items.filter((item) => item.id !== id);
      if (items.length === 0) {
        if (state.stageId !== null) throwAway(state.stageId);
        reset();
        return;
      }
      change({ items, error: null });
    },
    retry() {
      if (state.step !== 'failed' || picked.length === 0) return;
      void send();
    },
    importNow() {
      if (state.step !== 'listed') return;
      void runImport();
    },
    cancel() {
      if (state.step === 'importing') return false;
      if (state.stageId !== null) throwAway(state.stageId);
      reset();
      return true;
    },
  };
}
