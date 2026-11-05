import { useEffect, useRef } from 'react';
import type { VoiceRecorder } from '@/features/review/voice-recorder';
import { recorderWhenHidden } from './phone-review';

/** What is read of `document`. */
export interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * When `source` is hidden (the screen locks, or another app comes up; iPhone Safari may also stop
 * the microphone then), a recording that runs is stopped and added through `onStop` (what Stop and
 * add does), so what was said is kept; one still waiting for the microphone is dropped. Returns
 * the stop.
 */
export function watchRecordingWhenHidden(
  source: VisibilitySource,
  recorder: Pick<VoiceRecorder, 'getSnapshot' | 'cancel'>,
  onStop: () => void,
): () => void {
  function onVisibilityChange() {
    if (source.visibilityState !== 'hidden') return;
    const action = recorderWhenHidden(recorder.getSnapshot().phase);
    if (action === 'stop') onStop();
    else if (action === 'cancel') recorder.cancel();
  }
  source.addEventListener('visibilitychange', onVisibilityChange);
  return () => source.removeEventListener('visibilitychange', onVisibilityChange);
}

/** `watchRecordingWhenHidden` on the page, for as long as the review is mounted. */
export function useRecordingWhenHidden(recorder: VoiceRecorder, onStop: () => void): void {
  const latestStop = useRef(onStop);
  useEffect(() => {
    latestStop.current = onStop;
  });

  useEffect(
    () => watchRecordingWhenHidden(document, recorder, () => latestStop.current()),
    [recorder],
  );
}
