import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { VoiceNoteUpload } from '@/data/api';
import {
  createVoiceRecorder,
  type MediaRecorderLike,
  type MediaStreamLike,
  pickRecordingMimeType,
  RECORDER_TICK_MS,
  RECORDER_TIMESLICE_MS,
  RECORDING_MIME_TYPES,
  type VoiceRecorderDeps,
} from './voice-recorder';

/** A promise settled by hand, to hold the microphone question open. */
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeStream() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stream: MediaStreamLike = { getTracks: () => tracks };
  return { stream, tracks };
}

/** MediaRecorder as the recorder sees it: stop() hands over the audio and then says it stopped. */
class FakeRecorder implements MediaRecorderLike {
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => {
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(this.audio, { type: this.type }) });
      this.onstop?.();
    });
  });

  constructor(
    readonly mimeType: string,
    /** What stop() delivers. */
    private readonly audio: string[],
    private readonly type: string,
  ) {}
}

interface Setup {
  recorder: ReturnType<typeof createVoiceRecorder>;
  deps: VoiceRecorderDeps;
  clock: { now: number };
  upload: Mock<(upload: VoiceNoteUpload) => Promise<unknown>>;
  getUserMedia: Mock<VoiceRecorderDeps['getUserMedia']>;
  createRecorder: Mock<VoiceRecorderDeps['createRecorder']>;
  recorders: FakeRecorder[];
  streams: ReturnType<typeof fakeStream>[];
}

function setup(
  options: {
    supported?: readonly string[];
    audio?: string[];
    /** What the browser reports as the recorder's mimeType (some report ''). */
    reportedType?: string;
    maxSec?: number;
    getUserMedia?: VoiceRecorderDeps['getUserMedia'];
    upload?: (upload: VoiceNoteUpload) => Promise<unknown>;
  } = {},
): Setup {
  const supported = options.supported ?? [...RECORDING_MIME_TYPES];
  const clock = { now: 1_000_000 };
  const streams: ReturnType<typeof fakeStream>[] = [];
  const recorders: FakeRecorder[] = [];
  const getUserMedia = vi.fn<VoiceRecorderDeps['getUserMedia']>(
    options.getUserMedia ??
      (async () => {
        const made = fakeStream();
        streams.push(made);
        return made.stream;
      }),
  );
  const createRecorder = vi.fn<VoiceRecorderDeps['createRecorder']>((_stream, mimeType) => {
    const made = new FakeRecorder(
      options.reportedType ?? mimeType,
      options.audio ?? ['abc'],
      mimeType,
    );
    recorders.push(made);
    return made;
  });
  const upload = vi.fn<(upload: VoiceNoteUpload) => Promise<unknown>>(
    options.upload ?? (async () => ({})),
  );
  const deps: VoiceRecorderDeps = {
    getUserMedia,
    createRecorder,
    isTypeSupported: (type) => supported.includes(type),
    upload,
    now: () => clock.now,
    maxSec: options.maxSec,
  };
  return {
    recorder: createVoiceRecorder(deps),
    deps,
    clock,
    upload,
    getUserMedia,
    createRecorder,
    recorders,
    streams,
  };
}

/** Let the pending promises run. */
const flush = () => vi.advanceTimersByTimeAsync(0);

/** Start a recording pinned at 2.4 s and wait until it is running. */
async function recording(options: Parameters<typeof setup>[0] = {}) {
  const made = setup(options);
  await made.recorder.start(2.4);
  return made;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pickRecordingMimeType', () => {
  it('takes webm/opus where it is supported (Chrome, Firefox)', () => {
    expect(pickRecordingMimeType(() => true)).toBe('audio/webm;codecs=opus');
  });

  it('falls back to mp4 where only that is supported (Safari)', () => {
    expect(pickRecordingMimeType((type) => type === 'audio/mp4')).toBe('audio/mp4');
  });

  it('is null when the browser can record neither', () => {
    expect(pickRecordingMimeType(() => false)).toBeNull();
  });
});

