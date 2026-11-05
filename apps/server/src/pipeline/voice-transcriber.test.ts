import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProcesses } from './process-tree.js';
import {
  briefLanguage,
  createVoiceTranscriber,
  FAKE_VOICE_FAIL_MARKER,
  FAKE_VOICE_TEXT,
  fakeTranscribeVoice,
  redactSecrets,
  TRANSCRIPTION_ERROR_CODES,
  type TranscribeVoiceOptions,
  TranscriptionError,
  transcribeVoice,
  voiceHelperPaths,
} from './voice-transcriber.js';

// The voice-note transcriber against the stand-in for video-use's helper
// (testdata/stub-transcribe.mjs): real processes, pipes and signals, no network, no key. The
// stub reads its scenario from the output folder (its working directory).

const STUB = fileURLToPath(new URL('./testdata/stub-transcribe.mjs', import.meta.url));
const KEY = 'sk_test_0123456789abcdef';

let root: string;
let outDir: string;
const leftovers: number[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-voice-')));
  outDir = join(root, 'job', 'edit', 'review', 'voice');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(audio('n1'), 'not really audio');
});

afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone, as it should be
    }
  }
  rmSync(root, { recursive: true, force: true });
});

function audio(stem: string, extension = 'webm'): string {
  return join(outDir, `${stem}.${extension}`);
}

function options(extra: Partial<TranscribeVoiceOptions> = {}): TranscribeVoiceOptions {
  return {
    home: root,
    env: { PATH: process.env.PATH, FOO: 'bar', ELEVENLABS_API_KEY: KEY },
    python: process.execPath,
    script: STUB,
    timeoutMs: 5_000,
    killGraceMs: 500,
    ...extra,
  };
}

interface Scenario {
  words?: unknown[];
  raw?: string;
  noOutput?: boolean;
  stderr?: string;
  exitCode?: number;
  waitFor?: string;
  hang?: boolean;
  grandchild?: boolean;
}

/** The scenario for every recording, or only for `stem`'s. */
function scenario(s: Scenario, stem?: string): void {
  const name = stem === undefined ? 'stub-transcribe.json' : `stub-transcribe.${stem}.json`;
  writeFileSync(join(outDir, name), JSON.stringify(s));
}

function callPath(stem = 'n1'): string {
  return join(outDir, `stub-transcribe.${stem}.call.json`);
}

interface Call {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  pid: number;
  grandchild?: number;
}

/** The stub's record of its call; its pids are killed after the test if they are still alive. */
function readCall(stem = 'n1'): Call {
  const call: Call = JSON.parse(readFileSync(callPath(stem), 'utf8'));
  leftovers.push(call.pid);
  if (call.grandchild !== undefined) leftovers.push(call.grandchild);
  return call;
}

