import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  createVoiceRecorder,
  type MediaRecorderLike,
  type MediaStreamLike,
  type RecorderSnapshot,
  type VoiceRecorder,
  type VoiceRecorderDeps,
} from './voice-recorder';

/** The browser's MediaRecorder and microphone, for `createVoiceRecorder`. */
export function browserRecorderDeps(upload: VoiceRecorderDeps['upload']): VoiceRecorderDeps {
  return {
    getUserMedia: (constraints) => {
      // `navigator.mediaDevices` only exists on a secure page (https, localhost).
      const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
      if (!devices?.getUserMedia) {
        return Promise.reject(
          Object.assign(new Error('The microphone needs a secure page (https or localhost).'), {
            name: 'NotSupportedError',
          }),
        );
      }
      return devices.getUserMedia(constraints);
    },
    createRecorder: (stream: MediaStreamLike, mimeType: string): MediaRecorderLike =>
      new MediaRecorder(stream as MediaStream, { mimeType }) as MediaRecorderLike,
    isTypeSupported: (type) =>
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type),
    upload,
  };
}

/**
 * One recorder for a screen, uploading each finished recording with `upload`: the review dialog's
 * uploads it as a voice note of the job, the Graphics composer's as a recording to type out. Its
 * snapshot, and the recorder to drive it. Releases it on unmount.
 *
 * The recorder lives as long as the screen, but `upload` (a mutation, say) may be replaced
 * between renders: the newest one is always the one that runs.
 */
export function useVoiceRecorder(upload: VoiceRecorderDeps['upload']): {
  recorder: VoiceRecorder;
  snapshot: RecorderSnapshot;
} {
  const latest = useRef(upload);
  useEffect(() => {
    latest.current = upload;
  });
  const [recorder] = useState(() =>
    createVoiceRecorder(browserRecorderDeps((recording) => latest.current(recording))),
  );
  useEffect(() => () => recorder.release(), [recorder]);
  const snapshot = useSyncExternalStore(
    recorder.subscribe,
    recorder.getSnapshot,
    recorder.getSnapshot,
  );
  return { recorder, snapshot };
}