describe('starting a recording', () => {
  it('asks for the microphone, makes the recorder with the chosen type and starts it in pieces', async () => {
    const { recorder, getUserMedia, createRecorder, recorders, streams } = setup();
    expect(recorder.getSnapshot()).toEqual({
      phase: 'idle',
      pinnedSec: null,
      elapsedSec: 0,
      error: null,
    });

    const started = recorder.start(2.4);
    expect(recorder.getSnapshot()).toMatchObject({ phase: 'starting', pinnedSec: 2.4 });
    await started;

    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true });
    expect(createRecorder).toHaveBeenCalledExactlyOnceWith(
      streams[0]?.stream,
      'audio/webm;codecs=opus',
    );
    expect(recorders[0]?.start).toHaveBeenCalledExactlyOnceWith(RECORDER_TIMESLICE_MS);
    expect(recorder.getSnapshot()).toEqual({
      phase: 'recording',
      pinnedSec: 2.4,
      elapsedSec: 0,
      error: null,
    });
  });

  it('records mp4 where webm is not supported', async () => {
    const { recorder, createRecorder } = setup({ supported: ['audio/mp4'] });
    await recorder.start(0);
    expect(createRecorder).toHaveBeenCalledWith(expect.anything(), 'audio/mp4');
  });

  it('ignores a second Record while one is starting or running', async () => {
    const { recorder, getUserMedia } = setup();
    const first = recorder.start(2.4);
    await recorder.start(9);
    await first;
    await recorder.start(11);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(recorder.getSnapshot().pinnedSec).toBe(2.4);
  });

  it('says so, without asking for the microphone, when the browser can record no type', async () => {
    const { recorder, getUserMedia } = setup({ supported: [] });
    await recorder.start(2.4);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(recorder.getSnapshot()).toEqual({
      phase: 'idle',
      pinnedSec: null,
      elapsedSec: 0,
      error: "This browser can't record voice notes.",
    });
  });
});