async function waitForFile(path: string, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > until) throw new Error(`${path} never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The call record once the stub has also started its grandchild. */
async function waitForGrandchild(stem = 'n1'): Promise<Call> {
  await waitForFile(callPath(stem));
  const until = Date.now() + 3_000;
  while (Date.now() < until) {
    const call = readCall(stem);
    if (call.grandchild !== undefined) return call;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the stub never started its grandchild');
}

async function alive(...pids: (number | undefined)[]): Promise<number[]> {
  const live = new Set((await listProcesses()).map((proc) => proc.pid));
  return pids.filter((pid): pid is number => pid !== undefined && live.has(pid));
}

async function rejection(promise: Promise<unknown>): Promise<TranscriptionError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(TranscriptionError);
    return err as TranscriptionError;
  }
  throw new Error('expected a rejection');
}

function job(extra: { language?: string | null; signal?: AbortSignal } = {}, stem = 'n1') {
  return { audioPath: audio(stem), outDir, ...extra };
}

describe('voiceHelperPaths', () => {
  it('points into ~/Developer/video-use', () => {
    expect(voiceHelperPaths('/Users/x')).toEqual({
      python: '/Users/x/Developer/video-use/.venv/bin/python',
      script: '/Users/x/Developer/video-use/helpers/transcribe.py',
    });
  });
});

describe('TranscriptionError', () => {
  it('carries a code and a one-line message', () => {
    const error = new TranscriptionError('failed', 'one\ntwo');
    expect(error).toMatchObject({ name: 'TranscriptionError', code: 'failed', message: 'one two' });
    expect(TRANSCRIPTION_ERROR_CODES).toEqual([
      'cancelled',
      'stopped',
      'timed_out',
      'no_speech',
      'failed',
    ]);
  });

  it('redacts keys', () => {
    expect(redactSecrets('a sk_live_abcdefghijkl b')).toBe('a sk_… b');
  });
});

describe('transcribeVoice', () => {
  it('runs the helper as [audio, --edit-dir, outDir] in outDir and resolves the words', async () => {
    const transcript = await transcribeVoice(job(), options());

    expect(transcript).toEqual({ text: 'stub' });
    const call = readCall();
    expect(call.argv).toEqual([audio('n1'), '--edit-dir', outDir]);
    expect(realpathSync(call.cwd)).toBe(realpathSync(outDir));
  });

  it("adds --language for a two-letter code, e.g. 'he'", async () => {
    await transcribeVoice(job({ language: 'he' }), options());
    expect(readCall().argv).toEqual([audio('n1'), '--edit-dir', outDir, '--language', 'he']);
  });

  it.each([null, undefined, '', 'HE', 'heb', 'he-IL'])(
    'adds no --language for %j',
    async (language) => {
      await transcribeVoice(job({ language }), options());
      expect(readCall().argv).toEqual([audio('n1'), '--edit-dir', outDir]);
    },
  );

  it('gives the helper the minimal environment, without the ElevenLabs key', async () => {
    await transcribeVoice(job(), options());

    const { env } = readCall();
    expect(env.ELEVENLABS_API_KEY).toBeUndefined();
    expect(env.FOO).toBeUndefined();
    expect(env.HOME).toBe(root);
    expect(env.STUDIO_ENGINE_RUN).toMatch(/^voice-/);
    expect(env.PATH).toContain('/opt/homebrew/bin');
    expect(JSON.stringify(env)).not.toContain(KEY);
  });

  it('joins a Hebrew transcript with spacing entries and an audio event', async () => {
    const entries = [
      { text: 'הכותרת', type: 'word' },
      { text: ' ', type: 'spacing' },
      { text: '[צליפת לשון]', type: 'audio_event' },
      { text: ' ', type: 'spacing' },
      { text: 'יורדת', type: 'word' },
      { text: ' ', type: 'spacing' },
      { text: 'מהר,', type: 'word' },
    ];
    scenario({ words: entries });
    await expect(transcribeVoice(job(), options())).resolves.toEqual({ text: 'הכותרת יורדת מהר,' });
  });

  it('reads a transcript left by an earlier run without starting the helper', async () => {
    mkdirSync(join(outDir, 'transcripts'));
    writeFileSync(
      join(outDir, 'transcripts', 'n1.json'),
      JSON.stringify({ words: [{ text: 'cached', type: 'word' }] }),
    );

    await expect(transcribeVoice(job(), options({ python: '/no/such/python' }))).resolves.toEqual({
      text: 'cached',
    });
    expect(existsSync(callPath())).toBe(false);
  });

  it('removes a broken transcript and runs the helper', async () => {
    mkdirSync(join(outDir, 'transcripts'));
    writeFileSync(join(outDir, 'transcripts', 'n1.json'), '{ broken');

    await expect(transcribeVoice(job(), options())).resolves.toEqual({ text: 'stub' });
    expect(existsSync(callPath())).toBe(true);
  });

  it('fails with the helper’s last stderr line and keeps keys out of the message', async () => {
    scenario({
      stderr: `Traceback (most recent call last):\n  File "transcribe.py", line 1\nRuntimeError: Scribe returned 401: bad key sk_live_abcdefghijkl\n`,
      noOutput: true,
      exitCode: 1,
    });
    const error = await rejection(transcribeVoice(job(), options()));

    expect(error.code).toBe('failed');
    expect(error.message).toBe(
      'The transcribe helper failed: RuntimeError: Scribe returned 401: bad key sk_…',
    );
    expect(error.message).not.toContain('abcdefghijkl');
  });

  it('says so when the helper has no ElevenLabs key', async () => {
    scenario({
      stderr: 'ELEVENLABS_API_KEY not found in .env or environment\n',
      noOutput: true,
      exitCode: 1,
    });
    const error = await rejection(transcribeVoice(job(), options()));

    expect(error.code).toBe('failed');
    expect(error.message).toBe(
      "No ElevenLabs key, so voice notes can't be transcribed. Run `pnpm run doctor`.",
    );
  });

  it('reports the exit code or the signal when the helper wrote nothing to stderr', async () => {
    scenario({ noOutput: true, exitCode: 3 });
    const error = await rejection(transcribeVoice(job(), options()));
    expect(error.message).toBe('The transcribe helper failed: exited with code 3');
  });

  it('turns a silent recording into no_speech', async () => {
    scenario({
      stderr:
        'Traceback (most recent call last):\nRuntimeError: track 1 of n1.webm is silent (peak -80.0 dBFS) - not uploading.\n',
      noOutput: true,
      exitCode: 1,
    });
    const error = await rejection(transcribeVoice(job(), options()));

    expect(error.code).toBe('no_speech');
    expect(error.message).toBe('The voice note is silent.');
  });

  it('turns a transcript with no words, or only audio events, into no_speech', async () => {
    for (const words of [[], [{ text: '[מוזיקה]', type: 'audio_event' }]]) {
      rmSync(join(outDir, 'transcripts'), { recursive: true, force: true });
      scenario({ words });
      const error = await rejection(transcribeVoice(job(), options()));
      expect(error.code).toBe('no_speech');
      expect(error.message).toBe('No speech was heard in the voice note.');
    }
  });

  it('fails when the helper wrote no transcript', async () => {
    scenario({ noOutput: true });
    const error = await rejection(transcribeVoice(job(), options()));
    expect(error.code).toBe('failed');
    expect(error.message).toBe('The transcribe helper finished without writing a transcript.');
  });

  it('fails, and removes the file, when the transcript is not JSON', async () => {
    scenario({ raw: '{' });
    const error = await rejection(transcribeVoice(job(), options()));

    expect(error.code).toBe('failed');
    expect(error.message).toMatch(/^The transcript could not be read: /);
    expect(existsSync(join(outDir, 'transcripts', 'n1.json'))).toBe(false);
  });

  it('fails, without starting anything, for a missing audio file', async () => {
    const error = await rejection(transcribeVoice(job({}, 'gone'), options()));
    expect(error).toMatchObject({
      code: 'failed',
      message: "The voice note's audio file is missing.",
    });
    expect(existsSync(callPath('gone'))).toBe(false);
  });

  it('fails, without starting anything, for an empty audio file', async () => {
    writeFileSync(audio('empty'), '');
    const error = await rejection(transcribeVoice(job({}, 'empty'), options()));
    expect(error).toMatchObject({
      code: 'failed',
      message: "The voice note's audio file is empty.",
    });
    expect(existsSync(callPath('empty'))).toBe(false);
  });

  it('fails, without starting anything, for a relative path', async () => {
    const relative = { audioPath: 'n1.webm', outDir };
    const error = await rejection(transcribeVoice(relative, options()));
    expect(error).toMatchObject({
      code: 'failed',
      message: 'The audio path and the output folder must be absolute.',
    });
    const relativeDir = { audioPath: audio('n1'), outDir: 'voice' };
    expect((await rejection(transcribeVoice(relativeDir, options()))).code).toBe('failed');
    expect(existsSync(callPath())).toBe(false);
  });

  it('fails, without starting anything, for a missing Python or helper script', async () => {
    const python = join(root, 'no-python');
    const noPython = await rejection(transcribeVoice(job(), options({ python })));
    expect(noPython).toMatchObject({
      code: 'failed',
      message: `video-use's Python was not found at ${python.replace(root, `~`)}. Run \`pnpm run doctor\`.`,
    });

    const script = join(root, 'Developer', 'transcribe.py');
    const noScript = await rejection(transcribeVoice(job(), options({ script })));
    expect(noScript).toMatchObject({
      code: 'failed',
      message: `video-use's transcribe helper was not found at ~/Developer/transcribe.py. Run \`pnpm run doctor\`.`,
    });
    expect(existsSync(callPath())).toBe(false);
  });

  it('fails with the reason when the Python cannot be started', async () => {
    const python = join(root, 'bad-python');
    writeFileSync(python, 'this is not a program');
    chmodSync(python, 0o755);
    const error = await rejection(transcribeVoice(job(), options({ python })));

    expect(error.code).toBe('failed');
    expect(error.message).toMatch(/^The transcribe helper failed: could not start ~\/bad-python: /);
  });

  it('stops what the helper left behind when it ends on its own', async () => {
    scenario({ grandchild: true });
    await expect(transcribeVoice(job(), options())).resolves.toEqual({ text: 'stub' });

    const call = readCall();
    expect(call.grandchild).toBeTypeOf('number');
    expect(await alive(call.pid, call.grandchild)).toEqual([]);
  });

  it('stops the helper and everything it started at the time limit', async () => {
    scenario({ hang: true, grandchild: true });
    const startedAt = Date.now();
    const error = await rejection(transcribeVoice(job(), options({ timeoutMs: 1_000 })));

    expect(error.code).toBe('timed_out');
    expect(error.message).toBe('Transcribing took longer than 1 s.');
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    const call = readCall();
    expect(call.grandchild).toBeTypeOf('number');
    expect(await alive(call.pid, call.grandchild)).toEqual([]);
  });

  it('stops the helper and everything it started on a cancel', async () => {
    scenario({ hang: true, grandchild: true });
    const controller = new AbortController();
    const running = rejection(transcribeVoice(job({ signal: controller.signal }), options()));
    const call = await waitForGrandchild();
    controller.abort();
    const error = await running;

    expect(error.code).toBe('cancelled');
    expect(error.message).toBe('The transcription was cancelled.');
    expect(await alive(call.pid, call.grandchild)).toEqual([]);
  });

  it("reports a signal aborted with the reason 'stopped' as stopped", async () => {
    scenario({ hang: true });
    const controller = new AbortController();
    const running = rejection(transcribeVoice(job({ signal: controller.signal }), options()));
    await waitForFile(callPath());
    controller.abort('stopped');
    const error = await running;

    expect(error.code).toBe('stopped');
    expect(error.message).toBe('The transcription was stopped: the engine is shutting down.');
    expect(await alive(readCall().pid)).toEqual([]);
  });

  it('is cancelled at once, without a process, when the signal is already aborted', async () => {
    const error = await rejection(transcribeVoice(job({ signal: AbortSignal.abort() }), options()));
    expect(error.code).toBe('cancelled');
    expect(existsSync(callPath())).toBe(false);
  });
});

