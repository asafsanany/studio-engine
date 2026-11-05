import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GENERATE_ERROR_CODES,
  type GenerateErrorCode,
  generateErrorMessage,
  generateExitCode,
  generateSpendSchema,
  generateVoiceWordsSchema,
  makeShotsLineSchema,
  makeVoiceLineSchema,
  parseGenerateScriptLine,
  spendTotal,
} from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeTempDir } from '../test-temp.js';

// Generated videos, GN0: the two scripts in assets/generate/ are stubs that obey the JSON-line
// contract of packages/shared/src/domain/generate.ts and write tiny placeholder files. GN2 and GN3
// replace them with the real ones (GN2 and GN3 kept the stubs as make-voice-fake.mjs and make-shots-fake.mjs,
// which the real scripts run when STUDIO_GENERATE_FAKE=1; the real ones are tested in make-voice.test.ts and
// make-shots.test.ts); GN5 and GN10 build
// on these, so nothing needs a service or a key.
// Every call here is a real process, as the Generate run (and the engine's tests) will start them.

const ASSETS = fileURLToPath(new URL('../../assets/generate/', import.meta.url));
const VOICE = join(ASSETS, 'make-voice.mjs');
const SHOTS = join(ASSETS, 'make-shots.mjs');

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
  line: unknown;
}

/** Runs a script with no keys and no network in its environment, as the engine's scripts get it. */
function run(script: string, args: string[], env: Record<string, string> = {}): Ran {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    // GN2 and GN3 made the scripts real; STUDIO_GENERATE_FAKE=1 makes them GN0's stubs again
    // (make-voice-fake.mjs, make-shots-fake.mjs).
    env: {
      PATH: process.env.PATH ?? '',
      ...(script === VOICE || script === SHOTS ? { STUDIO_GENERATE_FAKE: '1' } : {}),
      ...env,
    },
  });
  const lines = result.stdout.trim().split('\n');
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    line: JSON.parse(lines[lines.length - 1] ?? 'null'),
  };
}

/** A fresh edit folder with the plan the voice stub reads its lines from. */
function editDir(): string {
  const edit = join(makeTempDir('studio-generate-stub-'), 'edit');
  mkdirSync(join(edit, 'generate'), { recursive: true });
  writeFileSync(
    join(edit, 'generate', 'plan.json'),
    JSON.stringify({
      voice: [
        { id: 'L1', text: 'Do you know what is in your windows?', direction: null },
        { id: 'L2', text: 'BUT it gets worse.', direction: 'a clear stop after BUT' },
      ],
      cast: [],
      clips: [],
    }),
  );
  return edit;
}

const generateFile = (edit: string, ...parts: string[]): string => join(edit, 'generate', ...parts);

describe('the placeholder files', () => {
  it('are a tiny black MP4 and a tiny silent MP3, checked in', () => {
    const mp4 = join(ASSETS, 'testdata', 'black-1s.mp4');
    const mp3 = join(ASSETS, 'testdata', 'silence-1s.mp3');
    expect(statSync(mp4).size).toBeLessThan(10_000);
    expect(statSync(mp3).size).toBeLessThan(10_000);
    // An MP4 has "ftyp" at byte 4; an MP3 starts with an ID3 tag or a frame sync (0xFF 0xFx).
    expect(readFileSync(mp4).subarray(4, 8).toString('latin1')).toBe('ftyp');
    const head = readFileSync(mp3);
    expect(head.subarray(0, 3).toString('latin1') === 'ID3' || head[0] === 0xff).toBe(true);
  });
});

