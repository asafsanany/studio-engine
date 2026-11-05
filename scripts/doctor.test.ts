import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_VOICE_ID } from '../apps/server/assets/generate/make-voice.mjs';
import { loadConfig } from '../apps/server/src/config';
import {
  APIFY_LOW_CREDIT_USD,
  bundledClaudeBins,
  checkApify,
  checkApifyKey,
  checkDeno,
  checkEditVideoSkill,
  checkElevenLabsKey,
  checkElevenLabsMusic,
  checkElevenLabsVoice,
  checkHiggsfieldConnector,
  checkMoney,
  checkNode,
  checkOpenverse,
  checkSkill,
  checkSongFfmpeg,
  checkUnsplash,
  checkYouTube,
  checkYtDlp,
  compareVersions,
  DENO_MIN_VERSION,
  denoChallengeState,
  ELEVENLABS_MISSING_NOTE,
  expandHome,
  type FetchLike,
  FFMPEG_GAPS,
  ffmpegFiltersCheck,
  formatReport,
  HIGGSFIELD_CHECK_NAME,
  HYPERFRAMES_CLI_NOTE,
  hyperframesCliCheck,
  MUSIC_CHECK_BODY,
  MUSIC_CHECK_URL,
  MUSIC_PERMISSION_FIX,
  missingFfmpegGaps,
  parseDotenv,
  parseFfmpegFilters,
  proxiesToEngine,
  readConfig,
  resolveClaudeBin,
  resolveDataDir,
  resolveGenerate,
  resolveGenerateVoiceId,
  resolvePort,
  resolveReview,
  resolveSongs,
  resolveSongTools,
  resolveStock,
  runAllChecks,
  runChecks,
  songChecks,
  songsNeedMusicCheck,
  tailscaleServeCheck,
  tilde,
  VOICE_CHECK_NAME,
  YOUTUBE_TEST_URL,
  YT_DLP_MAX_AGE_DAYS,
  youtubeCheck,
} from './doctor';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'doctor-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function executable(path: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
}

function bundled(version: string, hash: string) {
  const bin = join(
    home,
    'Library/Application Support/Claude/claude-code',
    version,
    hash,
    'claude.app/Contents/MacOS/claude',
  );
  executable(bin);
  return bin;
}

describe('compareVersions', () => {
  it('orders numerically, not as text', () => {
    expect(compareVersions('2.1.299', '2.1.95')).toBeGreaterThan(0);
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
    expect(compareVersions('1.9.9', '2.0.0')).toBeLessThan(0);
  });
});

describe('bundledClaudeBins', () => {
  it('lists the desktop app binaries newest first and skips other folders', () => {
    const old = bundled('2.1.95', 'aaa');
    const newest = bundled('2.1.299', 'bbb');
    mkdirSync(join(home, 'Library/Application Support/Claude/claude-code/tmp'), {
      recursive: true,
    });
    const root = join(home, 'Library/Application Support/Claude/claude-code');
    expect(bundledClaudeBins(root)).toEqual([newest, old]);
  });

  it('is empty when the desktop app is not installed', () => {
    expect(bundledClaudeBins(join(home, 'nope'))).toEqual([]);
  });
});

describe('resolveClaudeBin', () => {
  it('prefers config, then PATH, then ~/.local/bin, then the desktop app', () => {
    const desktop = bundled('2.1.299', 'bbb');
    expect(resolveClaudeBin({ home, pathEnv: '' })).toEqual({
      path: desktop,
      source: 'desktop app',
    });

    const native = join(home, '.local/bin/claude');
    executable(native);
    expect(resolveClaudeBin({ home, pathEnv: '' })).toEqual({
      path: native,
      source: 'native install',
    });

    const onPath = join(home, 'bin/claude');
    executable(onPath);
    expect(resolveClaudeBin({ home, pathEnv: join(home, 'bin') })).toEqual({
      path: onPath,
      source: 'PATH',
    });

    expect(resolveClaudeBin({ home, pathEnv: join(home, 'bin'), configBin: '~/x/claude' })).toEqual(
      {
        path: join(home, 'x/claude'),
        source: 'config',
      },
    );
  });

  it('returns null when there is no claude anywhere', () => {
    expect(resolveClaudeBin({ home, pathEnv: '' })).toBeNull();
  });
});

describe('parseDotenv', () => {
  it('reads KEY=value lines, quotes and export prefixes', () => {
    const text = '# comment\n\nexport A=1\nB="two words"\nC=\'3\'\nD=\nnot a line\n';
    expect(parseDotenv(text)).toEqual({ A: '1', B: 'two words', C: '3', D: '' });
  });

  it('trims spaces around the value, as transcribe.py does', () => {
    expect(parseDotenv('KEY= value \nOTHER =x\n')).toEqual({ KEY: 'value', OTHER: 'x' });
  });
});

describe('checkEditVideoSkill', () => {
  const link = () => join(home, '.claude/skills/edit-video');
  const synced = () => join(home, '.claude/skills/synced/org_user/edit-video');

  function syncSkill() {
    mkdirSync(synced(), { recursive: true });
    writeFileSync(join(synced(), 'SKILL.md'), '---\nname: "edit-video"\n---\n');
  }

  it('fails with a link command when only the synced copy exists', () => {
    syncSkill();
    const check = checkEditVideoSkill(home);
    expect(check.ok).toBe(false);
    expect(check.fix).toBe(
      'ln -sfn "$HOME/.claude/skills/synced/org_user/edit-video" "$HOME/.claude/skills/edit-video"',
    );
  });

  it('passes through a link to the synced copy, and fails once the link breaks', () => {
    syncSkill();
    symlinkSync(synced(), link());
    expect(checkEditVideoSkill(home)).toMatchObject({ ok: true });
    rmSync(synced(), { recursive: true });
    expect(checkEditVideoSkill(home)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('broken'),
    });
  });

  it('asks for a claude.ai sync when there is no copy at all', () => {
    expect(checkEditVideoSkill(home).fix).toContain('claude.ai');
  });
});

describe('checkSkill', () => {
  const installed = () => join(home, '.claude/skills/video-use/SKILL.md');
  const handoff = () => join(home, '.studio-engine/handoff/video-use/SKILL.md');
  const skillText = (body = '') =>
    `---\nname: video-use\n---\nOperating mode: judgment, not questions\n${body}`;

  function write(file: string, text: string) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  }

  it('passes with a plain ✓ when the installed skill matches the handoff copy', () => {
    write(installed(), skillText('same'));
    write(handoff(), skillText('same'));
    const check = checkSkill(home);
    expect(check).toMatchObject({ ok: true, detail: '~/.claude/skills/video-use/SKILL.md' });
    expect(check.warn).toBeUndefined();
    expect(check.notes).toBeUndefined();
    expect(check.fix).toBeUndefined();
  });

  it('warns, without failing, when the handoff copy differs from the installed one', () => {
    write(installed(), skillText('old'));
    write(handoff(), skillText('new'));
    const check = checkSkill(home);
    expect(check).toMatchObject({ ok: true, warn: true });
    expect(check.detail).toContain('older copy of the skill');
    expect(check.notes).toEqual([
      '~/.claude/skills/video-use/SKILL.md differs from ~/.studio-engine/handoff/video-use/SKILL.md',
    ]);
    expect(check.fix).toBe(
      'cp ~/.studio-engine/handoff/video-use/SKILL.md ~/.claude/skills/video-use/',
    );
  });

  it('shows the warning as a ! line with its fix, and the run still counts as passing', () => {
    write(installed(), skillText('old'));
    write(handoff(), skillText('new'));
    const checks = [checkSkill(home)];
    const report = formatReport(checks);
    expect(report).toContain('! video-use skill');
    expect(report).toContain(
      'fix: cp ~/.studio-engine/handoff/video-use/SKILL.md ~/.claude/skills/video-use/',
    );
    expect(report).toContain('1 of 1 checks passed (1 with a warning).');
    // The CLI exits 1 only when some check is not ok.
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('behaves as before when there is no handoff copy', () => {
    write(installed(), skillText('old'));
    const check = checkSkill(home);
    expect(check).toMatchObject({ ok: true, detail: '~/.claude/skills/video-use/SKILL.md' });
    expect(check.warn).toBeUndefined();
    expect(check.fix).toBeUndefined();
  });

  it('still fails when the installed skill is missing or is not the Studio Engine one', () => {
    write(handoff(), skillText('new'));
    expect(checkSkill(home)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('missing'),
    });

    write(installed(), '---\nname: video-use\n---\nUpstream text that asks questions.\n');
    expect(checkSkill(home)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('asks questions'),
    });
  });

  it('shows the warning in the full run too, and leaves it passing', () => {
    write(installed(), skillText('old'));
    write(handoff(), skillText('new'));
    const check = runChecks(home, { PATH: '' }, '22.0.0').find((c) => c.name === 'video-use skill');
    expect(check).toMatchObject({ ok: true, warn: true });
  });
});

describe('checkElevenLabsMusic', () => {
  const key = 'sk_music_check_secret_value';

  function writeKey(value = key) {
    mkdirSync(join(home, 'Developer/video-use'), { recursive: true });
    writeFileSync(join(home, 'Developer/video-use/.env'), `ELEVENLABS_API_KEY=${value}\n`);
    chmodSync(join(home, 'Developer/video-use/.env'), 0o600);
  }

  /** A fetch that answers `status` and `body`, and remembers what it was asked. */
  function answering(status: number, body: unknown = {}) {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { status, text: async () => JSON.stringify(body) };
    };
    return { calls, fetchImpl };
  }

  function expectNoKey(check: object) {
    expect(JSON.stringify(check)).not.toContain(key);
    expect(formatReport([check as never])).not.toContain(key);
  }

  it('passes when the free plan call answers 200, with the key only in its header', async () => {
    writeKey();
    const { calls, fetchImpl } = answering(200, { chunks: [] });
    const check = await checkElevenLabsMusic(home, {}, fetchImpl);
    expect(check).toMatchObject({ name: 'ElevenLabs music', ok: true });
    expect(check.warn).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(MUSIC_CHECK_URL);
    expect(calls[0]?.url).toBe('https://api.elevenlabs.io/v1/music/plan');
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    });
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual(MUSIC_CHECK_BODY);
    expect(calls[0]?.init.body).not.toContain(key);
    expectNoKey(check);
  });

  it('uses the environment’s key when .env has none, as the music script does', async () => {
    const { calls, fetchImpl } = answering(200);
    await checkElevenLabsMusic(home, { ELEVENLABS_API_KEY: key }, fetchImpl);
    expect(calls[0]?.init.headers['xi-api-key']).toBe(key);
  });

  it('fails with the fix when the key can’t make music', async () => {
    writeKey();
    for (const [status, body] of [
      [401, { detail: { status: 'missing_permissions', message: `no music for ${key}` } }],
      [403, { detail: { type: 'authorization_error', code: 'insufficient_permissions' } }],
      [403, 'Forbidden'],
    ] as const) {
      const check = await checkElevenLabsMusic(home, {}, answering(status, body).fetchImpl);
      expect(check).toMatchObject({ ok: false, fix: MUSIC_PERMISSION_FIX });
      expect(formatReport([check])).toContain(
        "fix: the key can't make music: give it the Music permission at https://elevenlabs.io/app/settings/api-keys",
      );
      expectNoKey(check);
    }
  });

  it('fails when ElevenLabs says the key is invalid (a 400)', async () => {
    writeKey();
    const check = await checkElevenLabsMusic(
      home,
      {},
      answering(400, {
        detail: {
          type: 'authentication_error',
          code: 'invalid_api_key',
          message: 'API key is invalid.',
        },
      }).fetchImpl,
    );
    expect(check).toMatchObject({
      ok: false,
      detail: 'ElevenLabs says the key in ~/Developer/video-use/.env is invalid',
    });
    expect(check.fix).toContain('https://elevenlabs.io/app/settings/api-keys');
    expectNoKey(check);
  });

  it('only warns when ElevenLabs can’t be reached, takes too long, is busy or down', async () => {
    writeKey();
    const offline: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const slow: FetchLike = (_url, init) =>
      new Promise((_done, fail) => {
        init.signal.addEventListener('abort', () => fail(init.signal.reason));
      });
    const checks = [
      await checkElevenLabsMusic(home, {}, offline),
      await checkElevenLabsMusic(home, {}, slow, 50),
      await checkElevenLabsMusic(home, {}, answering(429).fetchImpl),
      await checkElevenLabsMusic(home, {}, answering(503).fetchImpl),
    ];
    for (const check of checks) {
      expect(check).toMatchObject({ name: 'ElevenLabs music', ok: true, warn: true });
      expectNoKey(check);
    }
    expect(checks.map((check) => check.detail)).toEqual([
      "not checked: ElevenLabs can't be reached (offline?)",
      "not checked: ElevenLabs didn't answer within 50 ms",
      'not checked: ElevenLabs is busy (429); try again in a minute',
      'not checked: ElevenLabs is down (503)',
    ]);
  });

  it('only warns, without calling anyone, when there is no key', async () => {
    const { calls, fetchImpl } = answering(200);
    const check = await checkElevenLabsMusic(home, {}, fetchImpl);
    expect(check).toMatchObject({ ok: true, warn: true });
    expect(calls).toHaveLength(0);
  });

  it('runs right after the ElevenLabs key check', async () => {
    writeKey();
    const names = (
      await runAllChecks(home, { PATH: '', STUDIO_SONGS: '0' }, '22.0.0', answering(200).fetchImpl)
    ).map((check) => check.name);
    expect(names.indexOf('ElevenLabs music')).toBe(names.indexOf('ElevenLabs key') + 1);
    expect(names.slice(-2)).toEqual(['Tailscale', 'money.json']);
  });
});

