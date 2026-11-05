import { VOICE_NOTE_MAX_SEC } from '@studio/shared';
import type { VoiceNoteUpload } from '@/data/api';
import { VOICE_TEXT } from './review-text';

// The voice recorder of the review dialog: asks for the microphone, records with MediaRecorder,
// and uploads the note. No React and no browser globals: everything comes through `deps`, so node
// tests drive it with fakes (`use-voice-recorder.ts` wires the browser's own).

/** What we ask MediaRecorder for, best first: Chrome and Firefox take the first, Safari the second. */
export const RECORDING_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/mp4'] as const;
/** How often the elapsed time is read while recording. */
export const RECORDER_TICK_MS = 250;
/** MediaRecorder hands over the audio in pieces this long, so a stop loses nothing. */
export const RECORDER_TIMESLICE_MS = 1000;

/** The first of `RECORDING_MIME_TYPES` the browser can record, or `null`. */
export function pickRecordingMimeType(isTypeSupported: (type: string) => boolean): string | null {
  return RECORDING_MIME_TYPES.find((type) => isTypeSupported(type)) ?? null;
}

export type RecorderPhase = 'idle' | 'starting' | 'recording' | 'saving' | 'failed';

export interface RecorderSnapshot {
  phase: RecorderPhase;
  /** Where the note goes: the playhead when Record was pressed. Null when idle. */
  pinnedSec: number | null;
  /** Seconds recorded (frozen once stopped). */
  elapsedSec: number;
  /** idle: why recording could not start (mic denied, none, unsupported); failed: why the upload failed. */
  error: string | null;
}

export interface MediaStreamLike {
  getTracks(): readonly { stop(): void }[];
}

export interface MediaRecorderLike {
  readonly mimeType: string;
  start(timesliceMs?: number): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
}

export interface VoiceRecorderDeps {
  getUserMedia(constraints: { audio: true }): Promise<MediaStreamLike>;
  createRecorder(stream: MediaStreamLike, mimeType: string): MediaRecorderLike;
  isTypeSupported(type: string): boolean;
  upload(upload: VoiceNoteUpload): Promise<unknown>;
  /** Default `Date.now`. */
  now?: () => number;
  /** Default `globalThis.setInterval`, looked up at call time. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** The longest recording in seconds. Default `VOICE_NOTE_MAX_SEC`. */
  maxSec?: number;
}

export interface VoiceRecorder {
  getSnapshot(): RecorderSnapshot;
  subscribe(listener: () => void): () => void;
  /** Record: asks for the microphone (once per recording), then records. Ignored unless idle. Never rejects. */
  start(pinnedSec: number): Promise<void>;
  /** Stop and add: ends the recording and uploads it. Only while recording. */
  stop(): void;
  /** Cancel (Esc): drops a recording that is starting or running; nothing is uploaded. */
  cancel(): void;
  /** Try again after a failed upload, with the same recording. */
  retry(): Promise<void>;
  /** Discard a recording whose upload failed. */
  discard(): void;
  /** Forget the idle error (the person typed or pressed Record again). */
  clearError(): void;
  /** The dialog closed or unmounted: like cancel, and releases the microphone. The recorder stays usable (React's StrictMode remounts). */
  release(): void;
}

const IDLE: RecorderSnapshot = { phase: 'idle', pinnedSec: null, elapsedSec: 0, error: null };

/** One recording, from Record to the upload. A new one for every `start`. */
interface Recording {
  mime: string;
  stream: MediaStreamLike | null;
  recorder: MediaRecorderLike | null;
  chunks: Blob[];
  startedAt: number;
  tick: unknown;
  /** Cancelled or released: whatever MediaRecorder still delivers is thrown away. */
  discarded: boolean;
  /** `onstop` has been handled. */
  finished: boolean;
}

/** An error's message, or `String(error)` for something that is not one. */
function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error as { message: unknown };
    if (typeof message === 'string' && message !== '') return message;
  }
  return String(error);
}

function nameOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const { name } = error as { name: unknown };
    if (typeof name === 'string') return name;
  }
  return '';
}

/** Why `getUserMedia` (or the recorder) could not start, in the person's words. */
function startError(error: unknown): string {
  switch (nameOf(error)) {
    case 'NotAllowedError':
    case 'SecurityError':
      return VOICE_TEXT.micDenied;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return VOICE_TEXT.noMic;
    default:
      return `${VOICE_TEXT.startFailed} ${messageOf(error)}`;
  }
}

function stopTracks(stream: MediaStreamLike | null): void {
  if (stream === null) return;
  for (const track of stream.getTracks()) track.stop();
}

