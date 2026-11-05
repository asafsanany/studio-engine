// The Import LUTs dialog's three steps as plain TypeScript with no React or network of its own, so
// the rules are tested without a browser; `useLutImportSession` shows it.
//
//   take(files) ─▶ sending (the files go up, `stage` checks each)
//                    ├─ fail ─▶ failed (the picked files stay; "Try again")
//                    └─ ok ───▶ listed (a verdict per file; Look / Camera / Fix; remove)
//   importNow() ─▶ importing ─▶ every file in: the dialog closes (`onClose`)
//                              └ some failed: back to listed with the reasons, the dialog stays
//   cancel() throws the stage away (`cancelStage`) and resets; it is refused while importing.

import type {
  LutImportRequest,
  LutImportResponse,
  LutKind,
  LutStageResponse,
  LutSummary,
} from '@studio/shared';
import { ApiError, type LutStageSend } from '@/data';
import { LUT_IMPORT_TEXT } from './lut-import-text';

export type LutImportStep = 'pick' | 'sending' | 'listed' | 'failed' | 'importing';

/** One row of the list: a file with the engine's verdict, or (after a failed upload) just a file. */
export interface LutImportRow {
  id: string;
  name: string;
  /** Passed its check. A row that did not shows `error` and has no kind. */
  ok: boolean;
  error: string | null;
  /** The grid points, for "33 × 33 × 33"; null before the engine has looked. */
  size: number | null;
  bytes: number;
  /** Look, Camera or Fix; null for a row with no control (it did not pass, or was not checked yet). */
  kind: LutKind | null;
}

export interface LutImportState {
  step: LutImportStep;
  rows: readonly LutImportRow[];
  /** Where the checked files wait on the engine; null before the upload's answer. */
  stageId: string | null;
  /** The upload's progress, 0 to 100, while `sending`. */
  percent: number;
  /** What went wrong, in the engine's words (or ours when it did not answer). */
  error: string | null;
  /** A hint at step 1 that is not a failure ("no .cube files in that folder"). */
  notice: string | null;
}

export interface LutImportDeps {
  stage: (send: LutStageSend) => Promise<LutStageResponse>;
  cancelStage: (stageId: string) => Promise<unknown>;
  importStaged: (request: LutImportRequest) => Promise<LutImportResponse>;
  /** An import came back: the rows it added (maybe none) and how many files could not be added. */
  onResult: (imported: readonly LutSummary[], failedCount: number) => void;
  /** Every file went in: the dialog is done and should close. */
  onClose: () => void;
  /**
   * The kind every checked file starts at, when it is not the guess from its name: the dialog opened
   * for a job that waits for a camera LUT (LU10) starts them at Camera. Asked when the verdicts
   * arrive; `null` or left out keeps the guess.
   */
  defaultKind?: () => LutKind | null;
}

export interface LutImportSession {
  getState(): LutImportState;
  subscribe(listener: () => void): () => void;
  /**
   * Files were chosen (the picker, a drop on the zone or on the page). An empty list is a folder
   * with no LUTs in it. Ignored unless the dialog is at step 1 or after a failed upload.
   */
  take(files: readonly File[]): void;
  setKind(id: string, kind: LutKind): void;
  remove(id: string): void;
  /** "Try again" after a failed upload: sends the same files. */
  retry(): void;
  /** The filled button. */
  importNow(): void;
  /**
   * Cancel, Escape or a click outside: throws the upload away and starts over. Answers false (and
   * does nothing) while the files are being copied, because that cannot be taken back.
   */
  cancel(): boolean;
}

const IDLE: LutImportState = {
  step: 'pick',
  rows: [],
  stageId: null,
  percent: 0,
  error: null,
  notice: null,
};

/** 0 is "no answer at all"; a proxy or a gateway in front of a stopped engine answers 502, 503 or 504. */
const UNREACHABLE_STATUSES: readonly number[] = [0, 502, 503, 504];