describe('fakeTranscribeVoice', () => {
  /** A sleep that records how long it was asked to wait and returns at once. */
  function recorder() {
    const waits: number[] = [];
    return {
      waits,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    };
  }

  it('waits a second divided by the speed, then writes a Scribe-shaped transcript', async () => {
    const { waits, sleep } = recorder();
    await expect(fakeTranscribeVoice(job(), { speed: 4, sleep })).resolves.toEqual({
      text: FAKE_VOICE_TEXT,
    });

    expect(waits).toEqual([250]);
    const written = JSON.parse(readFileSync(join(outDir, 'transcripts', 'n1.json'), 'utf8'));
    expect(written).toMatchObject({ fake: true, text: FAKE_VOICE_TEXT, language_code: 'eng' });
    expect(written.words).toHaveLength(FAKE_VOICE_TEXT.split(' ').length);
  });

  it('reads its own transcript back for free the second time', async () => {
    const { waits, sleep } = recorder();
    await fakeTranscribeVoice(job(), { sleep });
    await expect(fakeTranscribeVoice(job(), { sleep })).resolves.toEqual({ text: FAKE_VOICE_TEXT });
    expect(waits).toEqual([1_000]);
  });

  it('fails after 40% of the wait when .fail-transcribe is in the output folder', async () => {
    writeFileSync(join(outDir, FAKE_VOICE_FAIL_MARKER), '');
    const { waits, sleep } = recorder();
    const error = await rejection(fakeTranscribeVoice(job(), { speed: 4, sleep }));

    expect(error.code).toBe('failed');
    expect(error.message).toBe('Transcription failed: injected failure (.fail-transcribe)');
    expect(waits).toEqual([100]);
    expect(existsSync(join(outDir, 'transcripts', 'n1.json'))).toBe(false);
  });

  it('is cancelled by an abort during the wait and writes nothing', async () => {
    const controller = new AbortController();
    const sleep = async () => controller.abort();
    const error = await rejection(
      fakeTranscribeVoice(job({ signal: controller.signal }), { sleep }),
    );

    expect(error.code).toBe('cancelled');
    expect(existsSync(join(outDir, 'transcripts', 'n1.json'))).toBe(false);
  });

  it('fails for an empty or missing audio file, like the real one', async () => {
    writeFileSync(audio('empty'), '');
    const { sleep } = recorder();
    expect((await rejection(fakeTranscribeVoice(job({}, 'empty'), { sleep }))).message).toBe(
      "The voice note's audio file is empty.",
    );
    expect((await rejection(fakeTranscribeVoice(job({}, 'gone'), { sleep }))).message).toBe(
      "The voice note's audio file is missing.",
    );
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects the speed %j', async (speed) => {
    await expect(fakeTranscribeVoice(job(), { speed })).rejects.toThrow(RangeError);
  });
});