describe('when the microphone is not available', () => {
  async function failWith(error: unknown) {
    const made = setup({ getUserMedia: () => Promise.reject(error) });
    await made.recorder.start(2.4);
    return made;
  }

  it('says the microphone is off when access is denied', async () => {
    const { recorder, createRecorder } = await failWith({ name: 'NotAllowedError' });
    expect(recorder.getSnapshot()).toEqual({
      phase: 'idle',
      pinnedSec: null,
      elapsedSec: 0,
      error: 'Microphone access is off. Allow it in the browser to record voice notes.',
    });
    expect(createRecorder).not.toHaveBeenCalled();
  });

  it('says the same when the page is blocked (SecurityError)', async () => {
    const { recorder } = await failWith({ name: 'SecurityError' });
    expect(recorder.getSnapshot().error).toBe(
      'Microphone access is off. Allow it in the browser to record voice notes.',
    );
  });

  it.each(['NotFoundError', 'OverconstrainedError'])(
    'says there is no microphone (%s)',
    async (name) => {
      const { recorder } = await failWith({ name });
      expect(recorder.getSnapshot().error).toBe('No microphone was found.');
    },
  );

  it('gives the browser’s own message for anything else', async () => {
    const { recorder } = await failWith(
      Object.assign(new Error('The device is busy'), { name: 'NotReadableError' }),
    );
    expect(recorder.getSnapshot().error).toBe("Couldn't start recording: The device is busy");
  });

  it('forgets the error when asked, and asks for the microphone again on the next Record', async () => {
    const { recorder, getUserMedia } = await failWith({ name: 'NotAllowedError' });
    recorder.clearError();
    expect(recorder.getSnapshot().error).toBeNull();
    await recorder.start(1);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('starts over after an error: Record again clears it', async () => {
    const { recorder, getUserMedia } = await failWith({ name: 'NotAllowedError' });
    getUserMedia.mockImplementationOnce(async () => fakeStream().stream);
    await recorder.start(1);
    expect(recorder.getSnapshot()).toMatchObject({ phase: 'recording', error: null });
  });

  it('stops the microphone if the recorder cannot be made', async () => {
    const made = setup();
    made.createRecorder.mockImplementationOnce(() => {
      throw new Error('mimeType is not supported');
    });
    await made.recorder.start(2.4);
    for (const track of made.streams[0]?.tracks ?? []) expect(track.stop).toHaveBeenCalledOnce();
    expect(made.recorder.getSnapshot()).toMatchObject({
      phase: 'idle',
      error: "Couldn't start recording: mimeType is not supported",
    });
  });
});

describe('recording and stopping', () => {
  it('counts the time as it goes', async () => {
    const { recorder, clock } = await recording();
    clock.now += 1200;
    vi.advanceTimersByTime(RECORDER_TICK_MS);
    expect(recorder.getSnapshot().elapsedSec).toBe(1.2);
    clock.now += 5800;
    vi.advanceTimersByTime(RECORDER_TICK_MS);
    expect(recorder.getSnapshot().elapsedSec).toBe(7);
  });

  it('stops and uploads the note with its pin and its length, then goes back to idle', async () => {
    const { recorder, clock, upload, recorders, streams } = await recording();
    clock.now += 3200;
    vi.advanceTimersByTime(RECORDER_TICK_MS);

    recorder.stop();
    expect(recorder.getSnapshot()).toMatchObject({ phase: 'saving', elapsedSec: 3.2 });
    expect(recorders[0]?.stop).toHaveBeenCalledOnce();
    await flush();

    expect(upload).toHaveBeenCalledOnce();
    const sent = upload.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ atSec: 2.4, audioSec: 3.2 });
    expect(sent?.audio).toBeInstanceOf(Blob);
    expect(sent?.audio.type).toBe('audio/webm;codecs=opus');
    expect(sent?.audio.size).toBe(3);
    for (const track of streams[0]?.tracks ?? []) expect(track.stop).toHaveBeenCalledOnce();
    expect(recorder.getSnapshot()).toEqual({
      phase: 'idle',
      pinnedSec: null,
      elapsedSec: 0,
      error: null,
    });
  });

  it('rounds the length to a tenth of a second, and never to less than 0.1', async () => {
    const long = await recording();
    long.clock.now += 3249;
    long.recorder.stop();
    await flush();
    expect(long.upload.mock.calls[0]?.[0].audioSec).toBe(3.2);

    const short = await recording();
    short.recorder.stop();
    await flush();
    expect(short.upload.mock.calls[0]?.[0].audioSec).toBe(0.1);
  });

  it('keeps the time frozen while it uploads, and keeps the pin in the box', async () => {
    const hold = deferred();
    const { recorder, clock } = await recording({ upload: () => hold.promise });
    clock.now += 4000;
    recorder.stop();
    await flush();
    clock.now += 10_000;
    vi.advanceTimersByTime(5000);
    expect(recorder.getSnapshot()).toEqual({
      phase: 'saving',
      pinnedSec: 2.4,
      elapsedSec: 4,
      error: null,
    });
    hold.resolve({});
    await flush();
    expect(recorder.getSnapshot().phase).toBe('idle');
  });

  it('ignores Stop when nothing is recording', async () => {
    const { recorder, upload } = setup();
    recorder.stop();
    expect(recorder.getSnapshot().phase).toBe('idle');
    await recorder.start(1);
    recorder.stop();
    recorder.stop();
    await flush();
    expect(upload).toHaveBeenCalledOnce();
  });

  it('stops on its own at 5 minutes, and adds the note', async () => {
    const { recorder, clock, upload, recorders } = await recording();
    clock.now += 299_900;
    vi.advanceTimersByTime(RECORDER_TICK_MS);
    expect(recorder.getSnapshot().phase).toBe('recording');

    clock.now += 100;
    vi.advanceTimersByTime(RECORDER_TICK_MS);
    expect(recorder.getSnapshot().phase).toBe('saving');
    expect(recorders[0]?.stop).toHaveBeenCalledOnce();
    await flush();
    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0]?.[0].audioSec).toBe(300);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never reports more than the longest recording, even if a tick came late', async () => {
    const { recorder, clock, upload } = await recording({ maxSec: 10 });
    clock.now += 25_000;
    recorder.stop();
    await flush();
    expect(upload.mock.calls[0]?.[0].audioSec).toBe(10);
  });

  it('clears its timer when the recording ends', async () => {
    const { recorder } = await recording();
    expect(vi.getTimerCount()).toBe(1);
    recorder.stop();
    expect(vi.getTimerCount()).toBe(0);
    await flush();
  });

  it('takes the type it asked for when the browser reports none', async () => {
    const { recorder, upload } = await recording({ reportedType: '' });
    recorder.stop();
    await flush();
    expect(upload.mock.calls[0]?.[0].audio.type).toBe('audio/webm;codecs=opus');
  });

  it('uploads an audio/mp4 Blob where that is what was recorded', async () => {
    const { recorder, upload } = await recording({ supported: ['audio/mp4'] });
    recorder.stop();
    await flush();
    expect(upload.mock.calls[0]?.[0].audio.type).toBe('audio/mp4');
  });

  it('says so when the recording is empty, and uploads nothing', async () => {
    const { recorder, upload, streams } = await recording({ audio: [] });
    recorder.stop();
    await flush();
    expect(upload).not.toHaveBeenCalled();
    expect(recorder.getSnapshot()).toEqual({
      phase: 'idle',
      pinnedSec: null,
      elapsedSec: 0,
      error: 'The recording is empty.',
    });
    for (const track of streams[0]?.tracks ?? []) expect(track.stop).toHaveBeenCalledOnce();
  });

  it('counts a recorder that stopped by itself (the microphone was unplugged) as Stop and add', async () => {
    const { recorder, clock, upload, recorders } = await recording();
    clock.now += 2000;
    const [only] = recorders;
    only?.ondataavailable?.({ data: new Blob(['abc']) });
    only?.onstop?.();
    await flush();
    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0]?.[0]).toMatchObject({ atSec: 2.4, audioSec: 2 });
    expect(recorder.getSnapshot().phase).toBe('idle');
  });

  it('still finishes when the recorder refuses to stop because it is already inactive', async () => {
    const { recorder, recorders, upload } = await recording();
    const [only] = recorders;
    only?.stop.mockImplementationOnce(() => {
      throw new Error('InvalidStateError');
    });
    only?.ondataavailable?.({ data: new Blob(['abc']) });
    recorder.stop();
    await flush();
    expect(upload).toHaveBeenCalledOnce();
  });
});

