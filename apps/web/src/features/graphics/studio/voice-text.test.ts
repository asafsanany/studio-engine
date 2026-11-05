import { describe, expect, it, vi } from 'vitest';
import type { VoiceNoteUpload } from '@/data/api';
import {
  createVoiceRecorder,
  type MediaRecorderLike,
  type MediaStreamLike,
  type VoiceRecorderDeps,
} from '@/features/review/voice-recorder';
import { appendVoiceText } from './studio-logic';
import { micAction, voiceToText } from './voice-text';

describe('voiceToText', () => {
  it('types the recording out and hands the text over', async () => {
    const audio = new Blob(['abc'], { type: 'audio/webm' });
    const transcribe = vi.fn(async () => 'make it slower');
    const onText = vi.fn();
    await voiceToText(transcribe, onText)({ audio, atSec: 0, audioSec: 3 });
    expect(transcribe).toHaveBeenCalledWith(audio);
    expect(onText).toHaveBeenCalledWith('make it slower');
  });

  it('passes the engine’s refusal on to the recorder and hands over no text', async () => {
    const onText = vi.fn();
    const upload = voiceToText(async () => {
      throw new Error('Nothing was said in that recording.');
    }, onText);
    await expect(upload({ audio: new Blob(['x']), atSec: 0, audioSec: 1 })).rejects.toThrow(
      'Nothing was said in that recording.',
    );
    expect(onText).not.toHaveBeenCalled();
  });
});

describe('micAction', () => {
  it('starts when idle, stops while recording, drops a start that waits, and waits otherwise', () => {
    expect(micAction({ phase: 'idle' })).toBe('start');
    expect(micAction({ phase: 'recording' })).toBe('stop');
    expect(micAction({ phase: 'starting' })).toBe('cancel');
    expect(micAction({ phase: 'saving' })).toBe('none');
    expect(micAction({ phase: 'failed' })).toBe('none');
  });
});

// The shared recorder with the composer's upload, a fake microphone and a fake MediaRecorder: the
// text of a voice note lands in the draft, and a refusal keeps the recording for Try again.
describe('the composer’s recorder', () => {
  class FakeRecorder implements MediaRecorderLike {
    mimeType = 'audio/webm;codecs=opus';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start = vi.fn();
    stop = vi.fn(() => {
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['voice'], { type: 'audio/webm' }) });
        this.onstop?.();
      });
    });
  }

  function setup(transcribe: (audio: Blob) => Promise<string>) {
    let draft = 'Make it dark';
    const stream: MediaStreamLike = { getTracks: () => [{ stop: vi.fn() }] };
    const deps: VoiceRecorderDeps = {
      getUserMedia: async () => stream,
      createRecorder: () => new FakeRecorder(),
      isTypeSupported: () => true,
      upload: voiceToText(transcribe, (said) => {
        draft = appendVoiceText(draft, said);
      }),
    };
    return { recorder: createVoiceRecorder(deps), draft: () => draft };
  }

  async function record(recorder: ReturnType<typeof createVoiceRecorder>) {
    await recorder.start(0);
    expect(recorder.getSnapshot().phase).toBe('recording');
    recorder.stop();
    await vi.waitFor(() => expect(['idle', 'failed']).toContain(recorder.getSnapshot().phase));
  }

  it('adds the text of a voice note to the draft', async () => {
    const { recorder, draft } = setup(async () => 'and bigger');
    await record(recorder);
    expect(recorder.getSnapshot()).toMatchObject({ phase: 'idle', error: null });
    expect(draft()).toBe('Make it dark and bigger');
  });

  it('keeps the recording for Try again when the engine could not type it out', async () => {
    const attempts: Blob[] = [];
    let fail = true;
    const { recorder, draft } = setup(async (audio) => {
      attempts.push(audio);
      if (fail) throw new Error('The voice note could not be typed out. Try again, or type it.');
      return 'and bigger';
    });
    await record(recorder);
    expect(recorder.getSnapshot().phase).toBe('failed');
    expect(recorder.getSnapshot().error).toContain('The voice note could not be typed out.');
    expect(draft()).toBe('Make it dark');

    fail = false;
    await recorder.retry();
    expect(recorder.getSnapshot().phase).toBe('idle');
    expect(draft()).toBe('Make it dark and bigger');
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
  });

  it('drops a failed recording on Discard, with nothing added', async () => {
    const { recorder, draft } = setup(async () => {
      throw new Error('Nothing was said in that recording.');
    });
    await record(recorder);
    recorder.discard();
    expect(recorder.getSnapshot().phase).toBe('idle');
    expect(draft()).toBe('Make it dark');
  });

  it('uploads nothing when the recording is cancelled', async () => {
    const transcribe = vi.fn(async () => 'x');
    const { recorder } = setup(transcribe);
    await recorder.start(0);
    recorder.cancel();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(transcribe).not.toHaveBeenCalled();
    expect(recorder.getSnapshot().phase).toBe('idle');
  });

  it('hands the shared recorder the audio, which is the upload a graphic note sends', async () => {
    const seen: VoiceNoteUpload[] = [];
    const stream: MediaStreamLike = { getTracks: () => [{ stop: vi.fn() }] };
    const recorder = createVoiceRecorder({
      getUserMedia: async () => stream,
      createRecorder: () => new FakeRecorder(),
      isTypeSupported: () => true,
      upload: async (upload) => {
        seen.push(upload);
      },
    });
    await recorder.start(0);
    recorder.stop();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.audio.type).toContain('audio/webm');
    expect(seen[0]?.atSec).toBe(0);
  });
});
