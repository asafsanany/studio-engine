import { describe, expect, it, vi } from 'vitest';
import { browserRecorderDeps } from './use-voice-recorder';

// The hook itself needs a DOM (it is effects and a store subscription), which these tests do not
// have. What it hands to the recorder is `browserRecorderDeps(upload)`: the upload it was given,
// whatever that is (a review note's, or a graphic's voice note), and the browser's microphone.

describe('browserRecorderDeps', () => {
  it('uploads with the function it is given', async () => {
    const upload = vi.fn(async () => 'typed out');
    const deps = browserRecorderDeps(upload);
    const recording = { audio: new Blob(['x'], { type: 'audio/webm' }), atSec: 0, audioSec: 2 };
    await expect(deps.upload(recording)).resolves.toBe('typed out');
    expect(upload).toHaveBeenCalledWith(recording);
  });

  it('asks for the microphone, and says so when the page cannot (no secure page)', async () => {
    const deps = browserRecorderDeps(async () => undefined);
    await expect(deps.getUserMedia({ audio: true })).rejects.toMatchObject({
      name: 'NotSupportedError',
      message: 'The microphone needs a secure page (https or localhost).',
    });
  });

  it('records nothing where MediaRecorder does not exist', () => {
    const deps = browserRecorderDeps(async () => undefined);
    expect(deps.isTypeSupported('audio/webm;codecs=opus')).toBe(false);
  });
});