describe('checkElevenLabsVoice', () => {
  const key = 'sk_voice_check_secret_value';
  const defaultVoice = DEFAULT_VOICE_ID;

  function writeKey(value = key) {
    mkdirSync(join(home, 'Developer/video-use'), { recursive: true });
    writeFileSync(join(home, 'Developer/video-use/.env'), `ELEVENLABS_API_KEY=${value}\n`);
    chmodSync(join(home, 'Developer/video-use/.env'), 0o600);
  }

  const on = { STUDIO_GENERATE: '1' };

  type Answer = { status: number; body?: unknown };
  const missingPermission = (permission: string): Answer => ({
    status: 401,
    body: {
      detail: {
        type: 'authentication_error',
        code: 'unauthorized',
        status: 'missing_permissions',
        message: `The API key you used is missing the permission ${permission} to execute this operation.`,
      },
    },
  });
  const emptyText: Answer = {
    status: 400,
    body: {
      detail: {
        type: 'validation_error',
        status: 'empty_text',
        message: 'Text must not be empty.',
      },
    },
  };
  const voiceFound: Answer = { status: 200, body: { voice_id: defaultVoice } };

  /** A fetch that answers the voice, speech and sound probes as given, and remembers the calls. */
  function probes(answers: { voice?: Answer; speech?: Answer; sound?: Answer }) {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      const answer =
        (url.includes('/v1/voices/')
          ? answers.voice
          : url.includes('/v1/text-to-speech/')
            ? answers.speech
            : answers.sound) ?? emptyText;
      return { status: answer.status, text: async () => JSON.stringify(answer.body ?? {}) };
    };
    return { calls, fetchImpl };
  }

  const allGood = { voice: voiceFound, speech: emptyText, sound: emptyText };

  function expectNoKey(check: object) {
    expect(JSON.stringify(check)).not.toContain(key);
    expect(formatReport([check as never])).not.toContain(key);
  }

  it('is skipped with a plain note, and calls nobody, while Generated videos is off', async () => {
    writeKey();
    const { calls, fetchImpl } = probes(allGood);
    const check = await checkElevenLabsVoice(home, {}, {}, fetchImpl);
    expect(check).toEqual({
      name: 'ElevenLabs voice and sound effects',
      ok: true,
      detail: 'skipped: Generated videos is off (STUDIO_GENERATE)',
    });
    expect(calls).toHaveLength(0);
    expect(VOICE_CHECK_NAME).toBe('ElevenLabs voice and sound effects');
    expect(resolveGenerate({}, {})).toBe(false);
    expect(resolveGenerate({}, { generate: true })).toBe(true);
    expect(resolveGenerate({ STUDIO_GENERATE: '0' }, { generate: true })).toBe(false);
    expect(resolveGenerate({ STUDIO_GENERATE: '1' }, {})).toBe(true);
    expect(resolveGenerate({ STUDIO_GENERATE: 'maybe' }, { generate: true })).toBe(true);
  });

  it('passes when the voice exists and the key may make speech and sound effects, with free calls only', async () => {
    writeKey();
    const { calls, fetchImpl } = probes(allGood);
    const check = await checkElevenLabsVoice(home, on, {}, fetchImpl);
    expect(check).toMatchObject({ name: VOICE_CHECK_NAME, ok: true });
    expect(check.warn).toBeUndefined();
    expect(check.detail).toContain(defaultVoice);
    expect(calls.map(({ url, init }) => `${init.method} ${url}`).sort()).toEqual([
      `GET https://api.elevenlabs.io/v1/voices/${defaultVoice}`,
      `POST https://api.elevenlabs.io/v1/sound-generation`,
      `POST https://api.elevenlabs.io/v1/text-to-speech/${defaultVoice}?output_format=mp3_44100_128`,
    ]);
    // Nothing is made: both POSTs ask for no text at all, and the key is only in the headers.
    for (const { init } of calls.filter(({ init }) => init.method === 'POST')) {
      expect(JSON.parse(init.body ?? '{}').text).toBe('');
    }
    for (const { url, init } of calls) {
      expect(init.headers['xi-api-key']).toBe(key);
      expect(url).not.toContain(key);
      expect(init.body ?? '').not.toContain(key);
    }
    expectNoKey(check);
  });

  it('uses the voice the environment or config.json names, else the default', async () => {
    writeKey();
    expect(resolveGenerateVoiceId({}, {})).toBe(defaultVoice);
    expect(resolveGenerateVoiceId({}, { generateVoiceId: 'JBFqnCBsd6RMkjVDRZzb' })).toBe(
      'JBFqnCBsd6RMkjVDRZzb',
    );
    expect(
      resolveGenerateVoiceId(
        { STUDIO_GENERATE_VOICE_ID: ' onwK4e9ZLuTAKqWW03F9 ' },
        { generateVoiceId: 'JBFqnCBsd6RMkjVDRZzb' },
      ),
    ).toBe('onwK4e9ZLuTAKqWW03F9');
    // A value the engine would refuse is skipped.
    expect(resolveGenerateVoiceId({ STUDIO_GENERATE_VOICE_ID: '../x' }, {})).toBe(defaultVoice);
    expect(resolveGenerateVoiceId({}, { generateVoiceId: 7 as unknown as string })).toBe(
      defaultVoice,
    );
    const { calls, fetchImpl } = probes(allGood);
    await checkElevenLabsVoice(home, on, { generateVoiceId: 'JBFqnCBsd6RMkjVDRZzb' }, fetchImpl);
    expect(calls.some(({ url }) => url.endsWith('/v1/voices/JBFqnCBsd6RMkjVDRZzb'))).toBe(true);
  });

  it('reads the switch from config.json too', async () => {
    writeKey();
    const { calls, fetchImpl } = probes(allGood);
    const check = await checkElevenLabsVoice(home, {}, { generate: true }, fetchImpl);
    expect(check.ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('fails when the voice does not exist, with the fix', async () => {
    writeKey();
    for (const voice of [{ status: 404 }, { status: 400 }]) {
      const check = await checkElevenLabsVoice(
        home,
        on,
        {},
        probes({ ...allGood, voice }).fetchImpl,
      );
      expect(check).toMatchObject({ ok: false, detail: `ElevenLabs has no voice ${defaultVoice}` });
      expect(check.fix).toContain('STUDIO_GENERATE_VOICE_ID');
    }
    // When the key may not read voices, the speech probe says so.
    const blind = await checkElevenLabsVoice(
      home,
      on,
      {},
      probes({ voice: missingPermission('voices_read'), speech: { status: 404 }, sound: emptyText })
        .fetchImpl,
    );
    expect(blind).toMatchObject({ ok: false, detail: `ElevenLabs has no voice ${defaultVoice}` });
  });

  it('fails when the key may not make speech or sound effects, and names what to allow', async () => {
    writeKey();
    const noSpeech = await checkElevenLabsVoice(
      home,
      on,
      {},
      probes({ ...allGood, speech: missingPermission('text_to_speech') }).fetchImpl,
    );
    expect(noSpeech).toMatchObject({ ok: false, detail: 'the key may not use Text to Speech' });
    expect(noSpeech.fix).toContain('https://elevenlabs.io/app/settings/api-keys');
    expect(noSpeech.fix).toContain(
      'allow Text to Speech for the key in ~/Developer/video-use/.env',
    );

    const noneOfThem = await checkElevenLabsVoice(
      home,
      on,
      {},
      probes({
        voice: missingPermission('voices_read'),
        speech: missingPermission('text_to_speech'),
        sound: missingPermission('sound_generation'),
      }).fetchImpl,
    );
    expect(noneOfThem).toMatchObject({
      ok: false,
      detail: 'the key may not use Text to Speech and Sound Effects',
    });
    expect(noneOfThem.fix).toContain('allow Text to Speech, Sound Effects and Voices (read)');
    expectNoKey(noneOfThem);

    const refused = await checkElevenLabsVoice(
      home,
      on,
      {},
      probes({ ...allGood, sound: { status: 403 } }).fetchImpl,
    );
    expect(refused).toMatchObject({ ok: false, detail: 'ElevenLabs refused the key (403)' });
  });

  it('only warns when the key may not read voices (the voice script does not need it)', async () => {
    writeKey();
    const check = await checkElevenLabsVoice(
      home,
      on,
      {},
      probes({ ...allGood, voice: missingPermission('voices_read') }).fetchImpl,
    );
    expect(check).toMatchObject({ ok: true, warn: true });
    expect(check.detail).toContain(`voice ${defaultVoice} is not checked`);
    expect(check.fix).toContain('Voices (read)');
  });

  it('fails when ElevenLabs says the key is invalid', async () => {
    writeKey();
    const invalid: Answer = {
      status: 401,
      body: { detail: { type: 'authentication_error', status: 'invalid_api_key' } },
    };
    const check = await checkElevenLabsVoice(
      home,
      on,
      {},
      probes({ voice: invalid, speech: invalid, sound: invalid }).fetchImpl,
    );
    expect(check).toMatchObject({
      ok: false,
      detail: 'ElevenLabs says the key in ~/Developer/video-use/.env is invalid',
    });
    expectNoKey(check);
  });

  it('warns, and does not fail, when there is no key or no answer', async () => {
    const noKey = await checkElevenLabsVoice(home, on, {}, probes(allGood).fetchImpl);
    expect(noKey).toMatchObject({ ok: true, warn: true });
    expect(noKey.detail).toContain('there is no key');

    writeKey();
    const offline: FetchLike = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    const slow: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    for (const check of [
      await checkElevenLabsVoice(home, on, {}, offline),
      await checkElevenLabsVoice(home, on, {}, slow, 50),
      await checkElevenLabsVoice(
        home,
        on,
        {},
        probes({ ...allGood, speech: { status: 429 } }).fetchImpl,
      ),
      await checkElevenLabsVoice(
        home,
        on,
        {},
        probes({ ...allGood, sound: { status: 503 } }).fetchImpl,
      ),
    ]) {
      expect(check).toMatchObject({ name: VOICE_CHECK_NAME, ok: true, warn: true });
      expect(check.detail).toMatch(/^not checked: /);
      expectNoKey(check);
    }
  });

  it('runs right after the ElevenLabs music check, and says it is skipped by default', async () => {
    writeKey();
    const names = (
      await runAllChecks(home, { PATH: '', STUDIO_SONGS: '0' }, '22.0.0', probes(allGood).fetchImpl)
    ).map((check) => check.name);
    expect(names.indexOf(VOICE_CHECK_NAME)).toBe(names.indexOf('ElevenLabs music') + 1);
    const checks = await runAllChecks(
      home,
      { PATH: '', STUDIO_SONGS: '0', ...on },
      '22.0.0',
      probes(allGood).fetchImpl,
    );
    expect(checks.find((check) => check.name === VOICE_CHECK_NAME)).toMatchObject({ ok: true });
    expect(formatReport(checks)).toContain('ElevenLabs voice and sound effects');
  });
});

describe('checkHiggsfieldConnector', () => {
  const on = { STUDIO_GENERATE: '1', PATH: '' };
  const bin = () => {
    const path = join(home, 'claude-stub');
    writeFileSync(path, '#!/bin/sh\n');
    chmodSync(path, 0o755);
    return path;
  };
  const config = () => ({ claudeBin: bin() });
  const listing =
    (...lines: string[]) =>
    () => ({
      ok: true,
      stdout: `Checking MCP server health…\n\n${lines.join('\n')}\n`,
    });

  it('is skipped with a plain note, and runs nothing, while Generated videos is off', () => {
    let ran = 0;
    const check = checkHiggsfieldConnector({ PATH: '', STUDIO_GENERATE: '0' }, {}, home, () => {
      ran += 1;
      return { ok: true, stdout: '' };
    });
    expect(check).toEqual({
      name: HIGGSFIELD_CHECK_NAME,
      ok: true,
      detail: 'skipped: Generated videos is off (STUDIO_GENERATE)',
    });
    expect(HIGGSFIELD_CHECK_NAME).toBe('Higgsfield connector');
    expect(ran).toBe(0);
  });

  it('passes when the connector is connected, and not mistaking the other Higgsfield connector for it', () => {
    const check = checkHiggsfieldConnector(
      on,
      config(),
      home,
      listing(
        'claude.ai Higgsfield AI: https://claude-mcp.higgsfield.ai/mcp - ! Needs authentication',
        'claude.ai Higgsfield: https://mcp.higgsfield.ai/mcp - ✔ Connected',
        'claude.ai Linear: https://mcp.linear.app/mcp - ✔ Connected',
      ),
    );
    expect(check).toMatchObject({ name: 'Higgsfield connector', ok: true });
    expect(check.warn).toBeUndefined();
    expect(check.detail).toContain("plan's credits");
  });

  it('fails when the connector is not in the account, or needs signing in again, with its fix', () => {
    const missing = checkHiggsfieldConnector(
      on,
      config(),
      home,
      listing('claude.ai Linear: https://mcp.linear.app/mcp - ✔ Connected'),
    );
    expect(missing).toMatchObject({
      ok: false,
      detail: expect.stringContaining('not in your Claude'),
    });
    expect(missing.fix).toContain('Connectors');
    const auth = checkHiggsfieldConnector(
      on,
      config(),
      home,
      listing('claude.ai Higgsfield: https://mcp.higgsfield.ai/mcp - ! Needs authentication'),
    );
    expect(auth).toMatchObject({ ok: false, detail: expect.stringContaining('signing in') });
    expect(auth.fix).toContain('reconnect');
  });

  it('only warns when it cannot tell: no Claude Code, no answer, or a connector that did not connect', () => {
    const noBin = checkHiggsfieldConnector(on, {}, home, listing());
    expect(noBin).toMatchObject({ ok: true, warn: true });
    const silent = checkHiggsfieldConnector(on, config(), home, () => ({ ok: false, stdout: '' }));
    expect(silent).toMatchObject({ ok: true, warn: true });
    const failed = checkHiggsfieldConnector(
      on,
      config(),
      home,
      listing('claude.ai Higgsfield: https://mcp.higgsfield.ai/mcp - ✗ Failed to connect'),
    );
    expect(failed).toMatchObject({ ok: true, warn: true });
    expect(failed.detail).toContain('did not connect');
  });

  it('is in the full report right after the ElevenLabs checks, with the other checks around it', async () => {
    const checks = await runAllChecks(
      home,
      { PATH: '', STUDIO_SONGS: '0', STUDIO_GENERATE: '1' },
      '22.0.0',
      (async () => ({ status: 200, text: async () => '{}' })) as FetchLike,
    );
    const names = checks.map((check) => check.name);
    expect(names.indexOf('Higgsfield connector')).toBe(
      names.indexOf('ElevenLabs voice and sound effects') + 1,
    );
    expect(formatReport(checks)).toContain('Higgsfield connector');
  });
});

describe('checkElevenLabsKey', () => {
  const envFile = () => join(home, 'Developer/video-use/.env');

  function writeEnv(text: string, mode: number) {
    mkdirSync(join(home, 'Developer/video-use'), { recursive: true });
    writeFileSync(envFile(), text);
    chmodSync(envFile(), mode);
  }

  it('passes for a key in .env with mode 600 and never prints the key', () => {
    writeEnv('ELEVENLABS_API_KEY= sk_secret_value\n', 0o600);
    const check = checkElevenLabsKey(home, {});
    expect(check.ok).toBe(true);
    expect(JSON.stringify(check)).not.toContain('sk_secret_value');
  });

  it('fails when .env is readable by others', () => {
    writeEnv('ELEVENLABS_API_KEY=sk_secret_value\n', 0o644);
    const check = checkElevenLabsKey(home, {});
    expect(check.ok).toBe(false);
    expect(check.fix).toBe('chmod 600 ~/Developer/video-use/.env');
  });

  it('fails for an empty key and for a key only in the shell environment', () => {
    writeEnv('ELEVENLABS_API_KEY=\n', 0o600);
    expect(checkElevenLabsKey(home, {}).ok).toBe(false);
    const envOnly = checkElevenLabsKey(home, { ELEVENLABS_API_KEY: 'sk_secret_value' });
    expect(envOnly.ok).toBe(false);
    expect(JSON.stringify(envOnly)).not.toContain('sk_secret_value');
  });

  it('says what a missing key costs, for an empty key and for a key only in the shell', () => {
    writeEnv('ELEVENLABS_API_KEY=\n', 0o600);
    const empty = checkElevenLabsKey(home, {});
    const envOnly = checkElevenLabsKey(home, { ELEVENLABS_API_KEY: 'sk_secret_value' });
    expect(empty.notes).toEqual([ELEVENLABS_MISSING_NOTE]);
    expect(envOnly.notes).toEqual([ELEVENLABS_MISSING_NOTE]);
    expect(formatReport([envOnly])).toContain("voice notes won't be transcribed");
    expect(formatReport([envOnly])).toContain(
      "Without it, voice notes won't be transcribed, and edits can't transcribe the footage.",
    );
    expect(JSON.stringify(empty)).not.toContain('sk_secret_value');
    expect(JSON.stringify(envOnly)).not.toContain('sk_secret_value');
    expect(formatReport([envOnly])).not.toContain('sk_secret_value');
  });

  it('says the same when there is no .env at all', () => {
    const check = checkElevenLabsKey(home, {});
    expect(check.detail).toBe('not set in ~/Developer/video-use/.env');
    expect(check.notes).toEqual([ELEVENLABS_MISSING_NOTE]);
    expect(formatReport([check])).toContain("voice notes won't be transcribed");
  });

  it('adds no note when the key is in .env, whatever the mode', () => {
    writeEnv('ELEVENLABS_API_KEY=sk_secret_value\n', 0o600);
    expect(checkElevenLabsKey(home, {}).notes).toBeUndefined();
    chmodSync(envFile(), 0o644);
    expect(checkElevenLabsKey(home, {}).notes).toBeUndefined();
  });
});

// The start of `ffmpeg -hide_banner -filters` (legend, then one row per filter).
const FILTER_HEADER = `Filters:
  T.. = Timeline support
  .S. = Slice threading
  A = Audio input/output
  V = Video input/output
  N = Dynamic number and/or type of input/output
  | = Source or sink filter
 ------
 TS aap               AA->A      Apply Affine Projection algorithm to first audio stream.
 .. scale_vt          V->V       Scale Videotoolbox frames
 .S tonemap           V->V       Conversion to/from different dynamic ranges.
 T. overlay           VV->V      Overlay a video source on top of the input.
 .. testsrc           |->V       Generate test pattern.
 .. nullsink          V->|       Do absolutely nothing with the input video.
`;

const ZSCALE =
  ' .. zscale             V->V       Apply resizing, colorspace and bit depth conversion.\n';
const SUBTITLES =
  ' T. subtitles          V->V       Render text subtitles onto input video using the libass library.\n';
const ASS =
  ' T. ass                V->V       Render ASS subtitles onto input video using the libass library.\n';
const DRAWTEXT =
  ' T. drawtext           V->V       Draw text on top of video frames using libfreetype library.\n';

/** The listing from Homebrew's plain ffmpeg 9.0.2, which has none of the three. */
const STOCK_FILTERS = FILTER_HEADER;
/** The same, built with zimg, libass and freetype. */
const FULL_FILTERS = FILTER_HEADER + ZSCALE + SUBTITLES + ASS + DRAWTEXT;

describe('parseFfmpegFilters', () => {
  it('reads filter names and skips the legend and the divider', () => {
    const names = parseFfmpegFilters(STOCK_FILTERS);
    expect([...names].sort()).toEqual([
      'aap',
      'nullsink',
      'overlay',
      'scale_vt',
      'testsrc',
      'tonemap',
    ]);
  });

  it('reads the older three-flag rows and Windows line endings', () => {
    const names = parseFfmpegFilters(
      ' T.C zscale            V->V       Apply colorspace conversion.\r\n .SC scale2ref        VV->VV     Scale.\r\n',
    );
    expect([...names].sort()).toEqual(['scale2ref', 'zscale']);
  });

  it('is empty for text that is not a filter list', () => {
    expect(parseFfmpegFilters('')).toEqual(new Set());
    expect(parseFfmpegFilters('ffmpeg: command not found\n')).toEqual(new Set());
  });
});

describe('missingFfmpegGaps', () => {
  const missing = (listing: string) =>
    missingFfmpegGaps(parseFfmpegFilters(listing)).map((g) => g.name);

  it('reports all three on a stock build', () => {
    expect(missing(STOCK_FILTERS)).toEqual(['zscale', 'subtitles/ass', 'drawtext']);
  });

  it('reports nothing when zscale, subtitles/ass and drawtext are all there', () => {
    expect(missing(FULL_FILTERS)).toEqual([]);
  });

  it('accepts either subtitles or ass for captions', () => {
    expect(missing(FILTER_HEADER + ZSCALE + DRAWTEXT + SUBTITLES)).toEqual([]);
    expect(missing(FILTER_HEADER + ZSCALE + DRAWTEXT + ASS)).toEqual([]);
  });

  it('reports only what is missing', () => {
    expect(missing(FILTER_HEADER + ZSCALE + SUBTITLES)).toEqual(['drawtext']);
    expect(missing(FILTER_HEADER + DRAWTEXT + ASS)).toEqual(['zscale']);
  });

  it('does not mistake other filters for these (scale, tonemap, subtitle-like names)', () => {
    const listing = `${FILTER_HEADER} .. scale              V->V       Scale the input video size.\n .. subtitles2         V->V       Not the real one.\n`;
    expect(missing(listing)).toEqual(['zscale', 'subtitles/ass', 'drawtext']);
  });
});

describe('ffmpegFiltersCheck', () => {
  const fix = 'brew install ffmpeg-full';

  it('warns, without failing, when filters are missing, with the effect and the fix', () => {
    const check = ffmpegFiltersCheck(STOCK_FILTERS, fix);
    expect(check.ok).toBe(true);
    expect(check.warn).toBe(true);
    expect(check.fix).toBe(fix);
    expect(check.detail).toBe('missing zscale (zimg), subtitles/ass (libass), drawtext (freetype)');
    expect(check.notes).toHaveLength(FFMPEG_GAPS.length);
    expect(check.notes?.[0]).toContain('iPhone HDR');
    expect(check.notes?.[1]).toContain('captions');
    expect(check.notes?.[2]).toContain('text');
  });

  it('names only the missing filters', () => {
    const check = ffmpegFiltersCheck(FILTER_HEADER + ZSCALE + SUBTITLES, fix);
    expect(check.warn).toBe(true);
    expect(check.detail).toBe('missing drawtext (freetype)');
    expect(check.notes).toHaveLength(1);
  });

  it('is a plain pass with no warning and no fix when nothing is missing', () => {
    const check = ffmpegFiltersCheck(FULL_FILTERS, fix);
    expect(check).toMatchObject({
      ok: true,
      detail: 'zscale (zimg), subtitles/ass (libass), drawtext (freetype)',
    });
    expect(check.warn).toBeUndefined();
    expect(check.notes).toBeUndefined();
    expect(check.fix).toBeUndefined();
  });

  it("warns that it couldn't read the list instead of claiming everything is missing", () => {
    const check = ffmpegFiltersCheck('unexpected output\n', fix);
    expect(check).toMatchObject({ ok: true, warn: true });
    expect(check.detail).toContain("couldn't read");
  });
});

describe('runChecks ffmpeg filters', () => {
  function fakeFfmpeg(listing: string) {
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'listing.txt'), listing);
    const ffmpeg = join(bin, 'ffmpeg');
    writeFileSync(
      ffmpeg,
      `#!/bin/sh\nif [ "$1" = "-version" ]; then echo "ffmpeg version fake"; else cat "${join(bin, 'listing.txt')}"; fi\n`,
    );
    chmodSync(ffmpeg, 0o755);
    return bin;
  }

  const filtersCheck = (listing: string) =>
    runChecks(home, { PATH: fakeFfmpeg(listing) }, '22.0.0').find(
      (c) => c.name === 'ffmpeg filters',
    );

  it('runs the found ffmpeg and warns about a stock build without failing it', () => {
    expect(filtersCheck(STOCK_FILTERS)).toMatchObject({ ok: true, warn: true });
  });

  it('passes quietly for a build with all three', () => {
    const check = filtersCheck(FULL_FILTERS);
    expect(check?.ok).toBe(true);
    expect(check?.warn).toBeUndefined();
  });
});

