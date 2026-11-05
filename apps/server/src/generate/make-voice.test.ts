import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_GENERATE_VOICE_ID,
  GENERATE_ERROR_CODES,
  GENERATE_EXIT_CODES,
  GENERATE_VOICE_LEAD_MAX_MS,
  type GenerateErrorCode,
  generateErrorMessage,
  generateExitCode,
  generateVoiceWordsSchema,
  type MakeVoiceLine,
  makeVoiceLineSchema,
} from '@studio/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_VOICE_ID,
  directionTags,
  ELEVENLABS,
  EXIT,
  EXIT_FOR,
  failureFor,
  isInside,
  loudnessGain,
  MASTER,
  MESSAGES,
  parseArgs,
  parseLead,
  parseOrder,
  parsePauses,
  readKey,
  redact,
  speechBody,
} from '../../assets/generate/make-voice.mjs';
import { resolveFfmpeg } from '../pipeline/fake-media.js';
import { makeTempDir } from '../test-temp.js';

// The voice script (assets/generate/make-voice.mjs): its arguments, how it reads ElevenLabs'
// refusals, and every command run for real in a temp edit folder against a local stub of ElevenLabs
// (VOICE_API_BASE). What it prints is read back through the shared contract's schema, and its exit
// codes are the contract's. No test ever reads the real key: every run gets its own HOME.

const SCRIPT = fileURLToPath(new URL('../../assets/generate/make-voice.mjs', import.meta.url));
const SILENCE = fileURLToPath(
  new URL('../../assets/generate/testdata/silence-1s.mp3', import.meta.url),
);

const ffmpeg = await resolveFfmpeg('ffmpeg');
const ffprobe = await resolveFfmpeg('ffprobe');
const haveTools = ffmpeg !== null && ffprobe !== null;
if (!haveTools) {
  console.warn(
    'make-voice.test.ts: ffmpeg/ffprobe not found on PATH or in /opt/homebrew/bin; skipping the assemble runs (brew install ffmpeg)',
  );
}

/** A key that looks like ElevenLabs' and is nobody's. */
const KEY = `sk_test_${randomBytes(16).toString('hex')}`;

/** A HOME for one run: with video-use's .env holding `key`, or none. */
function homeWith(key: string | null): string {
  const home = makeTempDir('studio-voice-home-');
  if (key !== null) {
    mkdirSync(join(home, 'Developer', 'video-use'), { recursive: true });
    writeFileSync(
      join(home, 'Developer', 'video-use', '.env'),
      `# video-use\nELEVENLABS_API_KEY=${key}\n`,
    );
  }
  return home;
}

/** The environment without anything that could reach the real ElevenLabs or change the script. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name === 'ELEVENLABS_API_KEY' || name.startsWith('VOICE_')) continue;
    if (name.startsWith('STUDIO_GENERATE')) continue;
    env[name] = value;
  }
  // Nothing listens on the discard port: a run that tries the network fails fast.
  return { ...env, HOME: homeWith(KEY), VOICE_API_BASE: 'http://127.0.0.1:9', VOICE_RETRY_MS: '0' };
}

interface Ran {
  status: number | null;
  line: MakeVoiceLine;
  stdout: string;
  stderr: string;
}

function parseRun(status: number | null, stdout: string, stderr: string): Ran {
  const lines = stdout.trim().split('\n');
  expect(lines, `one line on stdout: ${stdout}${stderr}`).toHaveLength(1);
  const line = makeVoiceLineSchema.parse(JSON.parse(lines[0] ?? ''));
  // The exit code is the shared contract's for the line, and the key is nowhere.
  expect(status).toBe(line.ok ? GENERATE_EXIT_CODES.ok : generateExitCode(line.code));
  expect(`${stdout}${stderr}`).not.toContain(KEY);
  expect(stderr).toBe('');
  return { status, line, stdout, stderr };
}

/** Runs the script as the Generate run would, and waits for it (async: the stub runs in this process). */
function voice(args: string[], env: Record<string, string> = {}): Promise<Ran> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...cleanEnv(), ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', fail);
    child.on('close', (status) => {
      try {
        done(parseRun(status, stdout, stderr));
      } catch (err) {
        fail(err);
      }
    });
  });
}

/** What came back, narrowed to a success line of `command`. */
function ok<C extends 'line' | 'check' | 'assemble' | 'sfx'>(
  ran: Ran,
  command: C,
): Extract<MakeVoiceLine, { ok: true; command: C }> {
  expect(ran.line, JSON.stringify(ran.line)).toMatchObject({ ok: true, command });
  return ran.line as Extract<MakeVoiceLine, { ok: true; command: C }>;
}

function failed(ran: Ran): Extract<MakeVoiceLine, { ok: false }> {
  expect(ran.line.ok, JSON.stringify(ran.line)).toBe(false);
  return ran.line as Extract<MakeVoiceLine, { ok: false }>;
}

// --- the stub of ElevenLabs ----------------------------------------------------------------------

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  raw: Buffer;
  body: Record<string, unknown>;
}

interface Reply {
  status?: number;
  json?: unknown;
  body?: Buffer;
  headers?: Record<string, string>;
  hang?: boolean;
}

const stub = { seen: [] as Seen[], replies: [] as Reply[], audio: readFileSync(SILENCE) };
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        // Not JSON (the transcription is multipart).
      }
      stub.seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        raw,
        body,
      });
      const reply: Reply = stub.replies.shift() ?? {};
      if (reply.hang) return;
      if (reply.json !== undefined || (req.url ?? '').startsWith('/v1/speech-to-text')) {
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.json ?? scribe([])));
        return;
      }
      res.writeHead(reply.status ?? 200, {
        'content-type': 'audio/mpeg',
        ...(reply.headers ?? {}),
      });
      res.end(reply.body ?? stub.audio);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
});

beforeEach(() => {
  stub.seen = [];
  stub.replies = [];
  stub.audio = readFileSync(SILENCE);
});

/** Scribe's answer for words with their times in seconds: words with the spaces between them. */
function scribe(words: [text: string, start: number, end: number][]): unknown {
  return {
    language_code: 'eng',
    text: words.map(([text]) => text).join(' '),
    words: words.flatMap(([text, start, end], at) => [
      { text, start, end, type: 'word', logprob: -0.1 },
      ...(at < words.length - 1
        ? [{ text: ' ', start: end, end: words[at + 1]?.[1] ?? end, type: 'spacing' }]
        : []),
    ]),
  };
}

/** The first request the stub saw whose path starts with `prefix`. */
function request(prefix: string): Seen {
  const found = stub.seen.find((seen) => seen.url.startsWith(prefix));
  expect(
    found,
    `a request to ${prefix}; saw ${stub.seen.map((s) => s.url).join(', ')}`,
  ).toBeDefined();
  return found as Seen;
}

/** An environment that points at the stub. */
const viaStub = (): Record<string, string> => ({ VOICE_API_BASE: base });

/** A fresh edit folder, with `generate/plan.json` when `voiceLines` are given. */
function editDir(voiceLines?: { id: string; text: string; direction: string | null }[]): string {
  const edit = join(makeTempDir('studio-voice-'), 'edit');
  mkdirSync(join(edit, 'generate'), { recursive: true });
  if (voiceLines) {
    writeFileSync(
      join(edit, 'generate', 'plan.json'),
      JSON.stringify({ voice: voiceLines, cast: [], clips: [] }),
    );
  }
  return edit;
}