describe('when the upload fails', () => {
  it('keeps the recording, says why, and uploads the same Blob on Try again', async () => {
    let attempts = 0;
    const { recorder, upload } = await recording({
      upload: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('A voice note can be at most 5 minutes long.');
        return {};
      },
    });
    recorder.stop();
    await flush();

    expect(recorder.getSnapshot()).toEqual({
      phase: 'failed',
      pinnedSec: 2.4,
      elapsedSec: 0,
      error: "Couldn't add the voice note: A voice note can be at most 5 minutes long.",
    });

    const retried = recorder.retry();
    expect(recorder.getSnapshot()).toMatchObject({ phase: 'saving', error: null });
    await retried;
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1]?.[0].audio).toBe(upload.mock.calls[0]?.[0].audio);
    expect(recorder.getSnapshot().phase).toBe('idle');
  });

  it('can fail again, and Try again keeps working', async () => {
    const { recorder, upload } = await recording({
      upload: () => Promise.reject(new Error('offline')),
    });
    recorder.stop();
    await flush();
    await recorder.retry();
    expect(recorder.getSnapshot()).toMatchObject({
      phase: 'failed',
      error: "Couldn't add the voice note: offline",
    });
    await recorder.retry();
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it('discards the recording on Discard, without uploading again', async () => {
    const { recorder, upload } = await recording({
      upload: () => Promise.reject(new Error('offline')),
    });
    recorder.stop();
    await flush();
    recorder.discard();
    expect(recorder.getSnapshot().phase).toBe('idle');
    await recorder.retry();
    expect(upload).toHaveBeenCalledOnce();
  });

  it('only discards a failed upload', async () => {
    const { recorder } = await recording();
    recorder.discard();
    expect(recorder.getSnapshot().phase).toBe('recording');
  });
});