describe('hyperframesCliCheck', () => {
  const failing = {
    ok: false,
    stdout: '',
    stderr: 'npm error code ENOTFOUND\nnpm error network request failed\n',
  };

  it.each([true, false])('passes with the version when npx works, Review %s', (review) => {
    expect(hyperframesCliCheck({ ok: true, stdout: '0.8.181\n', stderr: '' }, review)).toEqual({
      name: 'HyperFrames CLI',
      ok: true,
      detail: '0.8.181 (npx hyperframes)',
    });
  });

  it.each([true, false])(
    'passes quietly even when the version prints nothing, Review %s',
    (review) => {
      const check = hyperframesCliCheck({ ok: true, stdout: '', stderr: '' }, review);
      expect(check).toMatchObject({ ok: true, detail: 'installed (npx hyperframes)' });
      expect(check.warn).toBeUndefined();
      expect(check.notes).toBeUndefined();
    },
  );

  it('is an error when the command fails with Review on, with the reason, the note and the fix', () => {
    const check = hyperframesCliCheck(failing, true);
    expect(check).toMatchObject({
      name: 'HyperFrames CLI',
      ok: false,
      detail: '`npx hyperframes --version` failed: npm error code ENOTFOUND',
      notes: [HYPERFRAMES_CLI_NOTE.reviewOn],
    });
    expect(check.warn).toBeUndefined();
    expect(check.fix).toContain('npx --yes hyperframes --version');
    expect(check.fix).toContain('needs the network');
  });

  it('only warns when the command fails with Review off, with the same reason and fix', () => {
    const check = hyperframesCliCheck(failing, false);
    expect(check).toMatchObject({
      name: 'HyperFrames CLI',
      ok: true,
      warn: true,
      detail: '`npx hyperframes --version` failed: npm error code ENOTFOUND',
      notes: [HYPERFRAMES_CLI_NOTE.reviewOff],
    });
    expect(check.fix).toBe(hyperframesCliCheck(failing, true).fix);
  });

  it('falls back to stdout, then to "no output", for the reason', () => {
    for (const review of [true, false]) {
      expect(
        hyperframesCliCheck({ ok: false, stdout: 'bad things\n', stderr: '' }, review).detail,
      ).toContain('failed: bad things');
      expect(hyperframesCliCheck({ ok: false, stdout: '', stderr: '' }, review).detail).toContain(
        'failed: no output',
      );
    }
  });

  it('is an error when there is no npx at all with Review on', () => {
    const check = hyperframesCliCheck(null, true);
    expect(check).toMatchObject({
      ok: false,
      detail: 'npx not found on PATH',
      notes: [HYPERFRAMES_CLI_NOTE.reviewOn],
      fix: 'nvm use 22, then: npx --yes hyperframes --version',
    });
    expect(check.warn).toBeUndefined();
  });

  it('warns when there is no npx at all with Review off', () => {
    expect(hyperframesCliCheck(null, false)).toMatchObject({
      ok: true,
      warn: true,
      detail: 'npx not found on PATH',
      notes: [HYPERFRAMES_CLI_NOTE.reviewOff],
      fix: 'nvm use 22, then: npx --yes hyperframes --version',
    });
  });

  it('tells the two cases apart in plain words', () => {
    expect(HYPERFRAMES_CLI_NOTE.reviewOn).toContain('Review is on');
    expect(HYPERFRAMES_CLI_NOTE.reviewOn).toContain('every job fails');
    expect(HYPERFRAMES_CLI_NOTE.reviewOff).toContain('Review is off');
    expect(HYPERFRAMES_CLI_NOTE.reviewOff).toContain('can still finish');
  });

  it('prints an error as a ✗ line with its note and fix, and the run no longer passes', () => {
    const checks = [hyperframesCliCheck(null, true)];
    const report = formatReport(checks);
    expect(report).toContain('✗ HyperFrames CLI');
    expect(report).toContain('npx not found on PATH');
    expect(report).toContain(HYPERFRAMES_CLI_NOTE.reviewOn);
    expect(report).toContain('fix: nvm use 22, then: npx --yes hyperframes --version');
    expect(report).toContain('0 of 1 checks passed.');
    expect(checks.every((c) => c.ok)).toBe(false);
  });

  it('prints a warning as a ! line with its note and fix, and the run still passes', () => {
    const checks = [hyperframesCliCheck(null, false)];
    const report = formatReport(checks);
    expect(report).toContain('! HyperFrames CLI');
    expect(report).toContain('npx not found on PATH');
    expect(report).toContain(HYPERFRAMES_CLI_NOTE.reviewOff);
    expect(report).toContain('fix: nvm use 22, then: npx --yes hyperframes --version');
    expect(report).toContain('1 of 1 checks passed (1 with a warning).');
    expect(checks.every((c) => c.ok)).toBe(true);
  });
});

