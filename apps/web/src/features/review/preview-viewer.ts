import { isFolderDeleted, type Job } from '@studio/shared';
import { createStore, type StoreApi, useStore } from 'zustand';

/** A completed preview remains watchable while a revision or render runs and after delivery. */
export function canViewPreview(job: Job): boolean {
  return job.preview !== null && !isFolderDeleted(job);
}

export interface PreviewViewerState {
  jobId: string | null;
  /** The preview version ("Cut n") on show, or `null` for the job's live preview. */
  version: number | null;
  session: number;
  open: (jobId: string, version?: number | null) => void;
  close: () => void;
  reset: () => void;
}

export function createPreviewViewerStore(
  initial: Partial<Pick<PreviewViewerState, 'jobId' | 'version' | 'session'>> = {},
): StoreApi<PreviewViewerState> {
  return createStore<PreviewViewerState>()((set) => ({
    jobId: null,
    version: null,
    session: 0,
    ...initial,
    open: (jobId, version = null) =>
      set((state) => ({ jobId, version, session: state.session + 1 })),
    close: () => set({ jobId: null }),
    reset: () => set({ jobId: null, version: null }),
  }));
}

export const previewViewerStore = createPreviewViewerStore();

/** Opens the viewer on the job's live preview, or on one of its preview versions (Versions in the job sheet). */
export function openPreview(jobId: string, version?: number | null): void {
  previewViewerStore.getState().open(jobId, version);
}

export function usePreviewViewer(store: StoreApi<PreviewViewerState> = previewViewerStore) {
  return useStore(store, (state) => state);
}
