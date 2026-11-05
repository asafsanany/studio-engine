import { createStore, type StoreApi } from 'zustand';

/**
 * Which voice note is playing: only one at a time. A card that starts calls `play(its id)`; every
 * other card sees that it is no longer the playing one and pauses itself (an effect in
 * `VoiceNoteBody`). The dialog calls `stopVoicePlayback` when the video starts and when it closes.
 * Kept outside React, like `review-dialog.ts`, so the dialog and the cards share it without props.
 */
export interface VoicePlaybackState {
  /** The note whose audio is playing; null when none is. */
  playingNoteId: string | null;
  /** This note starts: the others pause through their effect. */
  play: (noteId: string) => void;
  /** This note stopped; ignored unless it is the one playing. */
  stop: (noteId: string) => void;
  stopAll: () => void;
}

/** A new store, with nothing playing. `initial` starts it somewhere else (server-rendered tests). */
export function createVoicePlaybackStore(
  initial: { playingNoteId?: string | null } = {},
): StoreApi<VoicePlaybackState> {
  return createStore<VoicePlaybackState>()((set, get) => ({
    playingNoteId: initial.playingNoteId ?? null,
    play: (noteId) => set({ playingNoteId: noteId }),
    stop: (noteId) => {
      if (get().playingNoteId === noteId) set({ playingNoteId: null });
    },
    stopAll: () => set({ playingNoteId: null }),
  }));
}

/** The app-wide store. Tests that need isolation build their own. */
export const voicePlaybackStore = createVoicePlaybackStore();

/** Stops whichever voice note is playing (the video started, the recording started, the dialog closed). */
export function stopVoicePlayback(store: StoreApi<VoicePlaybackState> = voicePlaybackStore): void {
  store.getState().stopAll();
}
