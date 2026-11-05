// The composer's voice note: what happens to a recording once the microphone has stopped. The
// recorder (features/review/voice-recorder.ts, shared with Review) hands the finished audio to an
// upload function; here that function sends it to be typed out and puts the text in the draft.
// No React.

import type { VoiceNoteUpload } from '@/data/api';
import type { RecorderSnapshot } from '@/features/review/voice-recorder';

/**
 * The upload function of the composer's recorder: types the recording out (`transcribe`, which is
 * `POST /api/graphics/voice`) and gives the text to `onText`. When the engine cannot type it out
 * the error goes back to the recorder, which keeps the recording for Try again.
 */
export function voiceToText(
  transcribe: (audio: Blob) => Promise<string>,
  onText: (text: string) => void,
): (upload: VoiceNoteUpload) => Promise<void> {
  return async (upload) => {
    onText(await transcribe(upload.audio));
  };
}

export type MicAction = 'start' | 'stop' | 'cancel' | 'none';

/**
 * What the mic button does in each phase: starts a recording, stops the one running, drops one that
 * is still waiting for the browser's microphone question, or nothing while the note is being typed
 * out or waiting for Try again (which has its own buttons).
 */
export function micAction(snapshot: Pick<RecorderSnapshot, 'phase'>): MicAction {
  switch (snapshot.phase) {
    case 'idle':
      return 'start';
    case 'recording':
      return 'stop';
    case 'starting':
      return 'cancel';
    default:
      return 'none';
  }
}