export function createVoiceRecorder(deps: VoiceRecorderDeps): VoiceRecorder {
  const now = deps.now ?? Date.now;
  const maxSec = deps.maxSec ?? VOICE_NOTE_MAX_SEC;
  const startInterval =
    deps.setInterval ?? ((fn: () => void, ms: number): unknown => globalThis.setInterval(fn, ms));
  const stopInterval =
    deps.clearInterval ??
    ((handle: unknown): void => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));

  let snapshot: RecorderSnapshot = IDLE;
  const listeners = new Set<() => void>();
  /** The recording in progress (starting, recording or saving), or null. */
  let active: Recording | null = null;
  /** The upload that failed, kept for `retry`. */
  let failedUpload: VoiceNoteUpload | null = null;

  // A new snapshot object for every change, the same one when nothing changed.
  function set(patch: Partial<RecorderSnapshot>): void {
    const next = { ...snapshot, ...patch };
    if (
      next.phase === snapshot.phase &&
      next.pinnedSec === snapshot.pinnedSec &&
      next.elapsedSec === snapshot.elapsedSec &&
      next.error === snapshot.error
    ) {
      return;
    }
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  function toIdle(error: string | null = null): void {
    active = null;
    failedUpload = null;
    set({ phase: 'idle', pinnedSec: null, elapsedSec: 0, error });
  }

  function endTick(recording: Recording): void {
    if (recording.tick === null) return;
    stopInterval(recording.tick);
    recording.tick = null;
  }

  function releaseStream(recording: Recording): void {
    stopTracks(recording.stream);
    recording.stream = null;
  }

  async function send(upload: VoiceNoteUpload): Promise<void> {
    failedUpload = null;
    set({ phase: 'saving', error: null });
    try {
      await deps.upload(upload);
    } catch (error) {
      failedUpload = upload;
      set({ phase: 'failed', error: `${VOICE_TEXT.uploadFailed} ${messageOf(error)}` });
      return;
    }
    toIdle();
  }

  /** The recording ends and the elapsed time freezes: from `stop`, or from the browser stopping by itself. */
  function beginSaving(recording: Recording): void {
    endTick(recording);
    const elapsedSec = Math.min(maxSec, Math.max(0, (now() - recording.startedAt) / 1000));
    set({ phase: 'saving', elapsedSec });
  }

  /** MediaRecorder's last event: the audio is complete. */
  function finish(recording: Recording): void {
    if (recording.finished) return;
    recording.finished = true;
    endTick(recording);
    releaseStream(recording);
    if (recording.discarded || active !== recording) return;
    // The browser stopped by itself (the microphone was unplugged): it counts as Stop and add.
    if (snapshot.phase === 'recording') beginSaving(recording);

    const type = recording.recorder?.mimeType || recording.mime;
    const audio = new Blob(recording.chunks, { type });
    if (audio.size === 0) {
      toIdle(VOICE_TEXT.empty);
      return;
    }
    void send({
      audio,
      atSec: snapshot.pinnedSec ?? 0,
      audioSec: Math.max(0.1, Math.round(snapshot.elapsedSec * 10) / 10),
    });
  }

  function onTick(recording: Recording): void {
    if (active !== recording || snapshot.phase !== 'recording') return;
    const elapsedSec = (now() - recording.startedAt) / 1000;
    if (elapsedSec >= maxSec) {
      stop(); // The 5-minute stop adds the note.
      return;
    }
    set({ elapsedSec });
  }

  async function start(pinnedSec: number): Promise<void> {
    if (snapshot.phase !== 'idle') return;
    const mime = pickRecordingMimeType(deps.isTypeSupported);
    if (mime === null) {
      set({ error: VOICE_TEXT.unsupported });
      return;
    }
    const recording: Recording = {
      mime,
      stream: null,
      recorder: null,
      chunks: [],
      startedAt: 0,
      tick: null,
      discarded: false,
      finished: false,
    };
    active = recording;
    set({ phase: 'starting', pinnedSec, elapsedSec: 0, error: null });

    let stream: MediaStreamLike;
    try {
      stream = await deps.getUserMedia({ audio: true });
    } catch (error) {
      if (active !== recording) return; // Cancelled meanwhile: nothing to say.
      toIdle(startError(error));
      return;
    }
    if (active !== recording) {
      // Cancelled or released while the browser asked: the microphone goes straight back.
      stopTracks(stream);
      return;
    }
    recording.stream = stream;

    try {
      const recorder = deps.createRecorder(stream, mime);
      recording.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recording.chunks.push(event.data);
      };
      recorder.onstop = () => finish(recording);
      recorder.start(RECORDER_TIMESLICE_MS);
    } catch (error) {
      releaseStream(recording);
      toIdle(startError(error));
      return;
    }

    recording.startedAt = now();
    recording.tick = startInterval(() => onTick(recording), RECORDER_TICK_MS);
    set({ phase: 'recording' });
  }

  function stop(): void {
    const recording = active;
    if (snapshot.phase !== 'recording' || recording === null) return;
    beginSaving(recording);
    try {
      recording.recorder?.stop();
    } catch {
      // The recorder was already inactive, so no `stop` event is coming: finish with what we have.
      finish(recording);
    }
  }

  function cancel(): void {
    const recording = active;
    if (recording === null) return;
    if (snapshot.phase === 'starting') {
      // The late `getUserMedia` answer sees that it was cancelled and stops its own stream.
      toIdle();
    } else if (snapshot.phase === 'recording') {
      recording.discarded = true;
      endTick(recording);
      try {
        recording.recorder?.stop();
      } catch {
        // Already inactive: nothing more to stop.
      }
      releaseStream(recording);
      toIdle();
    }
  }

  async function retry(): Promise<void> {
    if (snapshot.phase !== 'failed' || failedUpload === null) return;
    await send(failedUpload);
  }

  function discard(): void {
    if (snapshot.phase !== 'failed') return;
    toIdle();
  }

  function clearError(): void {
    if (snapshot.phase === 'idle' && snapshot.error !== null) set({ error: null });
  }

  function release(): void {
    if (snapshot.phase === 'starting' || snapshot.phase === 'recording') cancel();
    else if (snapshot.phase === 'failed') discard();
    // Saving: the upload finishes on its own, and its note arrives through the cache.
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    stop,
    cancel,
    retry,
    discard,
    clearError,
    release,
  };
}
