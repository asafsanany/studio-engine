import { describe, expect, it } from 'vitest';
import { createVoicePlaybackStore, stopVoicePlayback, voicePlaybackStore } from './voice-playback';

describe('createVoicePlaybackStore', () => {
  it('starts with nothing playing', () => {
    expect(createVoicePlaybackStore().getState().playingNoteId).toBeNull();
  });

  it('starts where it is told to (server-rendered tests)', () => {
    const store = createVoicePlaybackStore({ playingNoteId: 'n2' });
    expect(store.getState().playingNoteId).toBe('n2');
    expect(store.getInitialState().playingNoteId).toBe('n2');
  });

  it('plays one note at a time: another play replaces it', () => {
    const store = createVoicePlaybackStore();
    store.getState().play('n1');
    expect(store.getState().playingNoteId).toBe('n1');
    store.getState().play('n2');
    expect(store.getState().playingNoteId).toBe('n2');
  });

  it('stops only the note that is playing', () => {
    const store = createVoicePlaybackStore();
    store.getState().play('n1');
    store.getState().stop('n2');
    expect(store.getState().playingNoteId).toBe('n1');
    store.getState().stop('n1');
    expect(store.getState().playingNoteId).toBeNull();
  });

  it('stops everything with stopAll', () => {
    const store = createVoicePlaybackStore({ playingNoteId: 'n1' });
    store.getState().stopAll();
    expect(store.getState().playingNoteId).toBeNull();
  });
});

describe('stopVoicePlayback', () => {
  it('stops the app’s store', () => {
    voicePlaybackStore.getState().play('n9');
    stopVoicePlayback();
    expect(voicePlaybackStore.getState().playingNoteId).toBeNull();
  });

  it('stops the store it is given, and leaves the app’s alone', () => {
    const other = createVoicePlaybackStore({ playingNoteId: 'n1' });
    voicePlaybackStore.getState().play('n9');
    stopVoicePlayback(other);
    expect(other.getState().playingNoteId).toBeNull();
    expect(voicePlaybackStore.getState().playingNoteId).toBe('n9');
    stopVoicePlayback();
  });
});