describe('cancel', () => {
  it('drops a recording: nothing is uploaded, the microphone is released, and the timer is gone', async () => {
    const { recorder, upload, streams, recorders } = await recording();
    recorder.cancel();
    expect(recorder.getSnapshot()).toEqual({
      phase: 'idle',
      pinnedSec: null,
      elapsedSec: 0,
      error: null,
    });
    expect(recorders[0]?.stop).toHaveBeenCalledOnce();
    for (const track of streams[0]?.tracks ?? []) expect(track.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await flush();
    expect(upload).not.toHaveBeenCalled();
    expect(recorder.getSnapshot().phase).toBe('idle');
  });

  it('while starting: goes idle at once, and the microphone that arrives late is released', async () => {
    const question = deferred<MediaStreamLike>();
    const { recorder, createRecorder, upload } = setup({ getUserMedia: () => question.promise });
    const started = recorder.start(2.4);
    recorder.cancel();
    expect(recorder.getSnapshot().phase).toBe('idle');

    const late = fakeStream();
    question.resolve(late.stream);
    await started;
    for (const track of late.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(createRecorder).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(recorder.getSnapshot().phase).toBe('idle');
  });

  it('while starting: a late refusal says nothing', async () => {
    const question = deferred<MediaStreamLike>();
    const { recorder } = setup({ getUserMedia: () => question.promise });
    const started = recorder.start(2.4);
    recorder.cancel();
    question.reject({ name: 'NotAllowedError' });
    await started;
    expect(recorder.getSnapshot().error).toBeNull();
  });

  it('while starting: a new Record is not mixed up with the cancelled one', async () => {
    const first = deferred<MediaStreamLike>();
    const second = fakeStream();
    const answers = [first.promise, Promise.resolve(second.stream)];
    const { recorder, createRecorder } = setup({
      getUserMedia: () => answers.shift() ?? Promise.reject(new Error('no more')),
    });
    const started = recorder.start(1);
    recorder.cancel();
    await recorder.start(5);
    expect(recorder.getSnapshot()).toMatchObject({ phase: 'recording', pinnedSec: 5 });

    const late = fakeStream();
    first.resolve(late.stream);
    await started;
    for (const track of late.tracks) expect(track.stop).toHaveBeenCalledOnce();
    for (const track of second.tracks) expect(track.stop).not.toHaveBeenCalled();
    expect(createRecorder).toHaveBeenCalledOnce();
    expect(recorder.getSnapshot()).toMatchObject({ phase: 'recording', pinnedSec: 5 });
  });

  it('does nothing when nothing is recording or the note is on its way', async () => {
    const hold = deferred();
    const { recorder } = await recording({ upload: () => hold.promise });
    recorder.stop();
    await flush();
    recorder.cancel();
    expect(recorder.getSnapshot().phase).toBe('saving');
    hold.resolve({});
    await flush();
    recorder.cancel();
    expect(recorder.getSnapshot().phase).toBe('idle');
  });
});

describe('release (the dialog closed)', () => {
  it('drops a recording and releases the microphone', async () => {
    const { recorder, upload, streams } = await recording();
    recorder.release();
    expect(recorder.getSnapshot().phase).toBe('idle');
    for (const track of streams[0]?.tracks ?? []) expect(track.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await flush();
    expect(upload).not.toHaveBeenCalled();
  });

  it('stays usable: a new recording works afterwards (React’s StrictMode releases and remounts)', async () => {
    const { recorder, upload, streams } = await recording();
    recorder.release();
    await recorder.start(7);
    expect(recorder.getSnapshot()).toMatchObject({ phase: 'recording', pinnedSec: 7 });
    recorder.stop();
    await flush();
    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0]?.[0].atSec).toBe(7);
    expect(streams).toHaveLength(2);
  });

  it('releases the microphone that arrives after the dialog closed', async () => {
    const question = deferred<MediaStreamLike>();
    const { recorder, createRecorder } = setup({ getUserMedia: () => question.promise });
    const started = recorder.start(2.4);
    recorder.release();
    const late = fakeStream();
    question.resolve(late.stream);
    await started;
    for (const track of late.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(createRecorder).not.toHaveBeenCalled();
  });

  it('lets an upload in flight finish on its own', async () => {
    const hold = deferred();
    const { recorder, upload } = await recording({ upload: () => hold.promise });
    recorder.stop();
    await flush();
    recorder.release();
    expect(recorder.getSnapshot().phase).toBe('saving');
    hold.resolve({});
    await flush();
    expect(upload).toHaveBeenCalledOnce();
    expect(recorder.getSnapshot().phase).toBe('idle');
  });

  it('discards a failed upload', async () => {
    const { recorder } = await recording({ upload: () => Promise.reject(new Error('offline')) });
    recorder.stop();
    await flush();
    recorder.release();
    expect(recorder.getSnapshot().phase).toBe('idle');
  });

  it('does nothing while idle', () => {
    const { recorder } = setup();
    const before = recorder.getSnapshot();
    recorder.release();
    expect(recorder.getSnapshot()).toBe(before);
  });
});

describe('the snapshot', () => {
  it('keeps its identity between changes and is a new object after each', async () => {
    const { recorder, clock } = setup();
    const listener = vi.fn();
    const unsubscribe = recorder.subscribe(listener);

    const idle = recorder.getSnapshot();
    expect(recorder.getSnapshot()).toBe(idle);

    await recorder.start(2.4);
    const running = recorder.getSnapshot();
    expect(running).not.toBe(idle);
    expect(recorder.getSnapshot()).toBe(running);

    clock.now += 1000;
    vi.advanceTimersByTime(RECORDER_TICK_MS);
    const ticked = recorder.getSnapshot();
    expect(ticked).not.toBe(running);
    expect(ticked.elapsedSec).toBe(1);
    expect(running.elapsedSec).toBe(0);

    // A tick that changes nothing is not a change.
    vi.advanceTimersByTime(RECORDER_TICK_MS);
    expect(recorder.getSnapshot()).toBe(ticked);

    expect(listener).toHaveBeenCalled();
    const calls = listener.mock.calls.length;
    unsubscribe();
    recorder.cancel();
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it('does not change when the error is cleared and there is none', () => {
    const { recorder } = setup();
    const before = recorder.getSnapshot();
    recorder.clearError();
    expect(recorder.getSnapshot()).toBe(before);
  });
});