describe('make-voice.mjs with STUDIO_GENERATE_FAKE=1 (GN0’s stub)', () => {
  it('line makes a take of a line of plan.json, and the next call the next take', () => {
    const edit = editDir();

    const first = run(VOICE, ['line', edit, 'L1']);
    const second = run(VOICE, ['line', edit, 'L1']);

    expect(first.status).toBe(0);
    expect(first.line).toEqual({
      ok: true,
      command: 'line',
      id: 'L1',
      take: 1,
      file: 'voice/L1-take1.mp3',
      ms: 1000,
      durationSec: 1,
      characters: 'Do you know what is in your windows?'.length,
      chars: 'Do you know what is in your windows?'.length,
    });
    expect(makeVoiceLineSchema.safeParse(first.line).success).toBe(true);
    expect(second.line).toMatchObject({ take: 2, file: 'voice/L1-take2.mp3' });
    expect(existsSync(generateFile(edit, 'voice', 'L1-take1.mp3'))).toBe(true);
    expect(existsSync(generateFile(edit, 'voice', 'L1-take2.mp3'))).toBe(true);
    // Another line starts its own takes.
    expect(run(VOICE, ['line', edit, 'L2']).line).toMatchObject({ take: 1 });
    expect(run(VOICE, ['line', edit, 'L2', '--take', '5']).line).toMatchObject({ take: 5 });
  });

  it('assemble joins the picked takes into voice.mp3 and writes the word times', () => {
    const edit = editDir();
    run(VOICE, ['line', edit, 'L1']);
    run(VOICE, ['line', edit, 'L2']);

    const out = run(VOICE, ['assemble', edit, '--pick', 'L1=1,L2=1']);

    expect(out.status).toBe(0);
    expect(makeVoiceLineSchema.parse(out.line)).toEqual({
      ok: true,
      command: 'assemble',
      file: 'voice.mp3',
      wordsFile: 'voice-words.json',
      durationSec: 2,
      lines: [
        { id: 'L1', take: 1, startSec: 0, endSec: 1 },
        { id: 'L2', take: 1, startSec: 1, endSec: 2 },
      ],
    });
    expect(existsSync(generateFile(edit, 'voice.mp3'))).toBe(true);
    const words = generateVoiceWordsSchema.parse(
      JSON.parse(readFileSync(generateFile(edit, 'voice-words.json'), 'utf8')),
    );
    expect(words.words.map((word) => word.text)).toEqual([
      'Do',
      'you',
      'know',
      'what',
      'is',
      'in',
      'your',
      'windows?',
      'BUT',
      'it',
      'gets',
      'worse.',
    ]);
    expect(words.words[0]).toMatchObject({ line: 'L1', startSec: 0 });
    expect(words.words.at(-1)).toMatchObject({ line: 'L2', endSec: 2 });
  });

  it('assemble --lead puts the opening before the first line: lines and words move by it', () => {
    const edit = editDir();
    run(VOICE, ['line', edit, 'L1']);
    run(VOICE, ['line', edit, 'L2']);

    const out = run(VOICE, ['assemble', edit, '--pick', 'L1=1,L2=1', '--lead', '2800']);

    expect(out.status).toBe(0);
    expect(makeVoiceLineSchema.parse(out.line)).toEqual({
      ok: true,
      command: 'assemble',
      file: 'voice.mp3',
      wordsFile: 'voice-words.json',
      leadMs: 2800,
      durationSec: 4.8,
      lines: [
        { id: 'L1', take: 1, startSec: 2.8, endSec: 3.8 },
        { id: 'L2', take: 1, startSec: 3.8, endSec: 4.8 },
      ],
    });
    const kept = JSON.parse(readFileSync(generateFile(edit, 'voice-words.json'), 'utf8'));
    expect(kept.leadMs).toBe(2800);
    const words = generateVoiceWordsSchema.parse(kept);
    expect(words.leadMs).toBe(2800);
    expect(words.words[0]).toMatchObject({ line: 'L1', text: 'Do', startSec: 2.8 });
    expect(words.words.at(-1)).toMatchObject({ line: 'L2', endSec: 4.8 });
    // A placeholder second for each started second of the opening, then one for each line.
    expect(statSync(generateFile(edit, 'voice.mp3')).size).toBe(
      (3 + 2) * statSync(join(ASSETS, 'testdata', 'silence-1s.mp3')).size,
    );
  });

  it.each([
    ['more than 6000 ms', '6001', /--lead 6001 is too long.*6000 ms/],
    ['a fraction', '1.5', /whole number/],
    ['a negative number', '-1', /whole number/],
    ['words', 'soon', /whole number/],
  ])(
    'assemble --lead refuses %s as bad_request (exit 1) and makes nothing',
    (_label, lead, why) => {
      const edit = editDir();
      run(VOICE, ['line', edit, 'L1']);
      const out = run(VOICE, ['assemble', edit, '--pick', 'L1=1', '--lead', lead]);
      expect(out.status).toBe(1);
      expect(makeVoiceLineSchema.parse(out.line)).toMatchObject({ ok: false, code: 'bad_request' });
      expect((out.line as { message: string }).message).toMatch(why);
      expect(existsSync(generateFile(edit, 'voice.mp3'))).toBe(false);
      expect(existsSync(generateFile(edit, 'voice-words.json'))).toBe(false);
    },
  );

  it('sfx makes a sound effect from a description', () => {
    const edit = editDir();
    const out = run(VOICE, ['sfx', edit, 'alert', '--prompt', 'two news alert pulses']);
    expect(out.status).toBe(0);
    expect(makeVoiceLineSchema.parse(out.line)).toEqual({
      ok: true,
      command: 'sfx',
      id: 'alert',
      name: 'alert',
      file: 'sfx/alert.mp3',
      ms: 1000,
      durationSec: 1,
      characters: null,
    });
    expect(existsSync(generateFile(edit, 'sfx', 'alert.mp3'))).toBe(true);
  });

  it.each([
    ['an unknown command', ['dance', '<edit>']],
    ['no edit folder', ['line']],
    ['a line the plan does not have', ['line', '<edit>', 'L9']],
    ['an assemble with no picks', ['assemble', '<edit>']],
    ['an assemble of a take that does not exist', ['assemble', '<edit>', '--pick', 'L1=3']],
    ['an sfx with no prompt', ['sfx', '<edit>', 'alert']],
    ['an sfx with a name that is a path', ['sfx', '<edit>', '../x', '--prompt', 'x']],
  ])('refuses %s as bad_request (exit 1)', (_label, template) => {
    const edit = editDir();
    const out = run(
      VOICE,
      template.map((arg) => (arg === '<edit>' ? edit : arg)),
    );
    expect(out.status).toBe(1);
    const line = makeVoiceLineSchema.parse(out.line);
    expect(line).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it.each(GENERATE_ERROR_CODES)('fails on request with %s: its words and exit code', (code) => {
    const edit = editDir();
    const out = run(VOICE, ['line', edit, 'L1'], { STUDIO_GENERATE_STUB_FAIL: code });
    expect(out.status).toBe(generateExitCode(code as GenerateErrorCode));
    expect(makeVoiceLineSchema.parse(out.line)).toMatchObject({
      ok: false,
      code,
      message: generateErrorMessage(code as GenerateErrorCode, {
        service: 'elevenlabs',
        needUsd: 4.1,
        budgetUsd: 3,
      }),
    });
    expect(existsSync(generateFile(edit, 'voice'))).toBe(false);
  });

  it('lets the first n calls succeed before it fails (STUDIO_GENERATE_STUB_FAIL_AFTER)', () => {
    const edit = editDir();
    const env = {
      STUDIO_GENERATE_STUB_FAIL: 'balance_empty',
      STUDIO_GENERATE_STUB_FAIL_AFTER: '2',
    };
    expect(run(VOICE, ['line', edit, 'L1'], env).status).toBe(0);
    expect(run(VOICE, ['line', edit, 'L2'], env).status).toBe(0);
    const third = run(VOICE, ['line', edit, 'L1'], env);
    expect(third.status).toBe(2);
    expect(third.line).toMatchObject({ ok: false, code: 'balance_empty' });
  });

  it('needs no key and prints nothing but the one JSON line', () => {
    const edit = editDir();
    const out = run(VOICE, ['line', edit, 'L1'], {});
    expect(out.stdout.trim().split('\n')).toHaveLength(1);
    expect(out.stderr).toBe('');
    expect(out.stdout).not.toMatch(/ELEVENLABS|sk_/);
  });
});

describe('make-shots.mjs with STUDIO_GENERATE_FAKE=1 (GN0’s stub)', () => {
  const MODEL = 'kling-video/v2.5-turbo/standard/image-to-video';

  /** A job with a look and a start keyframe made. */
  function withKeyframe(): string {
    const edit = editDir();
    run(SHOTS, [
      'still',
      edit,
      'A-start',
      '--into',
      'keyframes',
      '--model',
      'soul',
      '--prompt',
      'x',
    ]);
    return edit;
  }

  it('takes the real script’s forms too: upload answers a made-up URL, and --tier is recorded as the model', () => {
    const edit = withKeyframe();

    const up = run(SHOTS, ['upload', edit, '--file', 'keyframes/A-start.png']);
    expect(up.status).toBe(0);
    expect(makeShotsLineSchema.parse(up.line)).toEqual({
      ok: true,
      command: 'upload',
      file: 'keyframes/A-start.png',
      url: 'https://stub.invalid/keyframes%2FA-start.png',
      cached: false,
      contentType: 'image/png',
    });
    expect(run(SHOTS, ['upload', edit]).status).toBe(1);

    const clip = run(SHOTS, [
      'clip',
      edit,
      'B',
      '--tier',
      'people',
      '--start',
      'keyframes/A-start.png',
      '--seconds',
      '4',
      '--prompt',
      'p',
      '--budget',
      '3',
    ]);
    expect(clip.status).toBe(0);
    const spend = generateSpendSchema.parse(
      JSON.parse(readFileSync(generateFile(edit, 'spend.json'), 'utf8')),
    );
    expect(spend.entries.at(-1)?.slug).toBe('alibaba/wan-3.0/image-to-video');
    // The free upload is not recorded and does not fail on STUDIO_GENERATE_STUB_FAIL=balance_empty.
    expect(
      run(SHOTS, ['upload', edit, '--file', 'x.png'], {
        STUDIO_GENERATE_STUB_FAIL: 'balance_empty',
      }).status,
    ).toBe(0);
  });

  it('estimate prices a clip by the second, a still and a reframe, for nothing', () => {
    const edit = editDir();
    const estimate = (...args: string[]) => run(SHOTS, ['estimate', edit, ...args]).line;
    expect(estimate('--kind', 'clip', '--model', MODEL, '--seconds', '5')).toEqual({
      ok: true,
      command: 'estimate',
      usd: 0.18,
    });
    expect(estimate('--kind', 'clip', '--seconds', '10')).toMatchObject({ usd: 0.36 });
    expect(estimate('--kind', 'still')).toMatchObject({ usd: 0.004 });
    expect(estimate('--kind', 'reframe')).toMatchObject({ usd: 0.18 });
    expect(makeShotsLineSchema.safeParse(estimate('--kind', 'clip')).success).toBe(true);
    // Free: nothing is recorded.
    expect(existsSync(generateFile(edit, 'spend.json'))).toBe(false);
  });

  it('still makes a look or a keyframe image and records what it cost', () => {
    const edit = editDir();

    const look = run(SHOTS, [
      'still',
      edit,
      'homeowner',
      '--into',
      'looks',
      '--model',
      'soul',
      '--prompt',
      'a woman',
    ]);
    const key = run(SHOTS, [
      'still',
      edit,
      'A-start',
      '--into',
      'keyframes',
      '--model',
      'soul',
      '--prompt',
      'a skylight',
    ]);

    expect(look.status).toBe(0);
    expect(makeShotsLineSchema.parse(look.line)).toEqual({
      ok: true,
      command: 'still',
      id: 'homeowner',
      file: 'looks/homeowner.png',
      usd: 0.004,
      requestId: 'stub-1',
    });
    expect(key.line).toMatchObject({ file: 'keyframes/A-start.png', requestId: 'stub-2' });
    expect(
      readFileSync(generateFile(edit, 'looks', 'homeowner.png'))
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');

    const spend = generateSpendSchema.parse(
      JSON.parse(readFileSync(generateFile(edit, 'spend.json'), 'utf8')),
    );
    expect(spend.entries.map((entry) => entry.kind)).toEqual(['look', 'keyframe']);
    expect(spend.entries.every((entry) => entry.slug === 'soul' && !entry.refunded)).toBe(true);
    expect(spend.total).toBe(0.008);
    expect(spend.total).toBe(spendTotal(spend.entries));
  });

  it('clip makes a take from a start keyframe, the next call a new take', () => {
    const edit = withKeyframe();
    const args = [
      'clip',
      edit,
      'A',
      '--model',
      MODEL,
      '--start',
      'keyframes/A-start.png',
      '--seconds',
      '5',
      '--prompt',
      'push in',
    ];

    const first = run(SHOTS, args);
    const second = run(SHOTS, [
      ...args,
      '--take',
      '2',
      '--end',
      'keyframes/A-start.png',
      '--ref',
      'x',
    ]);

    expect(first.status).toBe(0);
    expect(makeShotsLineSchema.parse(first.line)).toEqual({
      ok: true,
      command: 'clip',
      id: 'A',
      take: 1,
      file: 'clips/A/take-1.mp4',
      seconds: 5,
      usd: 0.18,
      requestId: 'stub-2',
    });
    expect(second.line).toMatchObject({ take: 2, file: 'clips/A/take-2.mp4' });
    expect(
      readFileSync(generateFile(edit, 'clips', 'A', 'take-2.mp4'))
        .subarray(4, 8)
        .toString('latin1'),
    ).toBe('ftyp');
    const spend = JSON.parse(readFileSync(generateFile(edit, 'spend.json'), 'utf8'));
    expect(spend.total).toBeCloseTo(0.004 + 0.18 + 0.18, 6);
  });

  // C79: a stop at any moment (a test or a dev run that stops the engine) must leave the money right.
  it('books its cost line before it makes the file, and the same command again is one request, not a second charge', () => {
    const edit = withKeyframe();
    const file = generateFile(edit, 'clips', 'A', 'take-1.mp4');
    const spendPath = generateFile(edit, 'spend.json');
    const ledger = () => JSON.parse(readFileSync(spendPath, 'utf8'));
    const args = [
      'clip',
      edit,
      'A',
      '--model',
      MODEL,
      '--start',
      'keyframes/A-start.png',
      '--seconds',
      '5',
      '--prompt',
      'push in',
      '--budget',
      '3',
    ];

    const first = run(SHOTS, args);
    expect(makeShotsLineSchema.parse(first.line)).toMatchObject({ ok: true, requestId: 'stub-2' });
    // The line is keyed and finished with the file's path, as the real script writes it.
    expect(ledger().entries.at(-1)).toMatchObject({
      id: 'A',
      take: 1,
      state: 'completed',
      file: 'clips/A/take-1.mp4',
    });
    expect(ledger().entries.at(-1).key).toMatch(/^studio-[0-9a-f]{48}$/);

    // The same command again is answered from the ledger: nothing is booked.
    const again = run(SHOTS, args);
    expect(makeShotsLineSchema.parse(again.line)).toMatchObject({
      ok: true,
      requestId: 'stub-2',
      usd: 0.18,
      reused: true,
    });
    expect(ledger().entries).toHaveLength(2);

    // A stop after the line was written and before the file was made: the file is made now and the
    // line is not booked twice.
    rmSync(file);
    const stopped = ledger();
    stopped.entries[1].state = 'booked';
    stopped.entries[1].file = undefined;
    writeFileSync(spendPath, JSON.stringify(stopped));
    const resumed = run(SHOTS, args);
    expect(resumed.status).toBe(0);
    expect(resumed.line).toMatchObject({ requestId: 'stub-2', file: 'clips/A/take-1.mp4' });
    expect(resumed.line).not.toHaveProperty('reused');
    expect(ledger().entries).toHaveLength(2);
    expect(ledger().entries[1]).toMatchObject({ state: 'completed', file: 'clips/A/take-1.mp4' });
    expect(existsSync(file)).toBe(true);
    // No temp file is left behind by the atomic writes.
    expect(readdirSync(generateFile(edit, 'clips', 'A'))).toEqual(['take-1.mp4']);
    expect(readdirSync(generateFile(edit)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('reframe makes the square of a take', () => {
    const edit = withKeyframe();
    run(SHOTS, [
      'clip',
      edit,
      'A',
      '--model',
      MODEL,
      '--start',
      'keyframes/A-start.png',
      '--seconds',
      '5',
      '--prompt',
      'x',
    ]);

    const out = run(SHOTS, ['reframe', edit, 'A', '--take', '1', '--aspect', '1:1']);

    expect(out.status).toBe(0);
    expect(makeShotsLineSchema.parse(out.line)).toMatchObject({
      command: 'reframe',
      id: 'A',
      take: 1,
      file: 'clips/A/take-1-1x1.mp4',
      usd: 0.18,
    });
    expect(existsSync(generateFile(edit, 'clips', 'A', 'take-1-1x1.mp4'))).toBe(true);
  });

  it('refuses a request that would take the spend past --budget, with the numbers (exit 2)', () => {
    const edit = withKeyframe();
    const clip = [
      'clip',
      edit,
      'A',
      '--model',
      MODEL,
      '--start',
      'keyframes/A-start.png',
      '--seconds',
      '5',
      '--prompt',
      'x',
    ];

    const refused = run(SHOTS, [...clip, '--budget', '0.1']);

    expect(refused.status).toBe(2);
    expect(makeShotsLineSchema.parse(refused.line)).toEqual({
      ok: false,
      code: 'over_budget',
      message: generateErrorMessage('over_budget', { needUsd: 0.18 + 0.004, budgetUsd: 0.1 }),
      needUsd: 0.18,
      budgetUsd: 0.1,
    });
    // Nothing was made or recorded for it.
    expect(existsSync(generateFile(edit, 'clips'))).toBe(false);
    expect(JSON.parse(readFileSync(generateFile(edit, 'spend.json'), 'utf8')).entries).toHaveLength(
      1,
    );
    // A budget that covers it lets it go; one that covers it to the cent too.
    expect(run(SHOTS, [...clip, '--budget', '0.184']).status).toBe(0);
  });

  it('does not count a refunded request in the total the budget guard uses', () => {
    const edit = editDir();
    writeFileSync(
      generateFile(edit, 'spend.json'),
      JSON.stringify({
        entries: [
          {
            at: '2026-10-25T14:00:00.000Z',
            kind: 'clip',
            slug: 's',
            usd: 2.9,
            requestId: 'r',
            refunded: true,
          },
        ],
        total: 0,
      }),
    );
    const out = run(SHOTS, [
      'still',
      edit,
      'x',
      '--into',
      'looks',
      '--model',
      'm',
      '--prompt',
      'p',
      '--budget',
      '0.01',
    ]);
    expect(out.status).toBe(0);
  });

  it.each([
    ['an unknown command', ['dance', '<edit>']],
    ['an estimate with no kind', ['estimate', '<edit>']],
    ['a still with no --into', ['still', '<edit>', 'x', '--prompt', 'p']],
    ['a still with no prompt', ['still', '<edit>', 'x', '--into', 'looks']],
    ['a clip with no start frame', ['clip', '<edit>', 'A', '--seconds', '5', '--prompt', 'p']],
    [
      'a clip whose start frame does not exist',
      ['clip', '<edit>', 'A', '--start', 'keyframes/none.png', '--seconds', '5', '--prompt', 'p'],
    ],
    [
      'a clip with no seconds',
      ['clip', '<edit>', 'A', '--start', 'keyframes/A-start.png', '--prompt', 'p'],
    ],
    [
      'a reframe of a take that does not exist',
      ['reframe', '<edit>', 'A', '--take', '3', '--aspect', '1:1'],
    ],
    ['a still with no id', ['still', '<edit>']],
  ])('refuses %s as bad_request (exit 1)', (_label, template) => {
    const edit = withKeyframe();
    const out = run(
      SHOTS,
      template.map((arg) => (arg === '<edit>' ? edit : arg)),
    );
    expect(out.status).toBe(1);
    expect(makeShotsLineSchema.parse(out.line)).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it.each(GENERATE_ERROR_CODES.filter((code) => code !== 'over_budget'))(
    'fails on request with %s: its words and exit code',
    (code) => {
      const edit = editDir();
      const out = run(
        SHOTS,
        ['still', edit, 'x', '--into', 'looks', '--model', 'm', '--prompt', 'p'],
        { STUDIO_GENERATE_STUB_FAIL: code },
      );
      expect(out.status).toBe(generateExitCode(code));
      expect(makeShotsLineSchema.parse(out.line)).toMatchObject({
        ok: false,
        code,
        message: generateErrorMessage(code),
      });
      expect(existsSync(generateFile(edit, 'spend.json'))).toBe(false);
    },
  );

  it('fails with over_budget on request, with the numbers', () => {
    const edit = editDir();
    const out = run(SHOTS, ['clip', edit, 'A', '--seconds', '5', '--prompt', 'p', '--start', 'x'], {
      STUDIO_GENERATE_STUB_FAIL: 'over_budget',
    });
    expect(out.status).toBe(2);
    expect(makeShotsLineSchema.parse(out.line)).toEqual({
      ok: false,
      code: 'over_budget',
      message: generateErrorMessage('over_budget', { needUsd: 4.1, budgetUsd: 3 }),
      needUsd: 4.1,
      budgetUsd: 3,
    });
  });

  it('lets the free estimate fail only the way a free call fails, and a request fail after n spends', () => {
    const edit = editDir();
    const balance = { STUDIO_GENERATE_STUB_FAIL: 'balance_empty' };
    expect(run(SHOTS, ['estimate', edit, '--kind', 'clip'], balance).status).toBe(0);
    expect(
      run(SHOTS, ['estimate', edit, '--kind', 'clip'], {
        STUDIO_GENERATE_STUB_FAIL: 'key_rejected',
      }).status,
    ).toBe(2);
    expect(
      run(SHOTS, ['estimate', edit, '--kind', 'clip'], { STUDIO_GENERATE_STUB_FAIL: 'unavailable' })
        .status,
    ).toBe(3);

    const after = { ...balance, STUDIO_GENERATE_STUB_FAIL_AFTER: '2' };
    const still = (id: string) =>
      run(SHOTS, ['still', edit, id, '--into', 'looks', '--model', 'm', '--prompt', 'p'], after);
    expect(still('a').status).toBe(0);
    expect(still('b').status).toBe(0);
    const third = still('c');
    expect(third.status).toBe(2);
    expect(third.line).toMatchObject({ ok: false, code: 'balance_empty' });
    expect(JSON.parse(readFileSync(generateFile(edit, 'spend.json'), 'utf8')).entries).toHaveLength(
      2,
    );
  });

  it('needs no key and prints nothing but the one JSON line', () => {
    const edit = editDir();
    const out = run(SHOTS, ['estimate', edit, '--kind', 'still'], {});
    expect(out.stdout.trim().split('\n')).toHaveLength(1);
    expect(out.stderr).toBe('');
    expect(out.stdout).not.toMatch(/HIGGSFIELD|Authorization/);
  });

  it('prints a line parseGenerateScriptLine finds', () => {
    const edit = editDir();
    const out = run(SHOTS, ['estimate', edit, '--kind', 'still']);
    expect(parseGenerateScriptLine(makeShotsLineSchema, out.stdout)).toEqual({
      ok: true,
      command: 'estimate',
      usd: 0.004,
    });
  });
});
