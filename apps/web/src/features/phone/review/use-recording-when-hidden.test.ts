import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceNoteUpload } from '@/data/api';
import {
  createVoiceRecorder,
  type MediaRecorderLike,
  type RecorderPhase,
} from '@/features/review/voice-recorder';
import { type VisibilitySource, watchRecordingWhenHidden } from './use-recording-when-hidden';

/** `document` as the watcher sees it: a visibility state, and its event. */
class FakePage extends EventTarget implements VisibilitySource {
  visibilityState = 'visible';

  set(state: 'visible' | 'hidden') {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

/** iPhone Safari's MediaRecorder: mp4, and on stop the audio, then the stop. */
class SafariRecorder implements MediaRecorderLike {
  readonly mimeType = 'audio/mp4';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => {
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['seven seconds'], { type: 'audio/mp4' }) });
      this.onstop?.();
    });
  });
}

function fakeRecorder(phase: RecorderPhase) {
  return {
    getSnapshot: () => ({ phase, pinnedSec: 21, elapsedSec: 7, error: null }),
    cancel: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('watchRecordingWhenHidden', () => {
  it('stops and adds a recording that runs when the page is hidden', () => {
    const page = new FakePage();
    const recorder = fakeRecorder('recording');
    const onStop = vi.fn();
    watchRecordingWhenHidden(page, recorder, onStop);

    page.set('hidden');

    expect(onStop).toHaveBeenCalledOnce();
    expect(recorder.cancel).not.toHaveBeenCalled();
  });

  it('drops one still waiting for the microphone', () => {
    const page = new FakePage();
    const recorder = fakeRecorder('starting');
    const onStop = vi.fn();
    watchRecordingWhenHidden(page, recorder, onStop);

    page.set('hidden');

    expect(recorder.cancel).toHaveBeenCalledOnce();
    expect(onStop).not.toHaveBeenCalled();
  });

  it.each(['idle', 'saving', 'failed'] as const)('leaves %s alone', (phase) => {
    const page = new FakePage();
    const recorder = fakeRecorder(phase);
    const onStop = vi.fn();
    watchRecordingWhenHidden(page, recorder, onStop);

    page.set('hidden');

    expect(onStop).not.toHaveBeenCalled();
    expect(recorder.cancel).not.toHaveBeenCalled();
  });

  it('does nothing when the page comes back, nor once it is stopped', () => {
    const page = new FakePage();
    const recorder = fakeRecorder('recording');
    const onStop = vi.fn();
    const stop = watchRecordingWhenHidden(page, recorder, onStop);

    page.set('visible');
    expect(onStop).not.toHaveBeenCalled();

    stop();
    page.set('hidden');
    expect(onStop).not.toHaveBeenCalled();
  });

  it('with the real recorder on iPhone Safari: the screen locks 7 s in, and the note is kept at its pin', async () => {
    const clock = { now: 1_000_000 };
    const uploads: VoiceNoteUpload[] = [];
    const recorder = createVoiceRecorder({
      getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }),
      createRecorder: () => new SafariRecorder(),
      // Safari before 18.4: mp4 only.
      isTypeSupported: (type) => type === 'audio/mp4',
      upload: async (upload) => {
        uploads.push(upload);
      },
      now: () => clock.now,
    });
    const page = new FakePage();
    watchRecordingWhenHidden(page, recorder, () => recorder.stop());

    await recorder.start(21.37);
    expect(recorder.getSnapshot()).toMatchObject({ phase: 'recording', pinnedSec: 21.37 });
    clock.now += 7_000;
    page.set('hidden');
    await vi.advanceTimersByTimeAsync(0);

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ atSec: 21.37, audioSec: 7 });
    expect(uploads[0]?.audio.type).toBe('audio/mp4');
    expect(uploads[0]?.audio.size).toBeGreaterThan(0);
    expect(recorder.getSnapshot().phase).toBe('idle');
  });
});