const generateFile = (edit: string, ...parts: string[]): string => join(edit, 'generate', ...parts);

function lengthMs(file: string): number {
  const out = spawnSync(ffprobe as string, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  return Math.round(Number.parseFloat(out.stdout.toString()) * 1000);
}

/** Integrated loudness (LUFS) and true peak (dBTP), as ffmpeg's ebur128 measures them. */
function loudness(file: string): { integrated: number; truePeak: number } {
  const out = spawnSync(ffmpeg as string, [
    '-hide_banner',
    '-nostdin',
    '-i',
    file,
    '-af',
    'ebur128=peak=true',
    '-f',
    'null',
    '-',
  ]).stderr.toString();
  const summary = out.slice(out.lastIndexOf('Summary:'));
  return {
    integrated: Number.parseFloat(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1] ?? 'NaN'),
    truePeak: Number.parseFloat(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1] ?? 'NaN'),
  };
}

/** The loudest sample (dB) of `length` seconds of `file` from `from` seconds, as ffmpeg's volumedetect says it. */
function peakDb(file: string, from: number, length: number): number {
  const out = spawnSync(ffmpeg as string, [
    '-hide_banner',
    '-nostdin',
    '-ss',
    String(from),
    '-t',
    String(length),
    '-i',
    file,
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ]).stderr.toString();
  const peak = /max_volume:\s+(\S+) dB/.exec(out)?.[1] ?? 'NaN';
  return peak === '-inf' ? Number.NEGATIVE_INFINITY : Number.parseFloat(peak);
}