describe('createVoiceTranscriber', () => {
  function seed(...stems: string[]): void {
    for (const stem of stems) writeFileSync(audio(stem), 'not really audio');
  }

  it('runs at most two jobs at a time, in the order they were queued', async () => {
    seed('n2', 'n3');
    for (const stem of ['n1', 'n2', 'n3']) scenario({ waitFor: `go-${stem}` }, stem);
    const transcriber = createVoiceTranscriber({ kind: 'real', ...options() });

    const first = transcriber.enqueue(job({}, 'n1'));
    const second = transcriber.enqueue(job({}, 'n2'));
    const third = transcriber.enqueue(job({}, 'n3'));
    await waitForFile(callPath('n1'));
    await waitForFile(callPath('n2'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(callPath('n3'))).toBe(false);

    writeFileSync(join(outDir, 'go-n1'), '');
    await expect(first).resolves.toEqual({ text: 'stub' });
    await waitForFile(callPath('n3'));

    writeFileSync(join(outDir, 'go-n2'), '');
    writeFileSync(join(outDir, 'go-n3'), '');
    await expect(Promise.all([second, third])).resolves.toEqual([
      { text: 'stub' },
      { text: 'stub' },
    ]);
    await transcriber.stop();
  });

  it('drops a queued job whose signal aborts, at once, and never starts it', async () => {
    seed('n2');
    scenario({ waitFor: 'go-n1' }, 'n1');
    const transcriber = createVoiceTranscriber({ kind: 'real', concurrency: 1, ...options() });

    const first = transcriber.enqueue(job({}, 'n1'));
    await waitForFile(callPath('n1'));
    const controller = new AbortController();
    const second = rejection(transcriber.enqueue(job({ signal: controller.signal }, 'n2')));
    controller.abort();
    expect((await second).code).toBe('cancelled');

    writeFileSync(join(outDir, 'go-n1'), '');
    await expect(first).resolves.toEqual({ text: 'stub' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(callPath('n2'))).toBe(false);
    await transcriber.stop();
  });

  it('stops a running job whose signal aborts', async () => {
    scenario({ hang: true });
    const transcriber = createVoiceTranscriber({ kind: 'real', ...options() });
    const controller = new AbortController();

    const running = rejection(transcriber.enqueue(job({ signal: controller.signal })));
    await waitForFile(callPath());
    const { pid } = readCall();
    controller.abort();

    expect((await running).code).toBe('cancelled');
    expect(await alive(pid)).toEqual([]);
    await transcriber.stop();
  });

  it('rejects at once a job whose signal is already aborted, and queues nothing', async () => {
    const transcriber = createVoiceTranscriber({ kind: 'real', ...options() });
    const error = await rejection(transcriber.enqueue(job({ signal: AbortSignal.abort() })));
    expect(error.code).toBe('cancelled');
    expect(existsSync(callPath())).toBe(false);
    await transcriber.stop();
  });

  it('applies the time limit to every running job', async () => {
    scenario({ hang: true });
    const transcriber = createVoiceTranscriber({
      kind: 'real',
      ...options({ timeoutMs: 1_000 }),
    });

    const error = await rejection(transcriber.enqueue(job()));

    expect(error.code).toBe('timed_out');
    expect(await alive(readCall().pid)).toEqual([]);
    await transcriber.stop();
  });

  it('stop() ends the running job, rejects the queued one and refuses new ones', async () => {
    seed('n2');
    scenario({ hang: true }, 'n1');
    const transcriber = createVoiceTranscriber({ kind: 'real', concurrency: 1, ...options() });

    const running = expect(transcriber.enqueue(job({}, 'n1'))).rejects.toMatchObject({
      code: 'stopped',
    });
    const queued = expect(transcriber.enqueue(job({}, 'n2'))).rejects.toMatchObject({
      code: 'stopped',
    });
    await waitForFile(callPath('n1'));
    const { pid } = readCall('n1');

    await transcriber.stop();

    expect(await alive(pid)).toEqual([]);
    await running;
    await queued;
    expect(existsSync(callPath('n2'))).toBe(false);
    await expect(transcriber.enqueue(job({}, 'n1'))).rejects.toMatchObject({ code: 'stopped' });
    await expect(transcriber.stop()).resolves.toBeUndefined();
  });

  it('gives two jobs for the same recording one helper and one result', async () => {
    scenario({ waitFor: 'go' });
    const transcriber = createVoiceTranscriber({ kind: 'real', ...options() });

    const first = transcriber.enqueue(job());
    const second = transcriber.enqueue(job({ language: 'he' }));
    expect(second).toBe(first);
    await waitForFile(callPath());
    writeFileSync(join(outDir, 'go'), '');

    await expect(first).resolves.toEqual({ text: 'stub' });
    // Done: a new job for it is a new job again (here, answered from the transcript on disk).
    expect(transcriber.enqueue(job())).not.toBe(first);
    await transcriber.stop();
  });

  it('wraps an unexpected error in a failed TranscriptionError', async () => {
    const transcriber = createVoiceTranscriber({
      kind: 'fake',
      sleep: async () => {
        throw new Error('boom');
      },
    });

    const error = await rejection(transcriber.enqueue(job()));

    expect(error.code).toBe('failed');
    expect(error.message).toBe('boom');
    await transcriber.stop();
  });

  it('answers with the fake text, end to end', async () => {
    const transcriber = createVoiceTranscriber({ kind: 'fake', speed: 100 });

    expect(transcriber.kind).toBe('fake');
    await expect(transcriber.enqueue(job())).resolves.toEqual({ text: FAKE_VOICE_TEXT });
    await transcriber.stop();
  });

  it('keeps the key and the environment out of the log', async () => {
    const lines: string[] = [];
    const record = (obj: object, msg: string) => lines.push(`${msg} ${JSON.stringify(obj)}`);
    const logger = { info: record, warn: record, error: record };
    const transcriber = createVoiceTranscriber({ kind: 'real', logger, ...options() });

    await transcriber.enqueue(job({ language: 'he' }));
    scenario(
      { stderr: 'RuntimeError: Scribe returned 401: bad key sk_live_abcdefghijkl\n', exitCode: 1 },
      'n2',
    );
    seed('n2');
    await rejection(transcriber.enqueue(job({}, 'n2')));
    await transcriber.stop();

    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('voice note transcribed');
    expect(lines[0]).toContain('"audio":"n1.webm"');
    expect(lines[1]).toContain('voice note not transcribed');
    const all = lines.join('\n');
    expect(all).not.toContain(KEY);
    expect(all).not.toContain('abcdefghijkl');
    expect(all).not.toContain('FOO');
  });

  it.each([0, 1.5, -1, Number.NaN])('rejects the concurrency %j', (concurrency) => {
    expect(() => createVoiceTranscriber({ kind: 'fake', concurrency })).toThrow(RangeError);
  });

  it.each([0, -2, Number.NaN])('rejects the speed %j', (speed) => {
    expect(() => createVoiceTranscriber({ kind: 'fake', speed })).toThrow(RangeError);
  });
});

describe('briefLanguage', () => {
  function writeBrief(text: string): void {
    mkdirSync(join(root, 'job', 'edit'), { recursive: true });
    writeFileSync(join(root, 'job', 'edit', 'brief.json'), text);
  }

  it("is the brief's two-letter language", async () => {
    writeBrief(JSON.stringify({ language: 'he' }));
    await expect(briefLanguage(join(root, 'job'))).resolves.toBe('he');
  });

  it.each([{ language: null }, { language: 'heb' }, {}, [], null, 'he'])(
    'is null for the brief %j',
    async (brief) => {
      writeBrief(JSON.stringify(brief));
      await expect(briefLanguage(join(root, 'job'))).resolves.toBeNull();
    },
  );

  it('is null for a missing file and for broken JSON', async () => {
    await expect(briefLanguage(join(root, 'job'))).resolves.toBeNull();
    writeBrief('{');
    await expect(briefLanguage(join(root, 'job'))).resolves.toBeNull();
  });
});