describe('runChecks HyperFrames CLI', () => {
  const cliCheck = (env: NodeJS.ProcessEnv) =>
    runChecks(home, env, '22.0.0').find((c) => c.name === 'HyperFrames CLI');

  function fakeNpx(script: string) {
    const bin = join(home, 'npx-bin');
    mkdirSync(bin, { recursive: true });
    executable(join(bin, 'npx'));
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\n${script}\n`);
    return bin;
  }

  function writeEngineConfig(config: object) {
    mkdirSync(join(home, '.studio-engine'), { recursive: true });
    writeFileSync(join(home, '.studio-engine', 'config.json'), JSON.stringify(config));
  }

  it('is an error without spawning anything when PATH has no npx and Review is on', () => {
    const check = cliCheck({ PATH: '' });
    expect(check).toMatchObject({ ok: false, detail: 'npx not found on PATH' });
    expect(check?.warn).toBeUndefined();
  });

  it('warns without spawning anything when PATH has no npx and STUDIO_REVIEW=0', () => {
    expect(cliCheck({ PATH: '', STUDIO_REVIEW: '0' })).toMatchObject({
      ok: true,
      warn: true,
      detail: 'npx not found on PATH',
    });
  });

  it('runs npx --yes hyperframes --version and shows the version, with Review on and off', () => {
    const bin = fakeNpx('[ "$1 $2 $3" = "--yes hyperframes --version" ] && echo 0.8.181');
    for (const review of [undefined, '1', '0']) {
      expect(cliCheck({ PATH: bin, STUDIO_REVIEW: review })).toEqual({
        name: 'HyperFrames CLI',
        ok: true,
        detail: '0.8.181 (npx hyperframes)',
      });
    }
  });

  it('turns telemetry and skill installs off for that run', () => {
    const bin = fakeNpx('echo "$HYPERFRAMES_NO_TELEMETRY $HYPERFRAMES_SKIP_SKILLS"');
    expect(cliCheck({ PATH: bin })?.detail).toBe('1 1 (npx hyperframes)');
  });

  it('is an error, and fails the doctor, when the command fails with Review on', () => {
    const bin = fakeNpx('echo "no network" >&2; exit 1');
    const check = cliCheck({ PATH: bin });
    expect(check).toMatchObject({
      ok: false,
      detail: '`npx hyperframes --version` failed: no network',
      notes: [HYPERFRAMES_CLI_NOTE.reviewOn],
    });
    expect(check?.warn).toBeUndefined();
    const checks = runChecks(home, { PATH: bin }, '22.0.0');
    expect(checks.every((c) => c.ok)).toBe(false);
  });

  it('warns, and does not fail on its own, when the command fails and STUDIO_REVIEW=0', () => {
    const bin = fakeNpx('echo "no network" >&2; exit 1');
    expect(cliCheck({ PATH: bin, STUDIO_REVIEW: '0' })).toMatchObject({
      ok: true,
      warn: true,
      detail: '`npx hyperframes --version` failed: no network',
      notes: [HYPERFRAMES_CLI_NOTE.reviewOff],
    });
  });

  it('reads Review from config.json too, and the environment wins over the file', () => {
    const bin = fakeNpx('exit 1');
    writeEngineConfig({ review: false });
    expect(cliCheck({ PATH: bin })).toMatchObject({ ok: true, warn: true });
    expect(cliCheck({ PATH: bin, STUDIO_REVIEW: '1' })).toMatchObject({ ok: false });
    writeEngineConfig({ review: true });
    expect(cliCheck({ PATH: bin })).toMatchObject({ ok: false });
    expect(cliCheck({ PATH: bin, STUDIO_REVIEW: 'false' })).toMatchObject({
      ok: true,
      warn: true,
    });
  });
});

describe('resolveReview', () => {
  it('is on unless something says otherwise', () => {
    expect(resolveReview({}, {})).toBe(true);
  });

  it('takes STUDIO_REVIEW 0 or false (any case) as off, and 1 or true as on', () => {
    for (const off of ['0', 'false', 'FALSE', 'False']) {
      expect(resolveReview({ STUDIO_REVIEW: off }, {}), off).toBe(false);
    }
    for (const on of ['1', 'true', 'TRUE']) {
      expect(resolveReview({ STUDIO_REVIEW: on }, { review: false }), on).toBe(true);
    }
  });

  it('takes "review" in config.json, and lets the environment win', () => {
    expect(resolveReview({}, { review: false })).toBe(false);
    expect(resolveReview({}, { review: true })).toBe(true);
    expect(resolveReview({ STUDIO_REVIEW: '0' }, { review: true })).toBe(false);
    expect(resolveReview({ STUDIO_REVIEW: '1' }, { review: false })).toBe(true);
  });

  it('skips an empty or invalid value, as the engine would refuse it', () => {
    expect(resolveReview({ STUDIO_REVIEW: '' }, { review: false })).toBe(false);
    expect(resolveReview({ STUDIO_REVIEW: 'off' }, { review: false })).toBe(false);
    expect(resolveReview({ STUDIO_REVIEW: 'no' }, {})).toBe(true);
    expect(resolveReview({}, { review: 'no' as unknown as boolean })).toBe(true);
  });

  it('gives the same answer as the engine for every valid setting', () => {
    const envs = [undefined, '', '1', '0', 'true', 'false', 'TRUE', 'FALSE'];
    const files = [undefined, true, false];
    for (const env of envs) {
      for (const file of files) {
        mkdirSync(join(home, '.studio-engine'), { recursive: true });
        const config = file === undefined ? {} : { review: file };
        const configFile = join(home, '.studio-engine', 'config.json');
        writeFileSync(configFile, JSON.stringify(config));
        const settings = { STUDIO_REVIEW: env };
        expect(resolveReview(settings, readConfig(configFile)), `${env} / ${file}`).toBe(
          loadConfig({ home, env: settings }).review,
        );
      }
    }
  });
});

describe('resolveDataDir', () => {
  it('is ~/.studio-engine unless something says otherwise', () => {
    expect(resolveDataDir(home, {}, {})).toBe(join(home, '.studio-engine'));
  });

  it('takes STUDIO_DATA_DIR over config.json, and expands ~', () => {
    expect(resolveDataDir(home, { STUDIO_DATA_DIR: '/data/env' }, { dataDir: '/data/file' })).toBe(
      '/data/env',
    );
    expect(resolveDataDir(home, {}, { dataDir: '~/studio-data' })).toBe(join(home, 'studio-data'));
  });

  it('skips an empty or relative value, as the engine would refuse it', () => {
    expect(resolveDataDir(home, { STUDIO_DATA_DIR: '' }, { dataDir: '/data/file' })).toBe(
      '/data/file',
    );
    expect(resolveDataDir(home, { STUDIO_DATA_DIR: 'relative/dir' }, {})).toBe(
      join(home, '.studio-engine'),
    );
  });
});

describe('checkMoney', () => {
  // Every case points the doctor at a folder under the temp home, never at the real data folder.
  let dataDir: string;
  const env = () => ({ STUDIO_DATA_DIR: dataDir });
  const writeMoney = (text: string) => writeFileSync(join(dataDir, 'money.json'), text);
  const claude = {
    id: 'claude',
    name: 'Claude Max plan',
    amount: 200,
    currency: 'USD',
    every: 'month',
    day: 12,
    since: '2026-08-12',
  };

  beforeEach(() => {
    dataDir = join(home, 'data');
    mkdirSync(dataDir, { recursive: true });
  });

  it('passes when the file is not there, and says what that means', () => {
    expect(checkMoney(home, env())).toEqual({
      name: 'money.json',
      ok: true,
      detail: 'not found (200 per job, no expenses yet)',
    });
  });

  it('counts the subscriptions and charges of a valid file', () => {
    writeMoney(
      JSON.stringify({
        subscriptions: [claude, { ...claude, id: 'eleven', name: 'ElevenLabs', day: 3 }],
        charges: [
          {
            date: '2026-10-14',
            item: 'Stock',
            what: 'Clip',
            amount: 7.5,
            currency: 'ILS',
            job: 'A/B',
          },
        ],
      }),
    );
    expect(checkMoney(home, env())).toEqual({
      name: 'money.json',
      ok: true,
      detail: '2 subscriptions, 1 charge',
    });
  });

  it('counts an empty file as 0 subscriptions, 0 charges', () => {
    writeMoney('{}');
    expect(checkMoney(home, env()).detail).toBe('0 subscriptions, 0 charges');
  });

  it('fails with the first problem, where it is in the file, and a fix', () => {
    writeMoney(JSON.stringify({ subscriptions: [{ ...claude, day: 40 }], usdToIls: -1 }));
    const check = checkMoney(home, env());
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/^invalid – usdToIls: /);
    expect(check.notes).toHaveLength(1);
    expect(check.notes?.[0]).toMatch(/^also: subscriptions\[0\]\.day: /);
    expect(check.fix).toContain('~/data/money.json');
  });

  it('says the engine keeps using the last good copy, when one was saved', () => {
    writeFileSync(join(dataDir, 'money.last-good.json'), JSON.stringify({ pricePerJob: 40 }));
    writeMoney('{ nope');
    const check = checkMoney(home, env());
    expect(check.ok).toBe(false);
    expect(check.fix).toContain('~/data/money.json');
    expect(check.fix).toContain('last good copy it saved (money.last-good.json)');
    expect(check.fix).not.toContain('refused');
  });

  it('says Mark delivered is refused, when no good copy was saved', () => {
    writeMoney('{ nope');
    const check = checkMoney(home, env());
    expect(check.ok).toBe(false);
    expect(check.fix).toContain('no good copy saved');
    expect(check.fix).toContain('Mark delivered is refused');
  });

  it('fails for a file that is not JSON', () => {
    writeMoney('{ "pricePerJob": ');
    const check = checkMoney(home, env());
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/^invalid – cannot be read as JSON/);
  });

  it('reads the data folder from config.json too', () => {
    const other = join(home, 'elsewhere');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'money.json'), JSON.stringify({ charges: [] }));
    mkdirSync(join(home, '.studio-engine'), { recursive: true });
    writeFileSync(join(home, '.studio-engine', 'config.json'), JSON.stringify({ dataDir: other }));
    expect(checkMoney(home, {}).detail).toBe('0 subscriptions, 0 charges');
  });

  it('is the last line of the report, and fails the run when the file is invalid', () => {
    writeMoney('{ nope');
    const checks = runChecks(home, { ...env(), PATH: '' }, '22.0.0');
    const last = checks[checks.length - 1];
    expect(last?.name).toBe('money.json');
    expect(last?.ok).toBe(false);
    expect(formatReport(checks)).toContain('✗ money.json');
  });
});

describe('small helpers', () => {
  it('expands and shortens the home directory', () => {
    expect(expandHome('~/a', home)).toBe(join(home, 'a'));
    expect(expandHome('/abs', home)).toBe('/abs');
    expect(tilde(join(home, 'a/b'), home)).toBe('~/a/b');
  });

  it('accepts Node 22 and newer', () => {
    expect(checkNode('22.23.2').ok).toBe(true);
    expect(checkNode('20.11.0').ok).toBe(false);
  });

  it('prints the fix only for failed checks', () => {
    const report = formatReport([
      { name: 'A', ok: true, detail: 'fine', fix: 'unused' },
      { name: 'B', ok: false, detail: 'broken', fix: 'do this' },
    ]);
    expect(report).toContain('✓ A');
    expect(report).toContain('✗ B');
    expect(report).toContain('fix: do this');
    expect(report).not.toContain('unused');
    expect(report).toContain('1 of 2 checks passed.');
  });

  it('prints a warning with its notes and fix, and counts it as passed', () => {
    const report = formatReport([
      { name: 'A', ok: true, detail: 'fine' },
      {
        name: 'B',
        ok: true,
        warn: true,
        detail: 'missing x',
        notes: ['x: does this'],
        fix: 'install x',
      },
    ]);
    expect(report).toContain('✓ A');
    expect(report).toContain('! B');
    expect(report).toContain('x: does this');
    expect(report).toContain('fix: install x');
    expect(report).toContain('2 of 2 checks passed (1 with a warning).');
  });
});

describe('resolvePort', () => {
  it('reads STUDIO_PORT, then config.json, then 4310, skipping what the engine would refuse', () => {
    expect(resolvePort({}, {})).toBe(4310);
    expect(resolvePort({}, { port: 5000 })).toBe(5000);
    expect(resolvePort({ STUDIO_PORT: '6000' }, { port: 5000 })).toBe(6000);
    expect(resolvePort({ STUDIO_PORT: '' }, { port: 5000 })).toBe(5000);
    expect(resolvePort({ STUDIO_PORT: 'abc' }, {})).toBe(4310);
    expect(resolvePort({ STUDIO_PORT: '70000' }, { port: 0 })).toBe(4310);
  });
});

describe('proxiesToEngine', () => {
  it.each([
    'http://127.0.0.1:4310',
    'http://localhost:4310/',
    '127.0.0.1:4310',
    '4310',
    'http://[::1]:4310',
  ])('is the engine: %s', (proxy) => {
    expect(proxiesToEngine(proxy, 4310)).toBe(true);
  });

  it.each([
    'http://127.0.0.1:3000',
    'http://127.0.0.1:4310/studio',
    'https+insecure://localhost:4310',
    'http://192.168.1.2:4310',
    '',
    undefined,
  ])('is not the engine: %s', (proxy) => {
    expect(proxiesToEngine(proxy, 4310)).toBe(false);
  });
});

describe('tailscaleServeCheck', () => {
  const MAC = 'studio-mac.tail1234.ts.net';
  const ran = (json: unknown) => ({ ok: true, stdout: JSON.stringify(json), stderr: '' });

  /** What `tailscale serve --bg 4310` leaves in `tailscale serve status --json` (1.104). */
  const served = (proxy = 'http://127.0.0.1:4310', hostPort = `${MAC}:443`) => ({
    TCP: { [hostPort.split(':')[1] as string]: { HTTPS: true } },
    Web: { [hostPort]: { Handlers: { '/': { Proxy: proxy } } } },
  });

  it('is green when https on 443 sends / to the engine', () => {
    expect(tailscaleServeCheck(ran(served()), 4310)).toEqual({
      name: 'Tailscale',
      ok: true,
      detail: `Serve: https://${MAC} → 127.0.0.1:4310`,
    });
  });

  it('warns, with the command as the fix, when Serve is off', () => {
    const check = tailscaleServeCheck({ ok: true, stdout: '{}\n', stderr: '' }, 4310);
    expect(check).toMatchObject({
      name: 'Tailscale',
      ok: true,
      warn: true,
      detail: "Serve is off: the phone can't reach the engine",
      fix: 'tailscale serve --bg 4310',
    });
  });

  it('says the CLI to type when `tailscale` is not on PATH', () => {
    const app = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    expect(tailscaleServeCheck(ran({}), 4310, app).fix).toBe(`${app} serve --bg 4310`);
  });

  it('is green, with a note, when https on 443 sends / to the Vite dev server (what the owner has today)', () => {
    // `tailscale serve --bg http://localhost:5173`, read back by Tailscale 1.104.
    const check = tailscaleServeCheck(ran(served('http://localhost:5173')), 4310);
    expect(check).toMatchObject({
      name: 'Tailscale',
      ok: true,
      detail: `Serve: https://${MAC} → 127.0.0.1:5173 (the dev server)`,
    });
    expect(check.warn).toBeUndefined();
    expect(check.fix).toBeUndefined();
    expect(check.notes?.join('\n')).toContain('pnpm dev');
    expect(check.notes?.join('\n')).toContain('tailscale serve --bg 4310');
    // Printed as a green line with the note under it, and no fix.
    const report = formatReport([check]);
    expect(report).toMatch(/^✓ Tailscale/m);
    expect(report).not.toContain('fix:');
  });

  it('takes the dev server at any loopback spelling, as it does the engine', () => {
    for (const proxy of ['http://127.0.0.1:5173', 'localhost:5173', '5173', 'http://[::1]:5173']) {
      const check = tailscaleServeCheck(ran(served(proxy)), 4310);
      expect(check.warn, proxy).toBeUndefined();
      expect(check.detail, proxy).toContain('the dev server');
    }
  });

  it('still warns for anything else on the dev port: another host, a path, https', () => {
    for (const proxy of [
      'http://192.168.1.2:5173',
      'http://127.0.0.1:5173/studio',
      'https+insecure://localhost:5173',
      'http://127.0.0.1:5174',
    ]) {
      expect(tailscaleServeCheck(ran(served(proxy)), 4310), proxy).toMatchObject({ warn: true });
    }
  });

  it('keeps the engine as the plain green line when both are served', () => {
    const both = {
      TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true } },
      Web: {
        [`${MAC}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4310' } } },
        [`${MAC}:8443`]: { Handlers: { '/': { Proxy: 'http://localhost:5173' } } },
      },
    };
    expect(tailscaleServeCheck(ran(both), 4310)).toEqual({
      name: 'Tailscale',
      ok: true,
      detail: `Serve: https://${MAC} → 127.0.0.1:4310`,
    });
  });

  it('warns when the dev server is served on a port other than 443, and when Terminal-only', () => {
    const on8443 = tailscaleServeCheck(ran(served('http://localhost:5173', `${MAC}:8443`)), 4310);
    expect(on8443).toMatchObject({ ok: true, warn: true, fix: 'tailscale serve --bg 4310' });
    expect(on8443.detail).toContain('not https on 443');

    const foreground = tailscaleServeCheck(
      ran({ Foreground: { abc: served('http://localhost:5173') } }),
      4310,
    );
    expect(foreground).toMatchObject({ ok: true, warn: true });
    expect(foreground.detail).toContain('only while');
  });

  it('is an error when Funnel is on for the dev server: it would open the app to the internet', () => {
    const check = tailscaleServeCheck(
      ran({ ...served('http://localhost:5173'), AllowFunnel: { [`${MAC}:443`]: true } }),
      4310,
    );
    expect(check).toMatchObject({
      name: 'Tailscale',
      ok: false,
      fix: 'tailscale funnel --https=443 off && tailscale serve --bg 4310',
    });
    expect(check.warn).toBeUndefined();
  });

  it('is an error when Funnel is on for the name that serves the engine', () => {
    const check = tailscaleServeCheck(
      ran({ ...served(), AllowFunnel: { [`${MAC}:443`]: true } }),
      4310,
    );
    expect(check).toMatchObject({
      name: 'Tailscale',
      ok: false,
      detail: `Funnel is on for ${MAC}:443: the engine is open to the whole internet`,
      fix: 'tailscale funnel --https=443 off && tailscale serve --bg 4310',
    });
    expect(check.warn).toBeUndefined();
  });

  it('is an error for Funnel in a foreground serve too, and not for Funnel on something else', () => {
    const foreground = {
      Foreground: { abc: { ...served(), AllowFunnel: { [`${MAC}:443`]: true } } },
    };
    expect(tailscaleServeCheck(ran(foreground), 4310).ok).toBe(false);

    const other = {
      ...served(),
      Web: {
        ...served().Web,
        [`${MAC}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } },
      },
      AllowFunnel: { [`${MAC}:8443`]: true },
    };
    expect(tailscaleServeCheck(ran(other), 4310)).toMatchObject({ ok: true });
    expect(tailscaleServeCheck(ran(other), 4310).warn).toBeUndefined();
  });

  it('warns when Serve runs only in a Terminal (no --bg)', () => {
    const check = tailscaleServeCheck(ran({ Foreground: { abc: served() } }), 4310);
    expect(check).toMatchObject({ ok: true, warn: true, fix: 'tailscale serve --bg 4310' });
    expect(check.detail).toContain('only while');
  });

  it('warns when Serve is on for something else, or for the engine on another port', () => {
    const elsewhere = tailscaleServeCheck(ran(served('http://127.0.0.1:3000')), 4310);
    expect(elsewhere).toMatchObject({ ok: true, warn: true });
    expect(elsewhere.detail).toBe('Serve is on, but not for the engine (127.0.0.1:4310)');

    const port8443 = tailscaleServeCheck(ran(served(undefined, `${MAC}:8443`)), 4310);
    expect(port8443).toMatchObject({ ok: true, warn: true });
    expect(port8443.detail).toContain('not https on 443');
  });

  it('checks the port the engine runs on', () => {
    expect(tailscaleServeCheck(ran(served('http://127.0.0.1:5000')), 5000).warn).toBeUndefined();
    expect(tailscaleServeCheck(ran(served('http://127.0.0.1:5000')), 4310).warn).toBe(true);
  });

  it('warns without failing when Tailscale is missing, not running or says something odd', () => {
    const missing = tailscaleServeCheck(null, 4310);
    expect(missing).toMatchObject({ ok: true, warn: true, detail: 'not installed' });
    expect(missing.fix).toContain('tailscale serve --bg 4310');

    const stopped = tailscaleServeCheck(
      { ok: false, stdout: '', stderr: 'failed to connect to local Tailscale service\n' },
      4310,
    );
    expect(stopped).toMatchObject({ ok: true, warn: true });
    expect(stopped.detail).toContain('failed to connect to local Tailscale service');

    for (const stdout of ['not json', 'null', '"text"']) {
      expect(tailscaleServeCheck({ ok: true, stdout, stderr: '' }, 4310)).toMatchObject({
        ok: true,
        warn: true,
      });
    }
  });

  it('is one of the checks the doctor runs, just before money.json', () => {
    // It reads this Mac's real Serve state (read only), so only its place is checked here.
    const names = runChecks(home, { PATH: '' }, '22.0.0').map((c) => c.name);
    expect(names.slice(-2)).toEqual(['Tailscale', 'money.json']);
  });
});

describe('Songs checks', () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 9, 25);
  const apifyKey = 'apify_api_SECRET_value_1234567890';

  /** An executable script in a temp folder; returns its path. */
  function fakeTool(name: string, script: string) {
    const path = join(home, 'tools', name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  /** yt-dlp's `--version` for a release `days` days before `now`: 2026.08.26. */
  const releaseDays = (days: number) =>
    new Date(now - days * DAY).toISOString().slice(0, 10).replaceAll('-', '.');

  const denoVersion = (version: string) =>
    `echo "deno ${version} (stable, release, aarch64-apple-darwin)"; echo "v8 14.0.365.5-rusty"`;

  /** yt-dlp that answers `--version`, and for anything else writes `stderr` and exits `code`. */
  function fakeYtDlp(options: { version?: string; stderr?: string; code?: number; log?: string }) {
    const log = options.log ? `printf '%s\\n' "$@" > "${options.log}"; ` : '';
    return fakeTool(
      'yt-dlp',
      `case "$*" in *--version*) echo ${options.version ?? releaseDays(3)};; *) ${log}cat <<'EOF' >&2\n${options.stderr ?? ''}\nEOF\nexit ${options.code ?? 0};; esac`,
    );
  }

  const never = () => null;

  function writeEnvFile(text: string) {
    const file = join(home, 'repo.env');
    writeFileSync(file, text);
    return file;
  }

  function writeEngineConfig(config: object) {
    mkdirSync(join(home, '.studio-engine'), { recursive: true });
    writeFileSync(join(home, '.studio-engine', 'config.json'), JSON.stringify(config));
  }

  describe('resolveSongs', () => {
    it('is on unless something says otherwise (U22), and needs music too', () => {
      expect(resolveSongs({}, {})).toEqual({ asked: false, music: true, on: true });
      expect(resolveSongs({ STUDIO_SONGS: '1' }, {})).toEqual({
        asked: true,
        music: true,
        on: true,
      });
      expect(resolveSongs({ STUDIO_SONGS: '1', STUDIO_MUSIC: '0' }, {})).toEqual({
        asked: true,
        music: false,
        on: false,
      });
      // Music turned off takes songs with it; with songs never written down that is nothing to say.
      expect(resolveSongs({ STUDIO_MUSIC: '0' }, {})).toEqual({
        asked: false,
        music: false,
        on: false,
      });
      expect(resolveSongs({ STUDIO_SONGS: '0' }, {})).toEqual({
        asked: false,
        music: true,
        on: false,
      });
      expect(resolveSongs({ STUDIO_SONGS: 'true', STUDIO_MUSIC: 'TRUE' }, {}).on).toBe(true);
    });

    it('takes "songs" and "music" in config.json, and lets the environment win', () => {
      expect(resolveSongs({}, { songs: true, music: true }).on).toBe(true);
      expect(resolveSongs({ STUDIO_SONGS: '0' }, { songs: true, music: true }).on).toBe(false);
      expect(resolveSongs({ STUDIO_MUSIC: 'false' }, { songs: true, music: true }).on).toBe(false);
      expect(resolveSongs({ STUDIO_SONGS: '1' }, { songs: false, music: true }).on).toBe(true);
      expect(resolveSongs({}, { songs: false }).on).toBe(false);
      expect(resolveSongs({}, { music: false }).on).toBe(false);
    });

    it('skips an empty or invalid value, as the engine would refuse it', () => {
      expect(
        resolveSongs({ STUDIO_SONGS: '', STUDIO_MUSIC: 'on' }, { songs: true, music: true }),
      ).toEqual({
        asked: true,
        music: true,
        on: true,
      });
      expect(resolveSongs({}, { songs: 'yes' as unknown as boolean })).toEqual({
        asked: false,
        music: true,
        on: true,
      });
    });

    it('gives the same answer as the engine for every valid setting', () => {
      const envs = [undefined, '', '1', '0', 'true', 'FALSE'];
      const files = [undefined, true, false];
      for (const songsEnv of envs) {
        for (const musicEnv of envs) {
          for (const songsFile of files) {
            for (const musicFile of files) {
              const config = {
                ...(songsFile === undefined ? {} : { songs: songsFile }),
                ...(musicFile === undefined ? {} : { music: musicFile }),
              };
              mkdirSync(join(home, '.studio-engine'), { recursive: true });
              writeFileSync(join(home, '.studio-engine', 'config.json'), JSON.stringify(config));
              const settings = { STUDIO_SONGS: songsEnv, STUDIO_MUSIC: musicEnv };
              const label = `${songsEnv} ${musicEnv} ${songsFile} ${musicFile}`;
              expect(resolveSongs(settings, config).on, label).toBe(
                loadConfig({ home, env: settings }).songs,
              );
            }
          }
        }
      }
    });
  });

  describe('resolveSongTools', () => {
    it('is Homebrew’s unless something says otherwise', () => {
      expect(resolveSongTools(home, {})).toEqual({
        ytDlp: '/opt/homebrew/bin/yt-dlp',
        deno: '/opt/homebrew/bin/deno',
      });
    });

    it('takes STUDIO_YT_DLP and STUDIO_DENO, expands ~, and skips an empty or relative one', () => {
      expect(
        resolveSongTools(home, {
          STUDIO_YT_DLP: '/usr/local/bin/yt-dlp',
          STUDIO_DENO: '~/bin/deno',
        }),
      ).toEqual({ ytDlp: '/usr/local/bin/yt-dlp', deno: join(home, 'bin/deno') });
      expect(resolveSongTools(home, { STUDIO_YT_DLP: '', STUDIO_DENO: 'deno' })).toEqual({
        ytDlp: '/opt/homebrew/bin/yt-dlp',
        deno: '/opt/homebrew/bin/deno',
      });
    });

    it('gives the same answer as the engine', () => {
      for (const env of [
        {},
        { STUDIO_YT_DLP: '/x/yt-dlp' },
        { STUDIO_DENO: '~/y/deno' },
        { STUDIO_YT_DLP: '/x/yt-dlp', STUDIO_DENO: '/y/deno' },
      ]) {
        expect(resolveSongTools(home, env)).toEqual(loadConfig({ home, env }).songTools);
      }
    });
  });

  describe('checkYtDlp', () => {
    it('passes with a recent release, and runs it without the user’s yt-dlp config', () => {
      const log = join(home, 'args.txt');
      const ytDlp = fakeTool('yt-dlp', `printf '%s\\n' "$@" > "${log}"; echo ${releaseDays(3)}`);
      const check = checkYtDlp(ytDlp, {}, home, now);
      expect(check).toMatchObject({ name: 'yt-dlp', ok: true });
      expect(check.warn).toBeUndefined();
      expect(check.detail).toBe(`${releaseDays(3)} (3 days old) · ~/tools/yt-dlp`);
      expect(readFileSync(log, 'utf8')).toBe('--ignore-config\n--version\n');
    });

    it(`warns, without failing, when it is more than ${YT_DLP_MAX_AGE_DAYS} days old`, () => {
      const exactly = checkYtDlp(fakeYtDlp({ version: releaseDays(60) }), {}, home, now);
      expect(exactly.warn).toBeUndefined();
      const old = checkYtDlp(fakeYtDlp({ version: releaseDays(61) }), {}, home, now);
      expect(old).toMatchObject({
        name: 'yt-dlp',
        ok: true,
        warn: true,
        fix: 'Run brew upgrade yt-dlp',
      });
      expect(old.detail).toContain('yt-dlp is 61 days old');
      expect(formatReport([old])).toContain('fix: Run brew upgrade yt-dlp');
    });

    it('takes a nightly version (a date and a time) as a date', () => {
      const check = checkYtDlp(fakeYtDlp({ version: `${releaseDays(2)}.232954` }), {}, home, now);
      expect(check).toMatchObject({ ok: true });
      expect(check.detail).toContain('2 days old');
    });

    it('fails with the install line when it is not there', () => {
      const check = checkYtDlp(join(home, 'nope/yt-dlp'), {}, home, now, never);
      expect(check).toMatchObject({
        name: 'yt-dlp',
        ok: false,
        detail: `not found: ${tilde(join(home, 'nope/yt-dlp'), home)}`,
        fix: 'Run brew install yt-dlp deno',
      });
    });

    it('says where it is when it is installed, but not where the engine looks', () => {
      const check = checkYtDlp(
        '/opt/homebrew/bin/yt-dlp-nope',
        {},
        home,
        now,
        () => '/usr/local/bin/yt-dlp',
      );
      expect(check).toMatchObject({ ok: false });
      expect(check.detail).toContain('found at /usr/local/bin/yt-dlp');
      expect(check.fix).toContain('STUDIO_YT_DLP=/usr/local/bin/yt-dlp');
    });

    it('fails when it does not run or does not print a date', () => {
      const broken = checkYtDlp(
        fakeTool('broken', 'echo "bad interpreter" >&2; exit 1'),
        {},
        home,
        now,
      );
      expect(broken).toMatchObject({ ok: false });
      expect(broken.detail).toContain('`yt-dlp --version` failed: bad interpreter');
      const odd = checkYtDlp(fakeYtDlp({ version: 'hello' }), {}, home, now);
      expect(odd).toMatchObject({ ok: false });
      expect(odd.detail).toContain('printed "hello", which is not a date');
    });
  });

  describe('checkDeno', () => {
    it('passes for 2.3 or newer', () => {
      expect(DENO_MIN_VERSION).toEqual([2, 3]);
      for (const version of ['2.3.0', '2.5.4', '3.0.1']) {
        const check = checkDeno(fakeTool('deno', denoVersion(version)), home);
        expect(check, version).toMatchObject({
          name: 'deno',
          ok: true,
          detail: `deno ${version} · ~/tools/deno`,
        });
        expect(check.warn).toBeUndefined();
      }
    });

    it('fails for anything older, with the upgrade line', () => {
      for (const version of ['2.2.9', '2.0.0', '1.46.3']) {
        const check = checkDeno(fakeTool('deno', denoVersion(version)), home);
        expect(check, version).toMatchObject({ ok: false, fix: 'Run brew upgrade deno' });
        expect(check.detail).toContain(`deno ${version} is too old: 2.3 or newer is needed`);
      }
    });

    it('fails with the install line when it is not there', () => {
      expect(checkDeno(join(home, 'nope/deno'), home)).toMatchObject({
        name: 'deno',
        ok: false,
        fix: 'Run brew install yt-dlp deno',
      });
    });

    it('fails when it does not run or does not print a version', () => {
      expect(checkDeno(fakeTool('deno', 'echo boom >&2; exit 1'), home)).toMatchObject({
        ok: false,
      });
      expect(checkDeno(fakeTool('deno', 'echo hello'), home).detail).toContain(
        'printed "hello", which is not a version',
      );
    });
  });

  describe('checkSongFfmpeg', () => {
    it('runs the ffmpeg the song getter finds', () => {
      const ffmpeg = fakeTool(
        'ffmpeg',
        'echo "ffmpeg version 8.0 Copyright (c) 2000-2026 the FFmpeg developers"',
      );
      const check = checkSongFfmpeg({ MUSIC_FFMPEG: ffmpeg }, home);
      expect(check).toEqual({
        name: 'ffmpeg for songs',
        ok: true,
        detail: 'ffmpeg version 8.0 · ~/tools/ffmpeg',
      });
    });

    it('fails with the install line when the getter would not find one', () => {
      expect(checkSongFfmpeg({}, home, never)).toEqual({
        name: 'ffmpeg for songs',
        ok: false,
        detail: 'not found',
        fix: 'Run brew install ffmpeg',
      });
    });

    it('fails when the one it finds does not run', () => {
      const ffmpeg = fakeTool('ffmpeg', 'exit 1');
      expect(checkSongFfmpeg({ MUSIC_FFMPEG: ffmpeg }, home)).toMatchObject({
        ok: false,
        fix: 'Run brew install ffmpeg',
      });
    });
  });

  describe('checkApifyKey', () => {
    it('passes when .env has the key, and never prints it', () => {
      const check = checkApifyKey(
        {},
        writeEnvFile(`ANTHROPIC_API_KEY=\nAPIFY_TOKEN=${apifyKey}\n`),
      );
      expect(check).toEqual({ name: 'Apify key', ok: true, detail: 'set in .env' });
      expect(JSON.stringify(check)).not.toContain(apifyKey);
    });

    it('warns, with the sentence and the fix, when there is no key', () => {
      for (const text of ['', 'APIFY_TOKEN=\n', 'ANTHROPIC_API_KEY=x\n']) {
        const check = checkApifyKey({}, writeEnvFile(text));
        expect(check).toMatchObject({
          name: 'Apify key',
          ok: true,
          warn: true,
          detail: 'not set in .env',
        });
        expect(check.notes?.join(' ')).toContain('Reel links and trending songs need an Apify key');
        expect(check.fix).toContain('add APIFY_TOKEN to .env');
      }
      expect(checkApifyKey({}, join(home, 'no-such-file')).warn).toBe(true);
    });

    it('does not count a key that is only in the shell: the engine reads .env', () => {
      const check = checkApifyKey({ APIFY_TOKEN: apifyKey }, writeEnvFile(''));
      expect(check).toMatchObject({ ok: true, warn: true });
      expect(check.detail).toContain("only in this shell's environment");
      expect(JSON.stringify(check)).not.toContain(apifyKey);
    });
  });

  describe('denoChallengeState', () => {
    it('reads the provider line yt-dlp prints with -v', () => {
      const line = (providers: string) =>
        `[debug] [youtube] [jsc] JS Challenge Providers: ${providers}`;
      expect(
        denoChallengeState(
          line('bun (unavailable), deno, node (unavailable), quickjs (unavailable)'),
        ),
      ).toBe('available');
      expect(denoChallengeState(line('bun (unavailable), deno (unavailable), node'))).toBe(
        'unavailable',
      );
      expect(denoChallengeState(line('deno 2.5.4 (external)'))).toBe('available');
      expect(denoChallengeState(line('deno 2.5.4 (external, unavailable), node'))).toBe(
        'unavailable',
      );
      expect(denoChallengeState(line('bun, node'))).toBe('not listed');
      expect(denoChallengeState(line('none'))).toBe('not listed');
      expect(
        denoChallengeState('[debug] yt-dlp version 2025.06.01\n[youtube] Extracting URL'),
      ).toBe('no line');
      expect(denoChallengeState('')).toBe('no line');
    });
  });

  describe('checkYouTube', () => {
    const goodLine =
      '[debug] [youtube] [jsc] JS Challenge Providers: bun (unavailable), deno, node (unavailable), quickjs (unavailable)';
    const badLine =
      '[debug] [youtube] [jsc] JS Challenge Providers: bun (unavailable), deno (unavailable), node (unavailable)';

    function tools(ytDlp: string) {
      return { ytDlp, deno: fakeTool('deno', denoVersion('2.5.4')) };
    }

    it('passes when the simulated download works and deno is listed', async () => {
      const ytDlp = fakeYtDlp({
        stderr: `[debug] yt-dlp version\n${goodLine}\n[youtube] Extracting URL`,
        code: 0,
      });
      const check = await checkYouTube(tools(ytDlp), {});
      expect(check).toMatchObject({ name: 'YouTube', ok: true });
      expect(check.warn).toBeUndefined();
    });

    it('simulates (nothing is downloaded), the way the engine runs yt-dlp', async () => {
      const log = join(home, 'args.txt');
      const t = tools(fakeYtDlp({ stderr: goodLine, log }));
      await checkYouTube(t, {});
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
        '--ignore-config',
        '-v',
        '-s',
        '--no-playlist',
        '--js-runtimes',
        `deno:${t.deno}`,
        YOUTUBE_TEST_URL,
      ]);
    });

    it('keeps keys out of the yt-dlp process', async () => {
      const log = join(home, 'env.txt');
      const ytDlp = fakeTool(
        'yt-dlp',
        `case "$*" in *--version*) echo ${releaseDays(1)};; *) echo "key=[$APIFY_TOKEN][$ELEVENLABS_API_KEY] home=[$HOME]" > "${log}"; echo "${goodLine}" >&2;; esac`,
      );
      await checkYouTube(tools(ytDlp), {
        APIFY_TOKEN: apifyKey,
        ELEVENLABS_API_KEY: 'sk_x',
        HOME: '/h',
      });
      expect(readFileSync(log, 'utf8').trim()).toBe('key=[][] home=[/h]');
    });

    it('fails when yt-dlp says deno is unavailable, even though the video answered', async () => {
      const check = await checkYouTube(tools(fakeYtDlp({ stderr: badLine })), {});
      expect(check).toMatchObject({ ok: false, fix: 'Run brew upgrade yt-dlp deno' });
      expect(check.detail).toContain('deno as unavailable');
    });

    it('warns when yt-dlp does not list deno at all (an old yt-dlp)', async () => {
      const check = await checkYouTube(
        tools(fakeYtDlp({ stderr: '[debug] yt-dlp version 2025.06.01' })),
        {},
      );
      expect(check).toMatchObject({ ok: true, warn: true, fix: 'Run brew upgrade yt-dlp' });
    });

    it('maps the strings that mean yt-dlp needs updating to an error with the upgrade line', async () => {
      for (const stderr of [
        'ERROR: [youtube] jNQXAC9IVRw: n challenge solving failed: Some formats may be missing.',
        'WARNING: [youtube] No supported JavaScript runtime could be found.\nERROR: [youtube] jNQXAC9IVRw: Sign in required',
        'ERROR: [youtube] jNQXAC9IVRw: Requested format is not available. Use --list-formats for a list of available formats',
      ]) {
        const check = await checkYouTube(
          tools(fakeYtDlp({ stderr: `${goodLine}\n${stderr}`, code: 1 })),
          {},
        );
        expect(check, stderr).toMatchObject({
          name: 'YouTube',
          ok: false,
          fix: 'Run brew upgrade yt-dlp',
        });
        expect(check.detail).toContain('yt-dlp is too old to read it');
        expect(check.detail).not.toContain('then ask again');
      }
    });

    it('blames deno, not yt-dlp’s age, when the error is about the runtime and deno is unavailable', async () => {
      const stderr = `${badLine}\nWARNING: [youtube] No supported JavaScript runtime could be found.\nERROR: Requested format is not available`;
      const check = await checkYouTube(tools(fakeYtDlp({ stderr, code: 1 })), {});
      expect(check).toMatchObject({ ok: false, fix: 'Run brew upgrade yt-dlp deno' });
      expect(check.detail).toContain('cannot use deno');
    });

    it('maps the strings that mean YouTube is refusing this Mac to an error', async () => {
      for (const stderr of [
        "ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you're not a bot. Use --cookies-from-browser",
        'ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you’re not a bot',
        'ERROR: [youtube] Your IP is likely being blocked by Youtube',
      ]) {
        const check = await checkYouTube(
          tools(fakeYtDlp({ stderr: `${goodLine}\n${stderr}`, code: 1 })),
          {},
        );
        expect(check, stderr).toMatchObject({
          ok: false,
          fix: 'Wait a while, then run pnpm run doctor again',
        });
        expect(check.detail).toContain('refusing requests from this Mac');
      }
    });

    it('only warns, in plain words, when YouTube answers HTTP 429: too many requests, gone in a while', async () => {
      for (const stderr of [
        'ERROR: [youtube] jNQXAC9IVRw: Unable to download API page: HTTP Error 429: Too Many Requests',
        'ERROR: [youtube] jNQXAC9IVRw: HTTP Error 429: Too Many Requests (caused by <HTTPError 429: Too Many Requests>)',
      ]) {
        const check = await checkYouTube(
          tools(fakeYtDlp({ stderr: `${goodLine}\n${stderr}`, code: 1 })),
          {},
        );
        expect(check, stderr).toMatchObject({
          name: 'YouTube',
          ok: true,
          warn: true,
          fix: 'Run pnpm run doctor again later',
        });
        expect(check.detail).toContain('too many requests (HTTP 429)');
        expect(check.detail).toContain('not a problem with yt-dlp or deno');
        expect(check.notes?.join(' ')).toContain('Nothing to install or fix');
      }
    });

    it('only warns when YouTube cannot be reached', async () => {
      const stderr =
        'ERROR: [youtube] jNQXAC9IVRw: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided, or not known>';
      const check = await checkYouTube(tools(fakeYtDlp({ stderr, code: 1 })), {});
      expect(check).toMatchObject({ ok: true, warn: true });
      expect(check.detail).toContain('not checked: ');
      expect(check.detail).toContain('Check the internet connection');
    });

    it('only warns when yt-dlp takes too long, and stops it', async () => {
      const ytDlp = fakeTool('yt-dlp', 'exec sleep 30');
      const started = Date.now();
      const check = await checkYouTube(tools(ytDlp), {}, 150);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(check).toMatchObject({
        ok: true,
        warn: true,
        detail: "not checked: YouTube didn't answer within 150 ms",
      });
    });

    it('fails with the last thing yt-dlp said for a complaint it does not know', async () => {
      const check = await checkYouTube(
        tools(fakeYtDlp({ stderr: 'ERROR: something odd happened', code: 1 })),
        {},
      );
      expect(check).toMatchObject({ ok: false });
      expect(check.detail).toContain('something odd happened');
    });

    it('is a warning, without running anything, when yt-dlp or deno is missing', async () => {
      const calls = join(home, 'ran.txt');
      const ytDlp = fakeTool('yt-dlp', `echo ran > "${calls}"`);
      for (const t of [
        { ytDlp: join(home, 'nope/yt-dlp'), deno: fakeTool('deno', denoVersion('2.5.4')) },
        { ytDlp, deno: join(home, 'nope/deno') },
      ]) {
        const check = await checkYouTube(t, {});
        expect(check).toMatchObject({ ok: true, warn: true });
        expect(check.detail).toContain('yt-dlp or deno is missing');
      }
      expect(() => readFileSync(calls)).toThrow();
    });

    it('fails when yt-dlp cannot start', () => {
      const check = youtubeCheck(
        { code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'spawn EACCES' },
        1000,
      );
      expect(check).toMatchObject({ ok: false, detail: 'yt-dlp could not start: spawn EACCES' });
    });

    it('never puts a URL in what it says', async () => {
      const stderr = `ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you're not a bot ${YOUTUBE_TEST_URL}`;
      const check = await checkYouTube(tools(fakeYtDlp({ stderr, code: 1 })), {});
      expect(formatReport([check])).not.toContain('http');
    });
  });

  describe('checkApify', () => {
    const planAnswer = {
      data: { plan: { id: 'FREE', description: 'Free', monthlyUsageCreditsUsd: 5 } },
    };
    const limitsAnswer = (used: number) => ({
      data: {
        monthlyUsageCycle: {
          startAt: '2026-10-01T00:00:00.000Z',
          endAt: '2026-11-01T00:00:00.000Z',
        },
        limits: { maxMonthlyUsageUsd: 5 },
        current: { monthlyUsageUsd: used },
      },
    });

    /** A fetch that answers by path, and remembers what it was asked. */
    function apifyFetch(answers: Record<string, { status: number; body?: unknown } | 'offline'>) {
      const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
      const fetchImpl: FetchLike = async (url, init) => {
        calls.push({ url, init });
        const answer = answers[new URL(url).pathname];
        if (answer === undefined || answer === 'offline') throw new TypeError('fetch failed');
        return { status: answer.status, text: async () => JSON.stringify(answer.body ?? {}) };
      };
      return { calls, fetchImpl };
    }

    const withKey = () => writeEnvFile(`APIFY_TOKEN=${apifyKey}\n`);

    function expectNoKey(check: object) {
      expect(JSON.stringify(check)).not.toContain(apifyKey);
      expect(formatReport([check as never])).not.toContain(apifyKey);
    }

    it('passes, and shows the credit left, with the key only in the Authorization header', async () => {
      const { calls, fetchImpl } = apifyFetch({
        '/v2/users/me': { status: 200, body: planAnswer },
        '/v2/users/me/limits': { status: 200, body: limitsAnswer(0.8) },
      });
      const check = await checkApify({}, withKey(), fetchImpl);
      expect(check).toEqual({
        name: 'Apify',
        ok: true,
        detail: 'the key works · Free · $4.20 of $5.00 monthly credit left',
      });
      expect(calls.map((c) => c.url)).toEqual([
        'https://api.apify.com/v2/users/me',
        'https://api.apify.com/v2/users/me/limits',
      ]);
      for (const call of calls) {
        expect(call.init.method).toBe('GET');
        expect(call.init.headers.authorization).toBe(`Bearer ${apifyKey}`);
        expect(call.init.body).toBeUndefined();
        expect(call.url).not.toContain(apifyKey);
      }
      expectNoKey(check);
    });

    it('uses the environment’s key when .env has none, as the getter does', async () => {
      const { calls, fetchImpl } = apifyFetch({
        '/v2/users/me': { status: 200, body: planAnswer },
      });
      await checkApify({ APIFY_TOKEN: apifyKey }, writeEnvFile(''), fetchImpl);
      expect(calls[0]?.init.headers.authorization).toBe(`Bearer ${apifyKey}`);
    });

    it(`warns when less than $${APIFY_LOW_CREDIT_USD} of the credit is left, and says when it renews`, async () => {
      for (const used of [4.5, 5, 7]) {
        const { fetchImpl } = apifyFetch({
          '/v2/users/me': { status: 200, body: planAnswer },
          '/v2/users/me/limits': { status: 200, body: limitsAnswer(used) },
        });
        const check = await checkApify({}, withKey(), fetchImpl);
        expect(check, `${used}`).toMatchObject({ ok: true, warn: true });
        expect(check.detail).toContain(`of $5.00 monthly credit left`);
        expect(check.fix).toContain('renews on 2026-11-01');
      }
    });

    it('still passes when only the usage cannot be read', async () => {
      for (const limits of ['offline', { status: 500 }] as const) {
        const { fetchImpl } = apifyFetch({
          '/v2/users/me': { status: 200, body: planAnswer },
          '/v2/users/me/limits': limits,
        });
        const check = await checkApify({}, withKey(), fetchImpl);
        expect(check).toMatchObject({
          ok: true,
          detail: 'the key works · Free · $5.00 monthly credit (usage not read)',
        });
        expect(check.warn).toBeUndefined();
      }
    });

    it('still passes when the answer has no plan', async () => {
      const { fetchImpl } = apifyFetch({
        '/v2/users/me': { status: 200, body: { data: { id: 'x' } } },
      });
      expect(await checkApify({}, withKey(), fetchImpl)).toMatchObject({
        ok: true,
        detail: 'the key works · plan not shown',
      });
    });

    it('fails with the fix when Apify says the key is not valid', async () => {
      const { fetchImpl } = apifyFetch({
        '/v2/users/me': {
          status: 401,
          body: { error: { type: 'invalid-token', message: `bad ${apifyKey}` } },
        },
      });
      const check = await checkApify({}, withKey(), fetchImpl);
      expect(check).toMatchObject({
        name: 'Apify',
        ok: false,
        detail: 'Apify says the key in .env is not valid',
      });
      expect(check.fix).toContain('APIFY_TOKEN=');
      expectNoKey(check);
    });

    it('only warns when Apify cannot be reached, takes too long, is busy, down or says no to the lookup', async () => {
      const slow: FetchLike = (_url, init) =>
        new Promise((_done, fail) => {
          init.signal.addEventListener('abort', () => fail(init.signal.reason));
        });
      const checks = [
        await checkApify({}, withKey(), apifyFetch({}).fetchImpl),
        await checkApify({}, withKey(), slow, 50),
        await checkApify({}, withKey(), apifyFetch({ '/v2/users/me': { status: 429 } }).fetchImpl),
        await checkApify({}, withKey(), apifyFetch({ '/v2/users/me': { status: 503 } }).fetchImpl),
        await checkApify({}, withKey(), apifyFetch({ '/v2/users/me': { status: 403 } }).fetchImpl),
        await checkApify({}, withKey(), apifyFetch({ '/v2/users/me': { status: 418 } }).fetchImpl),
      ];
      for (const check of checks) {
        expect(check).toMatchObject({ name: 'Apify', ok: true, warn: true });
        expectNoKey(check);
      }
      expect(checks.map((check) => check.detail)).toEqual([
        "not checked: Apify can't be reached (offline?)",
        "not checked: Apify didn't answer within 50 ms",
        'not checked: Apify is busy (429); try again in a minute',
        'not checked: Apify is down (503)',
        'not checked: Apify refused the account lookup (403); the key may still run the scrapers',
        'not checked: Apify answered 418',
      ]);
    });

    it('only warns, without calling anyone, when there is no key', async () => {
      const { calls, fetchImpl } = apifyFetch({ '/v2/users/me': { status: 200 } });
      const check = await checkApify({}, writeEnvFile(''), fetchImpl);
      expect(check).toMatchObject({
        ok: true,
        warn: true,
        detail: 'not checked: there is no key (see Apify key)',
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe('in the doctor’s list', () => {
    const songsOn = (extra: NodeJS.ProcessEnv = {}) => ({
      PATH: '',
      STUDIO_SONGS: '1',
      STUDIO_MUSIC: '1',
      STUDIO_YT_DLP: fakeYtDlp({ stderr: '[debug] [youtube] [jsc] JS Challenge Providers: deno' }),
      STUDIO_DENO: fakeTool('deno', denoVersion('2.5.4')),
      ...extra,
    });

    it('adds nothing, and calls nobody, while songs is off (STUDIO_SONGS=0 or STUDIO_MUSIC=0)', async () => {
      const calls: string[] = [];
      const fetchImpl: FetchLike = async (url) => {
        calls.push(url);
        return { status: 200, text: async () => '{}' };
      };
      const envFile = writeEnvFile(`APIFY_TOKEN=${apifyKey}\n`);
      const withoutSongs = (
        await runAllChecks(home, { PATH: '', STUDIO_SONGS: '0' }, '22.0.0', fetchImpl, envFile)
      ).map((c) => c.name);
      for (const env of [
        { PATH: '', STUDIO_SONGS: '0', STUDIO_MUSIC: '1' },
        { PATH: '', STUDIO_MUSIC: '0' },
        { PATH: '', STUDIO_MUSIC: '0', STUDIO_SONGS: '0' },
      ]) {
        expect(
          (await runAllChecks(home, env, '22.0.0', fetchImpl, envFile)).map((c) => c.name),
        ).toEqual(withoutSongs);
      }
      for (const name of [
        'Songs',
        'yt-dlp',
        'deno',
        'ffmpeg for songs',
        'Apify key',
        'YouTube',
        'Apify',
      ]) {
        expect(withoutSongs).not.toContain(name);
      }
      expect(calls.every((url) => url.startsWith('https://api.elevenlabs.io'))).toBe(true);
      expect(songChecks(home, { PATH: '', STUDIO_SONGS: '0' }, {}, envFile)).toEqual([]);
      // Music turned off alone takes songs with it, without a word: songs was never asked for.
      expect(songChecks(home, { PATH: '', STUDIO_MUSIC: '0' }, {}, envFile)).toEqual([]);
    });

    it('runs the song checks with nothing set, because songs is on by default (U22)', () => {
      const names = songChecks(home, { PATH: '' }, {}, writeEnvFile('')).map((c) => c.name);
      expect(names).toEqual(['yt-dlp', 'deno', 'ffmpeg for songs', 'Apify key']);
    });

    it('adds the song checks right after the ElevenLabs ones, and the network ones after the Apify key', async () => {
      const calls: string[] = [];
      const fetchImpl: FetchLike = async (url) => {
        calls.push(url);
        return {
          status: 200,
          text: async () => JSON.stringify({ data: { plan: { monthlyUsageCreditsUsd: 5 } } }),
        };
      };
      const envFile = writeEnvFile(`APIFY_TOKEN=${apifyKey}\n`);
      const checks = await runAllChecks(home, songsOn(), '22.0.0', fetchImpl, envFile);
      const names = checks.map((c) => c.name);
      expect(names.slice(names.indexOf('ElevenLabs key'))).toEqual([
        'ElevenLabs key',
        'ElevenLabs music',
        'ElevenLabs voice and sound effects',
        'Higgsfield connector',
        'yt-dlp',
        'deno',
        'ffmpeg for songs',
        'Apify key',
        'YouTube',
        'Apify',
        'Tailscale',
        'money.json',
      ]);
      expect(checks.find((c) => c.name === 'yt-dlp')).toMatchObject({ ok: true });
      expect(checks.find((c) => c.name === 'deno')).toMatchObject({ ok: true });
      expect(checks.find((c) => c.name === 'Apify key')).toMatchObject({
        ok: true,
        detail: 'set in .env',
      });
      expect(checks.find((c) => c.name === 'YouTube')).toMatchObject({ ok: true });
      expect(checks.find((c) => c.name === 'Apify')).toMatchObject({ ok: true });
      expect(calls.filter((url) => url.startsWith('https://api.apify.com/'))).toEqual([
        'https://api.apify.com/v2/users/me',
        'https://api.apify.com/v2/users/me/limits',
      ]);
      expect(JSON.stringify(checks)).not.toContain(apifyKey);
    });

    it('prints the install lines when the tools are missing, and fails the doctor', async () => {
      const env = songsOn({
        STUDIO_YT_DLP: join(home, 'none/yt-dlp'),
        STUDIO_DENO: join(home, 'none/deno'),
      });
      const checks = await runAllChecks(
        home,
        env,
        '22.0.0',
        async () => ({ status: 200, text: async () => '{}' }),
        writeEnvFile(''),
      );
      const report = formatReport(checks);
      expect(report).toContain('✗ yt-dlp');
      expect(report).toContain('✗ deno');
      expect(report).toContain('fix: Run brew install yt-dlp deno');
      expect(report).toContain('! Apify key');
      expect(report).toContain('Reel links and trending songs need an Apify key');
      expect(report).toContain('! YouTube');
      expect(report).toContain('! Apify ');
      expect(checks.every((c) => c.ok)).toBe(false);
    });

    it('turns on from config.json too', () => {
      writeEngineConfig({ songs: true, music: true });
      const names = songChecks(
        home,
        { PATH: '' },
        { songs: true, music: true },
        writeEnvFile(''),
      ).map((c) => c.name);
      expect(names).toEqual(['yt-dlp', 'deno', 'ffmpeg for songs', 'Apify key']);
      const listed = runChecks(home, { PATH: '' }, '22.0.0', writeEnvFile('')).map((c) => c.name);
      expect(listed).toContain('yt-dlp');
    });

    it('says so, with one line, when songs is asked for by name and music is turned off', () => {
      const checks = songChecks(
        home,
        { PATH: '', STUDIO_SONGS: '1', STUDIO_MUSIC: '0' },
        {},
        writeEnvFile(''),
      );
      expect(checks).toEqual([songsNeedMusicCheck()]);
      expect(checks[0]).toMatchObject({ name: 'Songs', ok: true, warn: true });
      expect(checks[0]?.fix).toContain('STUDIO_MUSIC=0');
    });

    it('never runs a network check for the songs it did not ask for', async () => {
      const calls: string[] = [];
      const fetchImpl: FetchLike = async (url) => {
        calls.push(url);
        return { status: 200, text: async () => '{}' };
      };
      await runAllChecks(
        home,
        { PATH: '', STUDIO_SONGS: '1', STUDIO_MUSIC: '0' },
        '22.0.0',
        fetchImpl,
        writeEnvFile(`APIFY_TOKEN=${apifyKey}\n`),
      );
      expect(calls.some((url) => url.includes('apify'))).toBe(false);
    });
  });

  describe('Stock media', () => {
    const unsplashKey = 'unsplash_ACCESS_secret_value_123456';
    const openverseId = 'openverse-client-id-value-123';
    const openverseSecret = 'openverse-client-secret-value-456';

    /** A fetch that answers by host and path, and remembers what it was asked. */
    function stockFetch(answers: Record<string, number | 'offline'>) {
      const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
      const fetchImpl: FetchLike = async (url, init) => {
        calls.push({ url, init });
        const parsed = new URL(url);
        const answer = answers[`${parsed.host}${parsed.pathname}`];
        if (answer === undefined || answer === 'offline') throw new TypeError('fetch failed');
        return { status: answer, text: async () => '{}' };
      };
      return { calls, fetchImpl };
    }
    const noKeys = () => writeEnvFile('');
    const bothOpenverse = () =>
      writeEnvFile(
        `OPENVERSE_CLIENT_ID=${openverseId}\nOPENVERSE_CLIENT_SECRET=${openverseSecret}\n`,
      );
    const noSecrets = (check: object) => {
      const text = JSON.stringify(check) + formatReport([check as never]);
      for (const secret of [unsplashKey, openverseId, openverseSecret]) {
        expect(text).not.toContain(secret);
      }
    };

    describe('resolveStock', () => {
      it('is off unless STUDIO_STOCK or config.json says on, and the environment wins', () => {
        expect(resolveStock({}, {})).toBe(false);
        expect(resolveStock({}, { stock: true })).toBe(true);
        expect(resolveStock({ STUDIO_STOCK: '1' }, {})).toBe(true);
        expect(resolveStock({ STUDIO_STOCK: '0' }, { stock: true })).toBe(false);
        expect(resolveStock({ STUDIO_STOCK: 'maybe' }, { stock: true })).toBe(true);
      });
    });

    describe('checkOpenverse', () => {
      it('passes when the client id and secret give a token, with neither printed', async () => {
        const { calls, fetchImpl } = stockFetch({ 'api.openverse.org/v1/auth_tokens/token/': 200 });
        const check = await checkOpenverse(bothOpenverse(), fetchImpl);
        expect(check).toEqual({
          name: 'Openverse sound effects',
          ok: true,
          detail: 'the client id and secret in .env give a token',
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.init.method).toBe('POST');
        noSecrets(check);
      });

      it('fails, with the fix, when Openverse refuses the pair', async () => {
        for (const status of [400, 401, 403]) {
          const { fetchImpl } = stockFetch({ 'api.openverse.org/v1/auth_tokens/token/': status });
          const check = await checkOpenverse(bothOpenverse(), fetchImpl);
          expect(check).toMatchObject({ ok: false });
          expect(check.fix).toContain('OPENVERSE_CLIENT_ID');
          noSecrets(check);
        }
      });

      it('warns, and says how to register, when there are no keys but searches work', async () => {
        const { calls, fetchImpl } = stockFetch({ 'api.openverse.org/v1/audio/': 200 });
        const check = await checkOpenverse(noKeys(), fetchImpl);
        expect(check).toMatchObject({ name: 'Openverse sound effects', ok: true, warn: true });
        expect(check.detail).toContain('anonymously');
        expect(check.fix).toContain('Register-and-Authenticate');
        expect(calls[0]?.init.method).toBe('GET');
        expect(new URL(calls[0]?.url ?? '').searchParams.get('source')).toBe('freesound');
      });

      it('warns, and does not fail, when only one half of the pair is there', async () => {
        const { fetchImpl } = stockFetch({ 'api.openverse.org/v1/audio/': 200 });
        const check = await checkOpenverse(
          writeEnvFile(`OPENVERSE_CLIENT_ID=${openverseId}\n`),
          fetchImpl,
        );
        expect(check).toMatchObject({ ok: true, warn: true });
        noSecrets(check);
      });

      it('only warns when Openverse is busy, down, odd or not reachable (with the pair)', async () => {
        for (const answer of [429, 503, 418, 'offline'] as const) {
          const { fetchImpl } = stockFetch({ 'api.openverse.org/v1/auth_tokens/token/': answer });
          const check = await checkOpenverse(bothOpenverse(), fetchImpl);
          expect(check.ok, `${answer}`).toBe(true);
          expect(check.warn, `${answer}`).toBe(true);
          expect(check.detail, `${answer}`).toContain('not checked');
          noSecrets(check);
        }
      });

      it('only warns when Openverse is down, odd or not reachable (anonymous)', async () => {
        for (const answer of [503, 418, 'offline'] as const) {
          const { fetchImpl } = stockFetch({ 'api.openverse.org/v1/audio/': answer });
          const check = await checkOpenverse(noKeys(), fetchImpl);
          expect(check.ok, `${answer}`).toBe(true);
          expect(check.warn, `${answer}`).toBe(true);
          expect(check.detail, `${answer}`).toContain('not checked');
        }
      });
    });

    describe('checkUnsplash', () => {
      const withKey = () => writeEnvFile(`UNSPLASH_ACCESS_KEY=${unsplashKey}\n`);

      it('passes when the key can search, sending it only in the Authorization header', async () => {
        const { calls, fetchImpl } = stockFetch({ 'api.unsplash.com/search/photos': 200 });
        const check = await checkUnsplash({}, withKey(), fetchImpl);
        expect(check).toEqual({
          name: 'Unsplash photos',
          ok: true,
          detail: 'the access key can search photos',
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).not.toContain(unsplashKey);
        expect(calls[0]?.init.headers.authorization).toBe(`Client-ID ${unsplashKey}`);
        noSecrets(check);
      });

      it('fails, with the fix, when Unsplash refuses the key', async () => {
        const { fetchImpl } = stockFetch({ 'api.unsplash.com/search/photos': 401 });
        const check = await checkUnsplash({}, withKey(), fetchImpl);
        expect(check).toMatchObject({ ok: false });
        expect(check.fix).toContain('UNSPLASH_ACCESS_KEY');
        noSecrets(check);
      });

      it('warns, asking nothing, when there is no key, and says when it is only in the shell', async () => {
        const { calls, fetchImpl } = stockFetch({});
        const none = await checkUnsplash({}, noKeys(), fetchImpl);
        expect(none).toMatchObject({ ok: true, warn: true });
        expect(none.detail).toContain('no key');
        const shell = await checkUnsplash(
          { UNSPLASH_ACCESS_KEY: unsplashKey },
          noKeys(),
          fetchImpl,
        );
        expect(shell.detail).toContain("only in this shell's environment");
        noSecrets(shell);
        expect(calls).toEqual([]);
      });

      it('only warns when the hour is used up, Unsplash is down, odd or not reachable', async () => {
        for (const answer of [403, 429, 503, 418, 'offline'] as const) {
          const { fetchImpl } = stockFetch({ 'api.unsplash.com/search/photos': answer });
          const check = await checkUnsplash({}, withKey(), fetchImpl);
          expect(check.ok, `${answer}`).toBe(true);
          expect(check.warn, `${answer}`).toBe(true);
          expect(check.detail).toContain('not checked');
        }
      });
    });

    describe('runAllChecks', () => {
      it('adds the two checks right after the Higgsfield connector, only while Stock is on', async () => {
        const { calls, fetchImpl } = stockFetch({
          'api.openverse.org/v1/audio/': 200,
          'api.unsplash.com/search/photos': 200,
        });
        const envFile = withKeyFile();
        const off = (
          await runAllChecks(home, { PATH: '', STUDIO_SONGS: '0' }, '22.0.0', fetchImpl, envFile)
        ).map((c) => c.name);
        expect(off).not.toContain('Openverse sound effects');
        expect(off).not.toContain('Unsplash photos');
        expect(calls.some((c) => c.url.includes('openverse') || c.url.includes('unsplash'))).toBe(
          false,
        );

        const on = (
          await runAllChecks(
            home,
            { PATH: '', STUDIO_SONGS: '0', STUDIO_STOCK: '1' },
            '22.0.0',
            fetchImpl,
            envFile,
          )
        ).map((c) => c.name);
        const at = on.indexOf('Higgsfield connector');
        expect(on.slice(at + 1, at + 3)).toEqual(['Openverse sound effects', 'Unsplash photos']);
        expect(
          on.filter((name) => !name.startsWith('Openverse') && !name.startsWith('Unsplash')),
        ).toEqual(off);
      });

      it('also turns them on from config.json', async () => {
        writeEngineConfig({ stock: true });
        const { fetchImpl } = stockFetch({
          'api.openverse.org/v1/audio/': 200,
          'api.unsplash.com/search/photos': 200,
        });
        const names = (
          await runAllChecks(
            home,
            { PATH: '', STUDIO_SONGS: '0' },
            '22.0.0',
            fetchImpl,
            withKeyFile(),
          )
        ).map((c) => c.name);
        expect(names).toContain('Unsplash photos');
      });
    });

    function withKeyFile() {
      return writeEnvFile(`UNSPLASH_ACCESS_KEY=${unsplashKey}\n`);
    }
  });
});