/** A mono tone of `sec` seconds as an mp3, the way ElevenLabs' speech comes (44.1 kHz, 128 kb/s). */
function writeTone(path: string, sec: number, frequency = 330): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const made = spawnSync(ffmpeg as string, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:sample_rate=44100:duration=${sec}`,
    '-ac',
    '1',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    path,
  ]);
  expect(made.status, made.stderr.toString()).toBe(0);
}

// --- the contract ---------------------------------------------------------------------------------

describe('the contract it shares', () => {
  it('has the shared contract’s exit codes, plain words and default voice', () => {
    expect(EXIT).toEqual(GENERATE_EXIT_CODES);
    expect(DEFAULT_VOICE_ID).toBe(DEFAULT_GENERATE_VOICE_ID);
    expect(MASTER.leadMaxMs).toBe(GENERATE_VOICE_LEAD_MAX_MS);
    for (const code of GENERATE_ERROR_CODES) {
      expect(MESSAGES[code as GenerateErrorCode], code).toBe(
        generateErrorMessage(code as GenerateErrorCode, {
          service: 'elevenlabs',
          needUsd: 4.1,
          budgetUsd: 3,
        }),
      );
      expect(EXIT_FOR[code as GenerateErrorCode], code).toBe(
        generateExitCode(code as GenerateErrorCode),
      );
    }
  });
});

/** A VoiceError whose detail (the specific words; its message is the contract's) matches. */
function detailing(pattern: RegExp) {
  return expect.objectContaining({ code: 'bad_request', detail: expect.stringMatching(pattern) });
}

describe('the arguments', () => {
  it('reads a command, the edit folder, one word and the options of that command', () => {
    const args = parseArgs(['line', '/e', 'L3', '--text', 'But it gets worse.', '--take', '2']);
    expect(args).toMatchObject({ command: 'line', editDir: '/e', word: 'L3' });
    expect(args.options.get('text')).toBe('But it gets worse.');
    expect(args.options.get('take')).toBe('2');
  });

  it.each([
    ['no command', []],
    ['an unknown command', ['dance', '/e']],
    ['no edit folder', ['line']],
    ['an option the command does not have', ['line', '/e', '--prompt', 'x']],
    ['an option with no value', ['sfx', '/e', '--prompt']],
    ['a key on the command line', ['line', '/e', '--key', 'abc']],
    ['a word too many', ['line', '/e', 'L1', 'L2']],
    ['a word for assemble', ['assemble', '/e', 'L1']],
  ])('refuses %s as a bad request', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });

  it('reads --lead for assemble only, as whole milliseconds from 0 to 6000', () => {
    const args = parseArgs(['assemble', '/e', '--order', 'L1:1', '--lead', '2800']);
    expect(args.options.get('lead')).toBe('2800');
    expect(() => parseArgs(['line', '/e', 'L1', '--lead', '2800'])).toThrow();
    expect(parseLead(undefined)).toBe(0);
    expect(parseLead('0')).toBe(0);
    expect(parseLead('2800')).toBe(2800);
    expect(parseLead('6000')).toBe(6000);
    expect(() => parseLead('6001')).toThrow(detailing(/--lead 6001 is too long.*6000 ms \(6 s\)/));
    for (const text of ['1.5', '-1', 'abc', '', '2 s', '2800ms', '1e3']) {
      expect(() => parseLead(text), text).toThrow(detailing(/--lead must be a whole number/));
    }
  });

  it('reads the order and the pauses', () => {
    expect(parseOrder('L1:2, L2:1')).toEqual([
      { id: 'L1', take: 2 },
      { id: 'L2', take: 1 },
    ]);
    expect(parseOrder('L1=1,L2=3')).toEqual([
      { id: 'L1', take: 1 },
      { id: 'L2', take: 3 },
    ]);
    expect(() => parseOrder('')).toThrow();
    expect(() => parseOrder('L1:0')).toThrow();
    expect(() => parseOrder('L1:1,L1:2')).toThrow(detailing(/twice/));
    expect(() => parseOrder('x:1')).toThrow();
    expect([...parsePauses('L1>L2:500,L2>L3:0')]).toEqual([
      ['L1>L2', 500],
      ['L2>L3', 0],
    ]);
    expect(parsePauses(undefined).size).toBe(0);
    expect(() => parsePauses('L1>L2')).toThrow();
    expect(() => parsePauses('L1>L2:99999')).toThrow();
  });

  it('knows what is inside a folder, through symlinks', () => {
    const outside = makeTempDir('studio-voice-out-');
    const edit = realpathSync(makeTempDir('studio-voice-in-'));
    mkdirSync(join(edit, 'generate'));
    expect(isInside(edit, join(edit, 'generate', 'voice', 'L1-take1.mp3'))).toBe(true);
    expect(isInside(edit, join(edit, '..', 'x.mp3'))).toBe(false);
    symlinkSync(outside, join(edit, 'link'));
    expect(isInside(edit, join(edit, 'link', 'x.mp3'))).toBe(false);
  });
});

describe('the key', () => {
  it('is read from video-use’s .env first, then the environment, and is taken out of messages', () => {
    const home = homeWith('plainkey0123456789abcdef');
    const file = join(home, 'Developer', 'video-use', '.env');
    expect(readKey({ ELEVENLABS_API_KEY: 'other' }, file)).toBe('plainkey0123456789abcdef');
    expect(readKey({ ELEVENLABS_API_KEY: ' fromenv ' }, join(home, 'none.env'))).toBe('fromenv');
    expect(readKey({}, join(home, 'none.env'))).toBeNull();
    expect(redact('the key plainkey0123456789abcdef is wrong, sk_abc_DEF too')).toBe(
      'the key [key] is wrong, sk_… too',
    );
    expect(redact('{"xi-api-key": "whatever"}')).toBe('{"xi-api-key": "[key]"}');
  });
});

describe('what the voice is told', () => {
  it('turns a direction into audio tags for Eleven v3, at most three of 40 characters', () => {
    expect(directionTags(null)).toBe('');
    expect(directionTags('')).toBe('');
    expect(directionTags('a clear stop after BUT, weighty question')).toBe(
      '[a clear stop after BUT] [weighty question] ',
    );
    expect(directionTags('one, two, three, four')).toBe('[one] [two] [three] ');
    expect(directionTags('[whispers] (slowly)')).toBe('[whispers slowly] ');
    const long = directionTags(`${'x'.repeat(30)} ${'y'.repeat(30)}`);
    expect(long.length).toBeLessThanOrEqual(45);
  });

  it('puts the tags before the text on v3 and leaves the text alone on v2', () => {
    const v3 = speechBody('But it gets worse.', 'weighty', ELEVENLABS.expressiveModel);
    expect(v3).toMatchObject({ sent: '[weighty] But it gets worse.', applied: true });
    expect(v3.body).toMatchObject({ text: '[weighty] But it gets worse.', model_id: 'eleven_v3' });
    const v2 = speechBody('But it gets worse.', 'weighty', ELEVENLABS.steadyModel);
    expect(v2).toMatchObject({ sent: 'But it gets worse.', applied: false });
    expect(v2.body).toMatchObject({
      text: 'But it gets worse.',
      model_id: 'eleven_multilingual_v2',
    });
    expect(speechBody('Hi.', null, ELEVENLABS.expressiveModel).applied).toBe(false);
  });
});

describe('how ElevenLabs’ refusals are read', () => {
  const detail = (status: string, message = '', type = 'authentication_error') => ({
    detail: { type, code: status, status, message },
  });

  it.each([
    [401, detail('invalid_api_key'), 'key_rejected', false],
    [
      401,
      detail(
        'missing_permissions',
        'The API key you used is missing the permission text_to_speech to execute this operation.',
      ),
      'key_rejected',
      false,
    ],
    [
      401,
      detail('quota_exceeded', 'This request exceeds your quota of 10000.'),
      'balance_empty',
      false,
    ],
    [402, 'payment', 'balance_empty', false],
    [403, 'forbidden', 'key_rejected', false],
    [429, detail('too_many_concurrent_requests', '', 'rate_limit_error'), 'unavailable', true],
    [429, 'slow down', 'unavailable', true],
    [500, 'oops', 'unavailable', true],
    [503, '', 'unavailable', true],
    [400, detail('invalid_text', 'bad text', 'invalid_request'), 'bad_request', false],
    [422, { detail: [{ loc: ['body', 'text'], msg: 'Field required' }] }, 'bad_request', false],
    [404, detail('voice_not_found', 'no such voice', 'not_found'), 'bad_request', false],
  ])('%s %j is %s (retry: %s)', (status, body, code, retry) => {
    const failure = failureFor(status, body);
    expect(failure.code).toBe(code);
    expect(failure.retry).toBe(retry);
    expect(failure.detail).toContain(String(status));
  });

  it('says which permission the key is missing', () => {
    const failure = failureFor(401, {
      detail: {
        status: 'missing_permissions',
        message: 'The API key you used is missing the permission text_to_speech to execute this.',
      },
    });
    expect(failure.message).toContain('"text_to_speech"');
    expect(failure.message).toContain('https://elevenlabs.io/app/settings/api-keys');
  });

  it('notices that the model was refused', () => {
    expect(
      failureFor(403, detail('model_access_denied', 'You cannot use eleven_v3 on this plan.'))
        .modelRefused,
    ).toBe(true);
    expect(failureFor(400, { detail: { message: 'Unknown model_id' } }).modelRefused).toBe(true);
    expect(failureFor(400, { detail: { message: 'text is empty' } }).modelRefused).toBeFalsy();
    expect(failureFor(401, detail('invalid_api_key')).modelRefused).toBeFalsy();
    expect(
      failureFor(401, detail('missing_permissions', 'missing the permission models_read'))
        .modelRefused,
    ).toBeFalsy();
  });
});

// --- line -----------------------------------------------------------------------------------------

describe('line', () => {
  it('writes the take, asks for the voice, the model and the tagged text, and says what it cost', async () => {
    const edit = editDir();
    stub.replies.push({ headers: { 'character-cost': '37' } });
    const ran = await voice(
      [
        'line',
        edit,
        '--id',
        'L3',
        '--text',
        'But it gets worse.',
        '--direction',
        'a clear stop after BUT',
      ],
      viaStub(),
    );
    const line = ok(ran, 'line');
    expect(line).toMatchObject({
      id: 'L3',
      take: 1,
      file: 'voice/L3-take1.mp3',
      characters: 37,
      chars: 37,
      model: 'eleven_v3',
      voice: DEFAULT_GENERATE_VOICE_ID,
      directionApplied: true,
    });
    expect(line.ms).toBeGreaterThan(0);
    expect(line.durationSec).toBeCloseTo((line.ms ?? 0) / 1000, 3);
    expect(readFileSync(generateFile(edit, 'voice', 'L3-take1.mp3'))).toEqual(stub.audio);

    const seen = request('/v1/text-to-speech/');
    expect(seen.url).toBe(
      `/v1/text-to-speech/${DEFAULT_GENERATE_VOICE_ID}?output_format=mp3_44100_128`,
    );
    expect(seen.method).toBe('POST');
    expect(seen.headers['xi-api-key']).toBe(KEY);
    expect(seen.body).toMatchObject({
      text: '[a clear stop after BUT] But it gets worse.',
      model_id: 'eleven_v3',
    });
  });

  it('counts the characters it sent when ElevenLabs does not say what it cost', async () => {
    const edit = editDir();
    const line = ok(
      await voice(['line', edit, '--id', 'L1', '--text', 'Do you know?'], viaStub()),
      'line',
    );
    expect(line).toMatchObject({ characters: 12, chars: 12, directionApplied: false });
  });

  it('numbers the takes, or makes the one asked for and drops the words of the take it replaces', async () => {
    const edit = editDir();
    const args = ['line', edit, '--id', 'L1', '--text', 'Hello there.'];
    expect(ok(await voice(args, viaStub()), 'line')).toMatchObject({ take: 1 });
    expect(ok(await voice(args, viaStub()), 'line')).toMatchObject({
      take: 2,
      file: 'voice/L1-take2.mp3',
    });
    expect(ok(await voice([...args, '--take', '5'], viaStub()), 'line')).toMatchObject({ take: 5 });
    expect(
      ok(await voice(['line', edit, '--id', 'L2', '--text', 'x y'], viaStub()), 'line'),
    ).toMatchObject({
      take: 1,
    });
    writeFileSync(generateFile(edit, 'voice', 'L1-take2.words.json'), '{}');
    await voice([...args, '--take', '2'], viaStub());
    expect(existsSync(generateFile(edit, 'voice', 'L1-take2.words.json'))).toBe(false);
    expect(
      readdirSync(generateFile(edit, 'voice'))
        .filter((name) => !name.startsWith('.'))
        .sort(),
    ).toEqual(['L1-take1.mp3', 'L1-take2.mp3', 'L1-take5.mp3', 'L2-take1.mp3']);
  });

  it('reads the text and the direction from plan.json when they are not given (the GN0 form)', async () => {
    const edit = editDir([
      { id: 'L1', text: 'Do you know what is in your windows?', direction: null },
      { id: 'L2', text: 'BUT it gets worse.', direction: 'a clear stop after BUT' },
    ]);
    ok(await voice(['line', edit, 'L2'], viaStub()), 'line');
    expect(request('/v1/text-to-speech/').body).toMatchObject({
      text: '[a clear stop after BUT] BUT it gets worse.',
    });
    // A direction that is given wins over the plan's, even an empty one.
    stub.seen = [];
    ok(await voice(['line', edit, 'L2', '--direction', '', '--take', '2'], viaStub()), 'line');
    expect(request('/v1/text-to-speech/').body).toMatchObject({ text: 'BUT it gets worse.' });
  });

  it('uses the voice the environment names, or --voice', async () => {
    const edit = editDir();
    const base3 = ['line', edit, '--id', 'L1', '--text', 'Hi there.'];
    await voice(base3, { ...viaStub(), STUDIO_GENERATE_VOICE_ID: 'JBFqnCBsd6RMkjVDRZzb' });
    expect(request('/v1/text-to-speech/').url).toContain('/JBFqnCBsd6RMkjVDRZzb?');
    stub.seen = [];
    await voice([...base3, '--voice', 'onwK4e9ZLuTAKqWW03F9'], {
      ...viaStub(),
      STUDIO_GENERATE_VOICE_ID: 'JBFqnCBsd6RMkjVDRZzb',
    });
    expect(request('/v1/text-to-speech/').url).toContain('/onwK4e9ZLuTAKqWW03F9?');
    const bad = failed(await voice([...base3, '--voice', '../../x'], viaStub()));
    expect(bad.code).toBe('bad_request');
  });

  it('falls back to Multilingual v2 when the account is refused Eleven v3, and says so', async () => {
    const edit = editDir();
    stub.replies.push({
      status: 403,
      json: { detail: { status: 'model_access_denied', message: 'eleven_v3 is not on your plan' } },
    });
    const line = ok(
      await voice(
        ['line', edit, '--id', 'L1', '--text', 'Hi there.', '--direction', 'weighty'],
        viaStub(),
      ),
      'line',
    );
    expect(line).toMatchObject({ model: 'eleven_multilingual_v2', directionApplied: false });
    expect(stub.seen).toHaveLength(2);
    expect(stub.seen[1]?.body).toMatchObject({
      text: 'Hi there.',
      model_id: 'eleven_multilingual_v2',
    });
    expect(existsSync(generateFile(edit, 'voice', 'L1-take1.mp3'))).toBe(true);
  });

  it('does not fall back for a refusal that is not about the model, nor with --model', async () => {
    const edit = editDir();
    stub.replies.push({ status: 401, json: { detail: { status: 'invalid_api_key' } } });
    expect(
      failed(await voice(['line', edit, '--id', 'L1', '--text', 'Hi there.'], viaStub())).code,
    ).toBe('key_rejected');
    expect(stub.seen).toHaveLength(1);
    stub.seen = [];
    stub.replies.push({ status: 400, json: { detail: { message: 'unknown model_id' } } });
    const refused = failed(
      await voice(
        ['line', edit, '--id', 'L1', '--text', 'Hi there.', '--model', 'eleven_v3'],
        viaStub(),
      ),
    );
    expect(refused.code).toBe('bad_request');
    expect(stub.seen).toHaveLength(1);
    expect(existsSync(generateFile(edit, 'voice'))).toBe(false);
  });

  it.each([
    ['no id', ['line', '<edit>', '--text', 'x']],
    ['an id that is not a line', ['line', '<edit>', '--id', 'x', '--text', 'x']],
    ['an id that is a path', ['line', '<edit>', '--id', '../L1', '--text', 'x']],
    ['no text and no plan', ['line', '<edit>', '--id', 'L1']],
    ['too long a text', ['line', '<edit>', '--id', 'L1', '--text', 'x'.repeat(5001)]],
    ['a take of 0', ['line', '<edit>', '--id', 'L1', '--text', 'x', '--take', '0']],
  ])('refuses %s as a bad request, without calling ElevenLabs', async (_label, template) => {
    const edit = editDir();
    const ran = await voice(
      template.map((arg) => (arg === '<edit>' ? edit : arg)),
      viaStub(),
    );
    expect(failed(ran)).toMatchObject({ code: 'bad_request', message: MESSAGES.bad_request });
    expect(ran.status).toBe(1);
    expect(stub.seen).toHaveLength(0);
  });
});

// --- check ----------------------------------------------------------------------------------------

describe('check', () => {
  /** An edit folder with one take of L2 ("But it gets worse.") and a Scribe answer for it. */
  function withTake(heard: [string, number, number][]): string {
    const edit = editDir();
    mkdirSync(generateFile(edit, 'voice'), { recursive: true });
    writeFileSync(generateFile(edit, 'voice', 'L2-take1.mp3'), stub.audio);
    stub.replies.push({ json: scribe(heard) });
    return edit;
  }

  const checkArgs = (edit: string, text: string) => [
    'check',
    edit,
    '--file',
    'voice/L2-take1.mp3',
    '--text',
    text,
  ];

  it('sends the take to Scribe and says it matches when every word was heard', async () => {
    const edit = withTake([
      ['But', 0.1, 0.35],
      ['it', 0.45, 0.55],
      ['gets', 0.6, 0.85],
      ['worse.', 0.9, 1.4],
    ]);
    const line = ok(await voice(checkArgs(edit, 'But it gets worse.'), viaStub()), 'check');
    expect(line).toMatchObject({
      id: 'L2',
      take: 1,
      file: 'voice/L2-take1.mp3',
      match: true,
      missing: [],
      extra: [],
      heard: 'But it gets worse.',
    });
    expect(line.words).toEqual([
      { text: 'But', startMs: 100, endMs: 350 },
      { text: 'it', startMs: 450, endMs: 550 },
      { text: 'gets', startMs: 600, endMs: 850 },
      { text: 'worse.', startMs: 900, endMs: 1400 },
    ]);

    const seen = request('/v1/speech-to-text');
    expect(seen.headers['xi-api-key']).toBe(KEY);
    expect(seen.headers['content-type']).toMatch(/^multipart\/form-data/);
    const form = seen.raw.toString('latin1');
    expect(form).toContain('scribe_v1');
    expect(form).toContain('name="timestamps_granularity"');
    expect(form).toContain('filename="L2-take1.mp3"');

    // The words are kept beside the take for assemble.
    const kept = JSON.parse(
      readFileSync(generateFile(edit, 'voice', 'L2-take1.words.json'), 'utf8'),
    );
    expect(kept).toMatchObject({ id: 'L2', take: 1, match: true, words: line.words });
  });

  it('shows a dropped "But" in missing', async () => {
    const edit = withTake([
      ['it', 0.1, 0.2],
      ['gets', 0.3, 0.5],
      ['worse.', 0.6, 1],
    ]);
    const line = ok(await voice(checkArgs(edit, 'But it gets worse.'), viaStub()), 'check');
    expect(line).toMatchObject({ match: false, missing: ['But'], extra: [] });
  });

  it('shows a word that was said instead of another as one missing and one extra', async () => {
    const edit = withTake([
      ['Bat', 0.1, 0.3],
      ['it', 0.4, 0.5],
      ['gets', 0.6, 0.8],
      ['worse.', 0.9, 1.2],
    ]);
    const line = ok(await voice(checkArgs(edit, 'But it gets worse.'), viaStub()), 'check');
    expect(line).toMatchObject({ match: false, missing: ['But'], extra: ['Bat'] });
  });

  it('counts "$97" and "ninety-seven dollars" as the same words, both ways', async () => {
    const heardAsWords = withTake([
      ['Ninety-seven', 0.1, 0.6],
      ['dollars,', 0.7, 1],
      ['today.', 1.1, 1.4],
    ]);
    expect(ok(await voice(checkArgs(heardAsWords, '$97 today'), viaStub()), 'check')).toMatchObject(
      { match: true, missing: [], extra: [] },
    );
    const heardAsDigits = withTake([
      ['97', 0.1, 0.6],
      ['dollars', 0.7, 1],
      ['today', 1.1, 1.4],
    ]);
    expect(
      ok(await voice(checkArgs(heardAsDigits, 'Ninety-seven dollars today.'), viaStub()), 'check'),
    ).toMatchObject({ match: true });
  });

  it('reads the text from plan.json and the take from the line id (the GN0 form)', async () => {
    const edit = editDir([{ id: 'L2', text: 'BUT it gets worse.', direction: null }]);
    mkdirSync(generateFile(edit, 'voice'), { recursive: true });
    for (const take of [1, 2]) {
      writeFileSync(generateFile(edit, 'voice', `L2-take${take}.mp3`), stub.audio);
    }
    stub.replies.push({
      json: scribe([
        ['BUT', 0, 0.3],
        ['it', 0.4, 0.5],
        ['gets', 0.6, 0.8],
        ['worse', 0.9, 1.2],
      ]),
    });
    const line = ok(await voice(['check', edit, 'L2'], viaStub()), 'check');
    expect(line).toMatchObject({ id: 'L2', take: 2, file: 'voice/L2-take2.mp3', match: true });
    expect(existsSync(generateFile(edit, 'voice', 'L2-take2.words.json'))).toBe(true);
  });

  it('ignores a sound or a filler Scribe heard, and a silent take is all missing', async () => {
    const edit = withTake([
      ['um', 0, 0.1],
      ['Hi', 0.2, 0.4],
    ]);
    expect(ok(await voice(checkArgs(edit, 'Hi'), viaStub()), 'check').match).toBe(true);
    const silent = withTake([]);
    expect(ok(await voice(checkArgs(silent, 'Hi there'), viaStub()), 'check')).toMatchObject({
      match: false,
      missing: ['Hi', 'there'],
      words: [],
    });
  });

  it('refuses a file outside the edit folder, one that is not there, and a Scribe answer with no times', async () => {
    const edit = withTake([['Hi', 0, 0.2]]);
    const outside = join(makeTempDir('studio-voice-out-'), 'L1-take1.mp3');
    writeFileSync(outside, stub.audio);
    for (const file of [outside, '../../../etc/hosts', 'voice/L9-take1.mp3']) {
      const ran = await voice(['check', edit, '--file', file, '--text', 'Hi'], viaStub());
      expect(failed(ran).code, file).toBe('bad_request');
    }
    expect(stub.seen).toHaveLength(0);
    stub.replies = [{ json: { language_code: 'eng', text: 'Hi' } }];
    expect(failed(await voice(checkArgs(edit, 'Hi'), viaStub())).code).toBe('bad_request');
    expect(existsSync(generateFile(edit, 'voice', 'L2-take1.words.json'))).toBe(false);
  });
});

// --- assemble -------------------------------------------------------------------------------------

describe.skipIf(!haveTools)('assemble', () => {
  /** Takes of L1 (1.0 s, then 1.4 s) and L2 (0.5 s) with their checked words, as `check` leaves them. */
  function withTakes(): string {
    const edit = editDir();
    const takes: [string, number, [string, number, number][]][] = [
      ['L1-take1', 1, [['Old', 100, 300]]],
      [
        'L1-take2',
        1.4,
        [
          ['Do', 100, 300],
          ['you', 350, 500],
          ['know?', 550, 1300],
        ],
      ],
      ['L2-take1', 0.5, [['But', 50, 250]]],
    ];
    for (const [name, sec, words] of takes) {
      writeTone(generateFile(edit, 'voice', `${name}.mp3`), sec);
      writeFileSync(
        generateFile(edit, 'voice', `${name}.words.json`),
        JSON.stringify({
          match: !name.startsWith('L2'),
          words: words.map(([text, startMs, endMs]) => ({ text, startMs, endMs })),
        }),
      );
    }
    return edit;
  }

  it('joins the picked takes in order with the pauses, at -16 LUFS, and times every word', async () => {
    const edit = withTakes();
    const ran = await voice(
      ['assemble', edit, '--order', 'L2:1,L1:2', '--pauses', 'L2>L1:500'],
      viaStub(),
    );
    const line = ok(ran, 'assemble');
    expect(line).toMatchObject({ file: 'voice.mp3', wordsFile: 'voice-words.json' });

    // The lines: L2 first from 0, then 500 ms of silence, then L1's second take.
    const [first, second] = line.lines;
    expect(first).toMatchObject({ id: 'L2', take: 1, startMs: 0, match: false });
    expect(second).toMatchObject({ id: 'L1', take: 2, match: true });
    expect(first?.endMs).toBeGreaterThan(450);
    expect(first?.endMs).toBeLessThan(560);
    expect(second?.startMs).toBe((first?.endMs ?? 0) + 500);
    expect(second?.endMs).toBeGreaterThan((second?.startMs ?? 0) + 1350);
    expect(second?.endMs).toBeLessThan((second?.startMs ?? 0) + 1460);
    expect(line.ms).toBe(second?.endMs);
    expect(line.durationSec).toBeCloseTo((line.ms ?? 0) / 1000, 3);
    expect(first?.startSec).toBe(0);
    expect(second?.startSec).toBeCloseTo((second?.startMs ?? 0) / 1000, 3);

    // The master: as long as it says, and at the target loudness.
    const master = generateFile(edit, 'voice.mp3');
    expect(Math.abs(lengthMs(master) - (line.ms ?? 0))).toBeLessThan(70);
    const level = loudness(master);
    expect(Math.abs(level.integrated - MASTER.integratedLufs)).toBeLessThan(1);
    expect(level.truePeak).toBeLessThan(MASTER.truePeakDbtp + 0.3);
    expect(line.lufs).toBeCloseTo(MASTER.integratedLufs, 0);

    // The words: each take's own words, moved by the line's start; the shared schema reads them.
    const kept = JSON.parse(readFileSync(generateFile(edit, 'voice-words.json'), 'utf8'));
    expect(generateVoiceWordsSchema.parse(kept).words).toHaveLength(4);
    const start = second?.startMs ?? 0;
    expect(
      kept.words.map((w: { line: string; text: string; startMs: number; endMs: number }) => [
        w.line,
        w.text,
        w.startMs,
        w.endMs,
      ]),
    ).toEqual([
      ['L2', 'But', 50, 250],
      ['L1', 'Do', start + 100, start + 300],
      ['L1', 'you', start + 350, start + 500],
      ['L1', 'know?', start + 550, start + 1300],
    ]);
    expect(kept.words[1]).toMatchObject({
      startSec: (start + 100) / 1000,
      endSec: (start + 300) / 1000,
    });
    expect(kept.ms).toBe(line.ms);
    // It needed no key and no network.
    expect(stub.seen).toHaveLength(0);
  });

  it('uses --pause for the gaps that have none, and takes the GN0 --pick form', async () => {
    const edit = withTakes();
    const line = ok(
      await voice(['assemble', edit, '--pick', 'L1=1,L2=1', '--pause', '100']),
      'assemble',
    );
    const [first, second] = line.lines;
    expect(first).toMatchObject({ id: 'L1', take: 1, startMs: 0 });
    expect(second?.startMs).toBe((first?.endMs ?? 0) + 100);
    const dflt = ok(await voice(['assemble', edit, '--order', 'L1:1,L2:1']), 'assemble');
    expect(dflt.lines[1]?.startMs).toBe((dflt.lines[0]?.endMs ?? 0) + MASTER.defaultPauseMs);
    // One line alone is its take, normalised.
    const alone = ok(await voice(['assemble', edit, '--order', 'L2:1']), 'assemble');
    expect(alone.lines).toHaveLength(1);
    expect(alone.lines[0]?.startMs).toBe(0);
  });

  it('without --lead (or with --lead 0) says and writes no lead at all', async () => {
    const edit = withTakes();
    const args = ['assemble', edit, '--order', 'L2:1,L1:2', '--pauses', 'L2>L1:500'];
    const plain = await voice(args);
    const plainFiles = [
      readFileSync(generateFile(edit, 'voice.mp3')),
      readFileSync(generateFile(edit, 'voice-words.json'), 'utf8'),
    ];
    expect(plain.line).not.toHaveProperty('leadMs');
    expect(plainFiles[1]).not.toContain('leadMs');
    expect(Object.keys(JSON.parse(plainFiles[1] as string))).toEqual(['ms', 'lines', 'words']);
    // Run again, and with --lead 0: the answer, the master and the word times are the same bytes.
    for (const again of [args, [...args, '--lead', '0']]) {
      const ran = await voice(again);
      expect(ran.stdout).toBe(plain.stdout);
      expect(readFileSync(generateFile(edit, 'voice.mp3')).equals(plainFiles[0] as Buffer)).toBe(
        true,
      );
      expect(readFileSync(generateFile(edit, 'voice-words.json'), 'utf8')).toBe(plainFiles[1]);
    }
  });

  it('with --lead starts the voice with that much silence and moves every line and word by it', async () => {
    const edit = withTakes();
    const args = ['assemble', edit, '--order', 'L2:1,L1:2', '--pauses', 'L2>L1:500'];
    const plain = ok(await voice(args), 'assemble');
    const plainWords = JSON.parse(readFileSync(generateFile(edit, 'voice-words.json'), 'utf8'));
    const plainMasterMs = lengthMs(generateFile(edit, 'voice.mp3'));

    const led = ok(await voice([...args, '--lead', '2800']), 'assemble');
    const ledWords = JSON.parse(readFileSync(generateFile(edit, 'voice-words.json'), 'utf8'));

    // The answer: the lead is said, the length grows by it, every line starts later by it.
    expect(led.leadMs).toBe(2800);
    expect(led.ms).toBe((plain.ms ?? 0) + 2800);
    expect(led.durationSec).toBeCloseTo(plain.durationSec + 2.8, 3);
    expect(led.lufs).toBe(plain.lufs);
    expect(led.lines).toHaveLength(2);
    for (const [at, line] of led.lines.entries()) {
      const before = plain.lines[at];
      expect(line).toMatchObject({ id: before?.id, take: before?.take, match: before?.match });
      expect(line.startMs).toBe((before?.startMs ?? 0) + 2800);
      expect(line.endMs).toBe((before?.endMs ?? 0) + 2800);
      expect(line.startSec).toBeCloseTo((before?.startSec ?? 0) + 2.8, 3);
      expect(line.endSec).toBeCloseTo((before?.endSec ?? 0) + 2.8, 3);
    }
    expect(led.lines[0]?.startMs).toBe(2800);

    // voice-words.json: the lead is recorded, the total and every word moved, the schema reads it.
    expect(generateVoiceWordsSchema.parse(ledWords).leadMs).toBe(2800);
    expect(generateVoiceWordsSchema.parse(plainWords).leadMs).toBeUndefined();
    expect(ledWords.leadMs).toBe(2800);
    expect(ledWords.ms).toBe(led.ms);
    expect(ledWords.words).toHaveLength(plainWords.words.length);
    type Word = { line: string; text: string; startMs: number; endMs: number };
    for (const [at, word] of (ledWords.words as Word[]).entries()) {
      const before = plainWords.words[at] as Word;
      expect(word).toMatchObject({ line: before.line, text: before.text });
      expect(word.startMs).toBe(before.startMs + 2800);
      expect(word.endMs).toBe(before.endMs + 2800);
    }
    expect(ledWords.words[0]).toMatchObject({ startMs: 2850, startSec: 2.85 });
    expect(ledWords.lines).toEqual(led.lines);

    // The master: 2.8 s longer, silent for the lead, and the first word where the words say it is.
    const master = generateFile(edit, 'voice.mp3');
    expect(Math.abs(lengthMs(master) - (plainMasterMs + 2800))).toBeLessThan(70);
    expect(peakDb(master, 0, 2.7)).toBeLessThan(-60);
    expect(peakDb(master, 2.95, 0.15)).toBeGreaterThan(-30);
    const level = loudness(master);
    expect(Math.abs(level.integrated - MASTER.integratedLufs)).toBeLessThan(1.5);
    expect(stub.seen).toHaveLength(0);
  });

  it('takes --lead up to 6000 ms and refuses more, or anything that is not whole milliseconds', async () => {
    const edit = withTakes();
    const args = ['assemble', edit, '--order', 'L2:1'];
    const longest = ok(await voice([...args, '--lead', '6000']), 'assemble');
    expect(longest.leadMs).toBe(6000);
    expect(longest.lines[0]?.startMs).toBe(6000);
    expect(longest.ms).toBeGreaterThan(6450);

    const kept = readFileSync(generateFile(edit, 'voice-words.json'), 'utf8');
    for (const lead of ['6001', '1.5', '-1', 'abc', '']) {
      const refused = failed(await voice([...args, '--lead', lead]));
      expect(refused.code, lead).toBe('bad_request');
      expect(refused.detail, lead).toMatch(/--lead/);
    }
    expect(failed(await voice([...args, '--lead', '9000'])).detail).toMatch(/too long.*6000 ms/);
    // A refusal changes nothing that was there.
    expect(readFileSync(generateFile(edit, 'voice-words.json'), 'utf8')).toBe(kept);
    expect(readdirSync(generateFile(edit)).filter((name) => name.startsWith('.'))).toEqual([]);
    // A fresh folder gets no master from a refused lead.
    const fresh = withTakes();
    failed(await voice(['assemble', fresh, '--order', 'L2:1', '--lead', '7000']));
    expect(existsSync(generateFile(fresh, 'voice.mp3'))).toBe(false);
    expect(existsSync(generateFile(fresh, 'voice-words.json'))).toBe(false);
  });

  it('refuses a take that was never checked, one that is not there, and a pause between lines that do not follow', async () => {
    const edit = withTakes();
    writeTone(generateFile(edit, 'voice', 'L3-take1.mp3'), 0.5);
    for (const args of [
      ['--order', 'L3:1'],
      ['--order', 'L1:7'],
      ['--order', 'L1:1,L2:1', '--pauses', 'L2>L1:100'],
      ['--order', 'L1:1,L2:1', '--pauses', 'L1>L3:100'],
      ['--order', ''],
      ['--pause', '100'],
    ]) {
      const ran = await voice(['assemble', edit, ...args]);
      expect(failed(ran).code, args.join(' ')).toBe('bad_request');
    }
    expect(existsSync(generateFile(edit, 'voice.mp3'))).toBe(false);
    expect(existsSync(generateFile(edit, 'voice-words.json'))).toBe(false);
    expect(readdirSync(generateFile(edit)).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('refuses takes that are silent', async () => {
    const edit = editDir();
    const silent = join(edit, 'generate', 'voice', 'L1-take1.mp3');
    mkdirSync(join(edit, 'generate', 'voice'), { recursive: true });
    const made = spawnSync(ffmpeg as string, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=mono:sample_rate=44100',
      '-t',
      '1',
      silent,
    ]);
    expect(made.status).toBe(0);
    writeFileSync(
      generateFile(edit, 'voice', 'L1-take1.words.json'),
      JSON.stringify({ match: true, words: [] }),
    );
    expect(failed(await voice(['assemble', edit, '--order', 'L1:1'])).code).toBe('bad_request');
  });

  it('works from takes that were just made and checked (line, check, assemble)', async () => {
    const edit = editDir([
      { id: 'L1', text: 'Do you know?', direction: null },
      { id: 'L2', text: 'But why?', direction: 'weighty' },
    ]);
    const tone = join(makeTempDir('studio-voice-tone-'), 'tone.mp3');
    writeTone(tone, 1.2);
    stub.audio = readFileSync(tone);
    for (const [id, words] of [
      [
        'L1',
        [
          ['Do', 0.1, 0.3],
          ['you', 0.35, 0.5],
          ['know?', 0.55, 1.1],
        ],
      ],
      [
        'L2',
        [
          ['But', 0.1, 0.4],
          ['why?', 0.5, 1.1],
        ],
      ],
    ] as const) {
      ok(await voice(['line', edit, id], viaStub()), 'line');
      stub.replies.push({ json: scribe(words.map(([t, s, e]) => [t, s, e])) });
      expect(ok(await voice(['check', edit, id], viaStub()), 'check').match).toBe(true);
    }
    const line = ok(await voice(['assemble', edit, '--order', 'L1:1,L2:1']), 'assemble');
    expect(line.lines.map((l) => l.id)).toEqual(['L1', 'L2']);
    const kept = JSON.parse(readFileSync(generateFile(edit, 'voice-words.json'), 'utf8'));
    expect(kept.words.map((w: { text: string }) => w.text)).toEqual([
      'Do',
      'you',
      'know?',
      'But',
      'why?',
    ]);
  });
});

// --- sfx ------------------------------------------------------------------------------------------

describe('sfx', () => {
  it('writes the sound effect and asks ElevenLabs for the seconds given', async () => {
    const edit = editDir();
    stub.replies.push({ headers: { 'character-cost': '24' } });
    const line = ok(
      await voice(
        [
          'sfx',
          edit,
          '--id',
          'alert',
          '--prompt',
          'two short news alert pulses',
          '--seconds',
          '1.2',
        ],
        viaStub(),
      ),
      'sfx',
    );
    expect(line).toMatchObject({
      id: 'alert',
      name: 'alert',
      file: 'sfx/alert.mp3',
      characters: 24,
    });
    expect(line.ms).toBeGreaterThan(0);
    expect(readFileSync(generateFile(edit, 'sfx', 'alert.mp3'))).toEqual(stub.audio);
    const seen = request('/v1/sound-generation');
    expect(seen.url).toBe('/v1/sound-generation?output_format=mp3_44100_128');
    expect(seen.headers['xi-api-key']).toBe(KEY);
    expect(seen.body).toEqual({ text: 'two short news alert pulses', duration_seconds: 1.2 });
  });

  it('leaves the length to ElevenLabs when none is given, and takes the GN0 form', async () => {
    const edit = editDir();
    const line = ok(
      await voice(['sfx', edit, 'whoosh', '--prompt', 'a soft whoosh'], viaStub()),
      'sfx',
    );
    expect(line).toMatchObject({ name: 'whoosh', file: 'sfx/whoosh.mp3', characters: null });
    expect(request('/v1/sound-generation').body).toEqual({ text: 'a soft whoosh' });
  });

  it.each([
    ['no name', ['sfx', '<edit>', '--prompt', 'x']],
    ['a name that is a path', ['sfx', '<edit>', '--id', '../x', '--prompt', 'x']],
    ['no prompt', ['sfx', '<edit>', '--id', 'alert']],
    ['too long a prompt', ['sfx', '<edit>', '--id', 'alert', '--prompt', 'x'.repeat(451)]],
    ['too short a length', ['sfx', '<edit>', '--id', 'alert', '--prompt', 'x', '--seconds', '0.1']],
    ['too long a length', ['sfx', '<edit>', '--id', 'alert', '--prompt', 'x', '--seconds', '31']],
  ])('refuses %s as a bad request, without calling ElevenLabs', async (_label, template) => {
    const edit = editDir();
    const ran = await voice(
      template.map((arg) => (arg === '<edit>' ? edit : arg)),
      viaStub(),
    );
    expect(failed(ran).code).toBe('bad_request');
    expect(stub.seen).toHaveLength(0);
  });
});

// --- failures -------------------------------------------------------------------------------------

describe('when ElevenLabs says no', () => {
  const lineArgs = (edit: string) => ['line', edit, '--id', 'L1', '--text', 'Hello there.'];

  it.each([
    [
      '401 invalid key',
      { status: 401, json: { detail: { status: 'invalid_api_key' } } },
      'key_rejected',
    ],
    [
      '401 out of credits',
      { status: 401, json: { detail: { status: 'quota_exceeded', message: 'quota' } } },
      'balance_empty',
    ],
    ['402', { status: 402, json: { detail: 'pay' } }, 'balance_empty'],
    [
      '400',
      { status: 400, json: { detail: { status: 'bad', message: 'bad text' } } },
      'bad_request',
    ],
  ] as const)(
    'maps %s to its code, its plain words and its exit code',
    async (_label, reply, code) => {
      const edit = editDir();
      stub.replies.push({ ...reply });
      const ran = await voice(lineArgs(edit), viaStub());
      expect(failed(ran)).toMatchObject({
        code,
        message: generateErrorMessage(code, { service: 'elevenlabs' }),
      });
      expect(ran.status).toBe(generateExitCode(code));
      expect(stub.seen).toHaveLength(1);
      expect(existsSync(generateFile(edit, 'voice'))).toBe(false);
    },
  );

  it('says which permission the key is missing, in the plain words of key_rejected', async () => {
    const edit = editDir();
    stub.replies.push({
      status: 401,
      json: {
        detail: {
          type: 'authentication_error',
          status: 'missing_permissions',
          message:
            'The API key you used is missing the permission text_to_speech to execute this operation.',
        },
      },
    });
    const ran = await voice(lineArgs(edit), viaStub());
    const line = failed(ran);
    expect(line.code).toBe('key_rejected');
    expect(line.message).toContain('"text_to_speech"');
    expect(ran.status).toBe(2);
  });

  it('tries a 429 once more, then calls ElevenLabs busy (exit 3)', async () => {
    const edit = editDir();
    stub.replies.push(
      { status: 429, json: { detail: 'busy' } },
      { status: 429, json: { detail: 'busy' } },
    );
    const ran = await voice(lineArgs(edit), viaStub());
    expect(failed(ran)).toMatchObject({ code: 'unavailable', message: MESSAGES.unavailable });
    expect(ran.status).toBe(3);
    expect(stub.seen).toHaveLength(2);
  });

  it('tries a 5xx once more, and carries on when the second try works', async () => {
    const edit = editDir();
    stub.replies.push({ status: 503, json: { detail: 'down' } });
    expect(ok(await voice(lineArgs(edit), viaStub()), 'line')).toMatchObject({ take: 1 });
    expect(stub.seen).toHaveLength(2);

    const again = editDir();
    stub.seen = [];
    stub.replies.push({ status: 500, json: {} }, { status: 502, json: {} });
    const ran = await voice(lineArgs(again), viaStub());
    expect(failed(ran).code).toBe('unavailable');
    expect(ran.status).toBe(3);
    expect(stub.seen).toHaveLength(2);
    expect(existsSync(generateFile(again, 'voice'))).toBe(false);
  });

  it('calls ElevenLabs down when nothing answers, and when it takes too long (no second try)', async () => {
    const edit = editDir();
    const dead = await voice(lineArgs(edit), { VOICE_API_BASE: 'http://127.0.0.1:9' });
    expect(failed(dead)).toMatchObject({ code: 'unavailable' });
    expect(dead.status).toBe(3);

    stub.replies.push({ hang: true });
    const slow = await voice(lineArgs(edit), { ...viaStub(), VOICE_TIMEOUT_MS: '300' });
    expect(failed(slow).code).toBe('unavailable');
    expect(slow.status).toBe(3);
    expect(stub.seen).toHaveLength(1);
  });

  it.each([
    ['line', (edit: string) => ['line', edit, '--id', 'L1', '--text', 'Hi there.']],
    ['sfx', (edit: string) => ['sfx', edit, '--id', 'a', '--prompt', 'x']],
  ])(
    '%s needs the key: with none it is key_rejected (exit 2) and calls nothing',
    async (_label, argv) => {
      const edit = editDir();
      const ran = await voice(argv(edit), { ...viaStub(), HOME: homeWith(null) });
      expect(failed(ran)).toMatchObject({ code: 'key_rejected', message: MESSAGES.key_rejected });
      expect(ran.status).toBe(2);
      expect(stub.seen).toHaveLength(0);
    },
  );

  it('takes the key out of whatever ElevenLabs echoes back, in the detail', async () => {
    const edit = editDir();
    stub.replies.push({
      status: 400,
      json: { detail: { status: 'bad', message: `bad request for xi-api-key: ${KEY} and ${KEY}` } },
    });
    const ran = await voice(lineArgs(edit), viaStub());
    const line = failed(ran);
    expect(JSON.stringify(line)).not.toContain(KEY);
    expect(line.detail).toContain('[key]');
  });

  it('prints no key on success either, and nothing but one line', async () => {
    const edit = editDir();
    const ran = await voice(lineArgs(edit), viaStub());
    expect(ran.stdout.trim().split('\n')).toHaveLength(1);
    expect(ran.stdout).not.toMatch(/sk_|xi-api-key|ELEVENLABS/i);
  });
});

// --- boundaries ------------------------------------------------------------------------------------

describe('what it will not do', () => {
  it('refuses an edit folder that is relative or missing', async () => {
    for (const edit of ['edit', join(makeTempDir('studio-voice-'), 'nope')]) {
      const ran = await voice(['sfx', edit, '--id', 'a', '--prompt', 'x'], viaStub());
      expect(failed(ran).code).toBe('bad_request');
    }
    expect(stub.seen).toHaveLength(0);
  });

  it('writes nothing outside the edit folder when generate/ is a link to somewhere else', async () => {
    const outside = makeTempDir('studio-voice-out-');
    const edit = join(makeTempDir('studio-voice-'), 'edit');
    mkdirSync(edit, { recursive: true });
    symlinkSync(outside, join(edit, 'generate'));
    const ran = await voice(['sfx', edit, '--id', 'alert', '--prompt', 'x'], viaStub());
    expect(failed(ran).code).toBe('bad_request');
    expect(readdirSync(outside)).toEqual([]);
    expect(stub.seen).toHaveLength(0);
  });

  it('writes nothing outside generate/ when voice/ or sfx/ is a link to somewhere else', async () => {
    const outside = makeTempDir('studio-voice-out-');
    const edit = editDir();
    symlinkSync(outside, generateFile(edit, 'sfx'));
    const ran = await voice(['sfx', edit, '--id', 'alert', '--prompt', 'x'], viaStub());
    expect(failed(ran).code).toBe('bad_request');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('sends the key only to ElevenLabs or to a local address', async () => {
    const edit = editDir();
    const ran = await voice(['sfx', edit, '--id', 'a', '--prompt', 'x'], {
      VOICE_API_BASE: 'https://example.com',
    });
    expect(failed(ran).code).toBe('bad_request');
    expect(stub.seen).toHaveLength(0);
  });

  it('has a loudness gain that never pushes the peak over the ceiling', () => {
    expect(loudnessGain(-22, -8)).toBe(6);
    expect(loudnessGain(-22, -3)).toBe(1.5);
    expect(loudnessGain(-10, -1)).toBe(-6);
  });
});

// --- the fake ---------------------------------------------------------------------------------------

describe('STUDIO_GENERATE_FAKE=1 (GN0’s stub, kept for tests of the Generate run)', () => {
  const fake = { STUDIO_GENERATE_FAKE: '1', HOME: homeWith(null) };

  it('runs the whole flow in the real command lines with no key and no network', async () => {
    const edit = editDir();
    const made = ok(
      await voice(['line', edit, '--id', 'L1', '--text', 'Do you know?', '--direction', 'x'], fake),
      'line',
    );
    expect(made).toMatchObject({ id: 'L1', take: 1, file: 'voice/L1-take1.mp3', chars: 12 });
    const checked = ok(
      await voice(['check', edit, '--file', 'voice/L1-take1.mp3', '--text', 'Do you know?'], fake),
      'check',
    );
    expect(checked).toMatchObject({ id: 'L1', take: 1, match: true, missing: [], extra: [] });
    expect(checked.words.map((w) => w.text)).toEqual(['Do', 'you', 'know?']);
    const joined = ok(
      await voice(['assemble', edit, '--order', 'L1:1', '--pauses', ''], fake),
      'assemble',
    );
    expect(joined.lines).toHaveLength(1);
    const words = generateVoiceWordsSchema.parse(
      JSON.parse(readFileSync(generateFile(edit, 'voice-words.json'), 'utf8')),
    );
    expect(words.words.map((w) => w.text)).toEqual(['Do', 'you', 'know?']);
    expect(
      ok(await voice(['sfx', edit, '--id', 'alert', '--prompt', 'x'], fake), 'sfx'),
    ).toMatchObject({
      name: 'alert',
      file: 'sfx/alert.mp3',
    });
    expect(statSync(generateFile(edit, 'voice.mp3')).size).toBeGreaterThan(0);
    expect(stub.seen).toHaveLength(0);
  });

  it('fails on request with the contract’s words', async () => {
    const edit = editDir();
    const ran = await voice(['line', edit, '--id', 'L1', '--text', 'Hi'], {
      ...fake,
      STUDIO_GENERATE_STUB_FAIL: 'balance_empty',
    });
    expect(failed(ran)).toMatchObject({
      code: 'balance_empty',
      message: generateErrorMessage('balance_empty', { service: 'elevenlabs' }),
    });
    expect(ran.status).toBe(2);
  });
});