/** What the dialog says when a request did not succeed: the engine's sentence, or that it did not answer. */
export function importErrorText(error: unknown): string {
  if (error instanceof ApiError && !UNREACHABLE_STATUSES.includes(error.status)) {
    return error.message;
  }
  return LUT_IMPORT_TEXT.unreachable;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function createLutImportSession(deps: LutImportDeps): LutImportSession {
  let state = IDLE;
  const listeners = new Set<() => void>();
  /** The files of the upload that failed, kept for "Try again". */
  let picked: { id: string; file: File }[] = [];
  /** Counts uploads, so the answer of one that was cancelled is recognised and thrown away. */
  let generation = 0;
  let aborter: AbortController | null = null;

  function change(next: Partial<LutImportState>): void {
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

  /** The unchecked file as a row of the list, after a failed upload. */
  function pickedRows(): LutImportRow[] {
    return picked.map(({ id, file }) => ({
      id,
      name: file.name,
      ok: true,
      error: null,
      size: null,
      bytes: file.size,
      kind: null,
    }));
  }

  async function send(): Promise<void> {
    generation += 1;
    const mine = generation;
    const control = new AbortController();
    aborter = control;
    change({
      step: 'sending',
      rows: pickedRows(),
      stageId: null,
      percent: 0,
      error: null,
      notice: null,
    });
    try {
      const answer = await deps.stage({
        files: picked.map(({ file }) => file),
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
      change({
        step: 'listed',
        stageId: answer.stageId,
        percent: 100,
        rows: answer.files.map((file) => ({
          id: file.id,
          name: file.name,
          ok: file.ok,
          error: file.ok ? null : (file.error ?? LUT_IMPORT_TEXT.unreachable),
          size: file.size,
          bytes: file.bytes,
          kind: file.ok ? (deps.defaultKind?.() ?? file.kindGuess) : null,
        })),
      });
    } catch (error) {
      if (generation !== mine || isAbort(error)) return;
      aborter = null;
      change({ step: 'failed', rows: pickedRows(), error: importErrorText(error) });
    }
  }

  async function runImport(): Promise<void> {
    const { stageId, rows } = state;
    const items = rows.flatMap((row) =>
      row.ok && row.kind !== null ? [{ id: row.id, kind: row.kind }] : [],
    );
    if (stageId === null || items.length === 0) return;
    generation += 1;
    const mine = generation;
    change({ step: 'importing', error: null });
    try {
      const answer = await deps.importStaged({ stageId, items });
      if (generation !== mine) return;
      const reasons = new Map(answer.failed.map((one) => [one.id, one.error]));
      if (answer.failed.length === 0) {
        reset();
        deps.onResult(answer.imported, 0);
        deps.onClose();
        return;
      }
      // Partly failed: the added files leave the list, the others stay with the reason in red.
      const sent = new Set(items.map((item) => item.id));
      change({
        step: 'listed',
        rows: rows.flatMap((row) => {
          const reason = reasons.get(row.id);
          if (reason !== undefined) return [{ ...row, ok: false, error: reason, kind: null }];
          return sent.has(row.id) ? [] : [row];
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
        change({ notice: LUT_IMPORT_TEXT.emptyFolder });
        return;
      }
      if (files.length > LUT_IMPORT_TEXT.maxFiles) {
        change({ notice: LUT_IMPORT_TEXT.tooMany });
        return;
      }
      picked = files.map((file, index) => ({ id: `file-${index}`, file }));
      void send();
    },
    setKind(id, kind) {
      if (state.step !== 'listed') return;
      change({
        rows: state.rows.map((row) => (row.id === id && row.ok ? { ...row, kind } : row)),
      });
    },
    remove(id) {
      if (state.step === 'listed') {
        const rows = state.rows.filter((row) => row.id !== id);
        if (rows.length === 0) {
          if (state.stageId !== null) throwAway(state.stageId);
          reset();
          return;
        }
        change({ rows });
      } else if (state.step === 'failed') {
        picked = picked.filter((one) => one.id !== id);
        if (picked.length === 0) {
          reset();
          return;
        }
        change({ rows: pickedRows() });
      }
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
