import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  briefAllowedTools,
  briefClaudeArgs,
  childEnv,
  childPath,
  claudeArgs,
  claudeEnv,
  GENERATE_BASH_TIMEOUT_MS,
  GENERATE_TOOLS,
  generateAllowedTools,
  generateClaudeArgs,
  generateDenyRead,
  HIGGSFIELD_MCP_PREFIX,
  HIGGSFIELD_TOOLS,
  RENDER_MODEL,
  readDenyRulesOutsideJob,
  stockDenyRead,
  tildePath,
} from './claude-command.js';

describe('RENDER_MODEL', () => {
  // Phase 3 §4: the render run renders and checks the approved preview, it doesn't edit.
  it('is sonnet, and goes to the CLI as --model sonnet', () => {
    expect(RENDER_MODEL).toBe('sonnet');
    const args = claudeArgs({ prompt: 'P', model: RENDER_MODEL });
    expect(args.slice(5, 7)).toEqual(['--model', 'sonnet']);
  });
});

describe('claudeArgs', () => {
  it('is the command E1 verified (README "Running edits")', () => {
    expect(claudeArgs({ prompt: 'P', model: 'opus' })).toEqual([
      '-p',
      'P',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'opus',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--tools',
      'Bash,Read,Write,Edit,Skill,Task',
      '--allowedTools',
      'Bash Read Write Edit Skill Task',
      '--strict-mcp-config',
      '--settings',
      '{"disableAllHooks":true}',
    ]);
  });

  it('gives the revise run of a generated video the connector: ToolSearch, its tools, no strict mode (U26)', () => {
    const args = claudeArgs({ prompt: 'P', higgsfield: true });
    expect(args).not.toContain('--strict-mcp-config');
    expect(args[args.indexOf('--tools') + 1]).toBe('Bash,Read,Write,Edit,Skill,Task,ToolSearch');
    const allowed = (args[args.indexOf('--allowedTools') + 1] ?? '').split(' ');
    expect(allowed).toEqual(
      expect.arrayContaining(['Bash', 'ToolSearch', 'mcp__claude_ai_Higgsfield__generate_video']),
    );
    expect(allowed.filter((rule) => rule.startsWith('mcp__'))).toEqual(
      HIGGSFIELD_TOOLS.map((tool) => `${HIGGSFIELD_MCP_PREFIX}${tool}`),
    );
    // Any other run keeps strict mode and no connector.
    expect(claudeArgs({ prompt: 'P' })).toContain('--strict-mcp-config');
  });

  it('leaves --model out when no model is configured (the CLI default)', () => {
    expect(claudeArgs({ prompt: 'P' })).not.toContain('--model');
  });

  it('leaves --effort out when none is given (the CLI default)', () => {
    expect(claudeArgs({ prompt: 'P', model: 'opus' })).not.toContain('--effort');
  });

  it('sends the effort right after the model', () => {
    const args = claudeArgs({ prompt: 'P', model: 'opus', effort: 'xhigh' });
    expect(args.slice(5, 9)).toEqual(['--model', 'opus', '--effort', 'xhigh']);
  });

  it('sends the effort even when the model is the CLI default', () => {
    const args = claudeArgs({ prompt: 'P', effort: 'medium' });
    expect(args.slice(5, 7)).toEqual(['--effort', 'medium']);
  });
});

describe('claudeArgs: read denials (CVP-258)', () => {
  it('puts the rules in the settings, next to disableAllHooks', () => {
    const rules = ['Read(//inbox/Acme/Other job/**)', 'Read(//inbox/Acme/_Series/**)'];
    const args = claudeArgs({ prompt: 'P', denyRead: rules });
    expect(JSON.parse(args[args.indexOf('--settings') + 1] as string)).toEqual({
      disableAllHooks: true,
      permissions: { deny: rules },
    });
  });

  it('adds nothing to the settings when there is nothing to deny', () => {
    for (const denyRead of [undefined, []]) {
      const args = claudeArgs({ prompt: 'P', denyRead });
      expect(args[args.indexOf('--settings') + 1]).toBe('{"disableAllHooks":true}');
    }
  });
});

describe('readDenyRulesOutsideJob', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  /** A temp inbox with these folders (and a loose file in every client folder). */
  function inbox(folders: string[]): string {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-deny-')));
    const path = join(root, 'Studio Inbox');
    for (const folder of folders) mkdirSync(join(path, folder), { recursive: true });
    return path;
  }

  it("denies the client's other jobs and kits, the other clients and the shared folders, not the job", () => {
    const path = inbox([
      'Acme/Launch teaser/edit/style',
      'Acme/Other job',
      'Acme/_Style',
      'Acme/_Series/Myth',
      'Other Studio/Job',
      '_Fonts',
      '_Exports/Acme',
    ]);
    writeFileSync(join(path, 'Acme', 'notes.txt'), 'x');
    expect(readDenyRulesOutsideJob(path, join(path, 'Acme', 'Launch teaser'))).toEqual([
      `Read(/${path}/Acme/Other job/**)`,
      `Read(/${path}/Acme/_Series/**)`,
      `Read(/${path}/Acme/_Style/**)`,
      `Read(/${path}/Other Studio/**)`,
      `Read(/${path}/_Exports/**)`,
      `Read(/${path}/_Fonts/**)`,
    ]);
  });

  it("denies the client's _Shared unless the run may use it, and never another client's", () => {
    const path = inbox(['Acme/Launch teaser', 'Acme/_Shared/broll', 'Other Studio/_Shared']);
    const job = join(path, 'Acme', 'Launch teaser');
    expect(readDenyRulesOutsideJob(path, job)).toEqual([
      `Read(/${path}/Acme/_Shared/**)`,
      `Read(/${path}/Other Studio/**)`,
    ]);
    expect(readDenyRulesOutsideJob(path, job, { shared: true })).toEqual([
      `Read(/${path}/Other Studio/**)`,
    ]);
  });

  it('leaves nothing to deny for a job that is alone in the inbox', () => {
    const path = inbox(['Acme/Launch teaser']);
    expect(readDenyRulesOutsideJob(path, join(path, 'Acme', 'Launch teaser'))).toEqual([]);
  });

  it('keeps Hebrew names, and writes a name with pattern characters as that folder only', () => {
    const path = inbox([
      'עו״ד דוד לוי/שאלות נפוצות 5',
      'עו״ד דוד לוי/מיתוס או אמת 6',
      'עו״ד דוד לוי/Job (2) [new] {x} *',
    ]);
    const rules = readDenyRulesOutsideJob(path, join(path, 'עו״ד דוד לוי', 'שאלות נפוצות 5'));
    expect(rules).toEqual([
      `Read(/${path}/עו״ד דוד לוי/Job \\(2\\) \\[new\\] \\{x\\} \\*/**)`,
      `Read(/${path}/עו״ד דוד לוי/מיתוס או אמת 6/**)`,
    ]);
  });

  it('denies nothing for a job folder that is not inside the inbox', () => {
    const path = inbox(['Acme/Launch teaser']);
    expect(readDenyRulesOutsideJob(path, root as string)).toEqual([]);
    expect(readDenyRulesOutsideJob(path, path)).toEqual([]);
  });
});

describe('briefClaudeArgs', () => {
  it("is the edit run's flag style with Sonnet and the Brief run's own tools", () => {
    const args = briefClaudeArgs({ prompt: 'P', home: '/Users/test' });
    expect(args).toEqual([
      '-p',
      'P',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'sonnet',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--tools',
      'Read,Glob,Grep,Write,Bash',
      '--allowedTools',
      briefAllowedTools('/Users/test').join(','),
      '--strict-mcp-config',
      '--settings',
      '{"disableAllHooks":true}',
    ]);
  });

  it('allows writes under ./edit/ only, and Bash only for ls, ffprobe, textutil and transcribe.py', () => {
    expect(briefAllowedTools('/Users/test')).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Edit(./edit/**)',
      'Bash(ls)',
      'Bash(ls *)',
      'Bash(ffprobe *)',
      'Bash(textutil -convert txt -stdout *)',
      'Bash(~/Developer/video-use/.venv/bin/python ~/Developer/video-use/helpers/transcribe.py *)',
      'Bash(/Users/test/Developer/video-use/.venv/bin/python /Users/test/Developer/video-use/helpers/transcribe.py *)',
    ]);
  });
});

describe('childEnv', () => {
  const home = '/Users/test';
  const serverEnv = {
    PATH: '/custom/bin:/usr/bin',
    USER: 'test',
    TMPDIR: '/var/folders/x/',
    ELEVENLABS_API_KEY: 'sk_should_not_pass',
    ANTHROPIC_API_KEY: 'sk-ant-should-not-pass',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    SECRET_TOKEN: 'nope',
    HTTPS_PROXY: 'http://proxy:8080',
  };

  it('has HOME, the run PATH and the bash shell', () => {
    const env = childEnv({ home, env: serverEnv, nodeBinDir: '/nvm/v22/bin' });
    expect(env.HOME).toBe(home);
    expect(env.CLAUDE_CODE_SHELL).toBe('/bin/bash');
    expect(env.PATH).toBe(
      '/opt/homebrew/bin:/usr/local/bin:/Users/test/.local/bin:/nvm/v22/bin:/custom/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    );
    expect(env).toMatchObject({
      USER: 'test',
      TMPDIR: '/var/folders/x/',
      HTTPS_PROXY: 'http://proxy:8080',
    });
    expect(env.LANG).toBe('en_US.UTF-8');
  });

  it('passes no keys, tokens or Claude session variables', () => {
    const env = childEnv({ home, env: serverEnv, nodeBinDir: '/nvm/v22/bin' });
    for (const key of [
      'ELEVENLABS_API_KEY',
      'ANTHROPIC_API_KEY',
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'SECRET_TOKEN',
    ]) {
      expect(env).not.toHaveProperty(key);
    }
    expect(JSON.stringify(env)).not.toMatch(/should-not-pass|should_not_pass/);
  });

  it('claudeEnv never carries ANTHROPIC_API_KEY: every claude run uses the plan login', () => {
    const { ANTHROPIC_API_KEY: _ignored, ...noKey } = serverEnv;
    const withKey = { ...noKey, ANTHROPIC_API_KEY: ' sk-ant-api-test ' };
    const env = claudeEnv({ home, env: withKey, nodeBinDir: '/nvm/v22/bin' });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(JSON.stringify(env)).not.toContain('sk-ant-api-test');
    expect(env).not.toHaveProperty('ELEVENLABS_API_KEY');
    expect(env).not.toHaveProperty('SECRET_TOKEN');
    expect(childEnv({ home, env: withKey })).not.toHaveProperty('ANTHROPIC_API_KEY');
    // No key, an empty one, or a real one: the same environment.
    expect(claudeEnv({ home, env: noKey, nodeBinDir: '/nvm/v22/bin' })).toEqual(env);
    expect(
      claudeEnv({ home, env: { ...noKey, ANTHROPIC_API_KEY: '' }, nodeBinDir: '/nvm/v22/bin' }),
    ).toEqual(env);
  });

  it('claudeEnv carries the key only when the Claude billing switch is off (planOnly: false)', () => {
    const { ANTHROPIC_API_KEY: _ignored, ...noKey } = serverEnv;
    const withKey = { ...noKey, ANTHROPIC_API_KEY: ' sk-ant-api-test ' };
    const opts = { home, env: withKey, nodeBinDir: '/nvm/v22/bin' };
    // Switch off: the trimmed key goes to the claude process, and to nothing else.
    const api = claudeEnv({ ...opts, planOnly: false });
    expect(api.ANTHROPIC_API_KEY).toBe('sk-ant-api-test');
    expect(api).not.toHaveProperty('ELEVENLABS_API_KEY');
    expect(childEnv({ ...opts, planOnly: false })).not.toHaveProperty('ANTHROPIC_API_KEY');
    // Switch on, or not said (a caller that forgets it): the plan login, as before.
    expect(claudeEnv({ ...opts, planOnly: true })).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(claudeEnv(opts)).not.toHaveProperty('ANTHROPIC_API_KEY');
    // Switch off with no key (or an empty one): nothing to carry, so the CLI uses the login.
    expect(claudeEnv({ ...opts, env: noKey, planOnly: false })).not.toHaveProperty(
      'ANTHROPIC_API_KEY',
    );
    expect(
      claudeEnv({ ...opts, env: { ...noKey, ANTHROPIC_API_KEY: '  ' }, planOnly: false }),
    ).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  // SG4: the song command's tools, only for a run that may call it.
  it('gives STUDIO_YT_DLP and STUDIO_DENO only when the run is handed the song tools, and nothing else of Songs', () => {
    const songTools = { ytDlp: '/opt/homebrew/bin/yt-dlp', deno: '/opt/homebrew/bin/deno' };
    const server = {
      ...serverEnv,
      STUDIO_YT_DLP: '/server/own/yt-dlp',
      STUDIO_DENO: '/server/own/deno',
      APIFY_TOKEN: 'apify_should_not_pass',
    };
    for (const make of [childEnv, claudeEnv]) {
      const without = make({ home, env: server });
      expect(without).not.toHaveProperty('STUDIO_YT_DLP');
      expect(without).not.toHaveProperty('STUDIO_DENO');
      const env = make({ home, env: server, songTools });
      expect(env.STUDIO_YT_DLP).toBe('/opt/homebrew/bin/yt-dlp');
      expect(env.STUDIO_DENO).toBe('/opt/homebrew/bin/deno');
      // The script reads the Apify key from .env itself: it is never put in the environment.
      expect(env).not.toHaveProperty('APIFY_TOKEN');
      expect(JSON.stringify(env)).not.toContain('apify_should_not_pass');
    }
  });

  it('builds a PATH without duplicates or empty entries when the server has none', () => {
    expect(childPath(home, undefined, '/usr/bin')).toBe(
      '/opt/homebrew/bin:/usr/local/bin:/Users/test/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    );
  });
});

describe('tildePath', () => {
  it('shortens paths under home only', () => {
    expect(tildePath('/Users/test/.local/bin/claude', '/Users/test')).toBe('~/.local/bin/claude');
    expect(tildePath('/Users/tester/x', '/Users/test')).toBe('/Users/tester/x');
  });
});

// Generated videos (GN5): the Generate run's command and environment.
describe('the Generate run', () => {
  const home = '/Users/me';
  const scripts = {
    voice: '/repo/apps/server/assets/generate/make-voice.mjs',
    shots: '/repo/apps/server/assets/generate/make-shots.mjs',
  };

  it('has the Brief run’s tools, no Edit, Skill or Task, plus ToolSearch for the connector', () => {
    expect(GENERATE_TOOLS).toEqual(['Read', 'Glob', 'Grep', 'Write', 'Bash', 'ToolSearch']);
  });

  it('lets the run use the Higgsfield connector’s generation tools and nothing else of it (U26)', () => {
    const allowed = generateAllowedTools(home, scripts);
    const connector = allowed.filter((rule) => rule.startsWith(HIGGSFIELD_MCP_PREFIX));
    expect(connector).toEqual(HIGGSFIELD_TOOLS.map((tool) => `${HIGGSFIELD_MCP_PREFIX}${tool}`));
    expect(allowed).toContain('ToolSearch');
    expect(connector).toEqual(
      expect.arrayContaining([
        'mcp__claude_ai_Higgsfield__generate_video',
        'mcp__claude_ai_Higgsfield__jobs_wait',
        'mcp__claude_ai_Higgsfield__media_upload',
        'mcp__claude_ai_Higgsfield__media_confirm',
      ]),
    );
    // No picture is made any more (U31): no image tools, no reference elements.
    expect(connector.join(' ')).not.toMatch(/generate_image|manage_reference_elements/);
    // No whole-server rule, and none of the connector's websites, TikTok, publishing or deleting tools.
    expect(allowed).not.toContain('mcp__claude_ai_Higgsfield');
    expect(connector.join(' ')).not.toMatch(
      /publish|delete|tiktok|website|deploy|sandbox|trial|folder/,
    );
  });

  it('allows the two scripts, ffmpeg, ffprobe, ls and video-use’s helpers, and writes only under ./edit/', () => {
    const allowed = generateAllowedTools(home, scripts);
    expect(allowed).toEqual(
      expect.arrayContaining([
        'Read',
        'Glob',
        'Grep',
        'Edit(./edit/**)',
        'Bash(ls)',
        'Bash(ls *)',
        'Bash(ffprobe *)',
        'Bash(ffmpeg *)',
        `Bash(node ${scripts.voice} *)`,
        `Bash(node "${scripts.voice}" *)`,
        `Bash(node ${scripts.shots} *)`,
        `Bash(node "${scripts.shots}" *)`,
        'Bash(~/Developer/video-use/.venv/bin/python ~/Developer/video-use/helpers/transcribe.py *)',
        'Bash(/Users/me/Developer/video-use/.venv/bin/python /Users/me/Developer/video-use/helpers/transcribe.py *)',
        'Bash(~/Developer/video-use/.venv/bin/python ~/Developer/video-use/helpers/timeline_view.py *)',
        'Bash(/Users/me/Developer/video-use/.venv/bin/python /Users/me/Developer/video-use/helpers/timeline_view.py *)',
      ]),
    );
    // Nothing that changes the machine beyond ./edit/: no bare Bash, no rm, cp, mv, curl or other node.
    for (const rule of allowed) {
      expect(rule).not.toMatch(/^Bash\(\*\)$|rm |curl|cp |mv |node \*|python3|bash -c|sh -c/);
    }
  });

  it('is the Brief run’s command style with the edit run’s model and effort', () => {
    const args = generateClaudeArgs({
      prompt: 'P',
      model: 'opus',
      effort: 'xhigh',
      home,
      scripts,
      denyRead: ['Read(//a/.env)'],
    });
    expect(args.slice(0, 5)).toEqual(['-p', 'P', '--output-format', 'stream-json', '--verbose']);
    expect(args.slice(5, 9)).toEqual(['--model', 'opus', '--effort', 'xhigh']);
    expect(args).toEqual(
      expect.arrayContaining([
        '--permission-mode',
        'dontAsk',
        '--permission-prompts',
        'none',
        '--tools',
        'Read,Glob,Grep,Write,Bash,ToolSearch',
      ]),
    );
    // Strict mode would hide the Higgsfield connector (U26).
    expect(args).not.toContain('--strict-mcp-config');
    const settings = JSON.parse(args[args.indexOf('--settings') + 1] ?? '{}');
    expect(settings).toEqual({ disableAllHooks: true, permissions: { deny: ['Read(//a/.env)'] } });
  });

  it('leaves the model and effort to the CLI when none is given, and adds no deny list when empty', () => {
    const args = generateClaudeArgs({ prompt: 'P', home, scripts });
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
    expect(JSON.parse(args[args.indexOf('--settings') + 1] ?? '{}')).toEqual({
      disableAllHooks: true,
    });
  });

  it('denies the Read of both key files, with the characters of a path escaped', () => {
    expect(generateDenyRead('/repo (new)/.env', home)).toEqual([
      'Read(//repo \\(new\\)/.env)',
      'Read(//Users/me/Developer/video-use/.env)',
    ]);
    // One file named twice is denied once.
    expect(generateDenyRead('/Users/me/Developer/video-use/.env', home)).toHaveLength(1);
  });

  it('gives the run the PATH of the env file, the voice and Bash its ten minutes: never a key', () => {
    const env = childEnv({
      home,
      env: {
        PATH: '/usr/bin',
        HIGGSFIELD_API_KEY: 'id:secret',
        ELEVENLABS_API_KEY: 'sk_abc',
        ANTHROPIC_API_KEY: 'sk-ant',
      },
      generate: { envFile: '/repo/.env', voiceId: '68RUZBDjLe2YBQvv8zFx' },
    });
    expect(env.STUDIO_ENV_FILE).toBe('/repo/.env');
    expect(env.STUDIO_GENERATE_VOICE_ID).toBe('68RUZBDjLe2YBQvv8zFx');
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe(String(GENERATE_BASH_TIMEOUT_MS));
    expect(env.BASH_MAX_TIMEOUT_MS).toBe('600000');
    expect(env.STUDIO_GENERATE_FAKE).toBeUndefined();
    expect(JSON.stringify(env)).not.toMatch(/secret|sk_abc|sk-ant/);
    expect(Object.keys(env).filter((key) => /KEY/.test(key))).toEqual([]);
  });

  it('adds the fake switch only when asked, and only to a Generate run', () => {
    const base = { home, env: { PATH: '/usr/bin' } };
    expect(
      childEnv({ ...base, generate: { envFile: '/e', voiceId: 'v' }, generateFake: true })
        .STUDIO_GENERATE_FAKE,
    ).toBe('1');
    expect(childEnv({ ...base, generateFake: true }).STUDIO_GENERATE_FAKE).toBeUndefined();
  });

  it('leaves every other run’s environment as it was', () => {
    const env = childEnv({ home, env: { PATH: '/usr/bin' } });
    for (const name of [
      'STUDIO_ENV_FILE',
      'STUDIO_GENERATE_VOICE_ID',
      'BASH_DEFAULT_TIMEOUT_MS',
      'BASH_MAX_TIMEOUT_MS',
    ]) {
      expect(env[name], name).toBeUndefined();
    }
  });
});

describe('Stock media in the environment and the deny list (ST4)', () => {
  const home = '/Users/me';

  it('gives the run the PATH of the env file and nothing else', () => {
    const env = childEnv({
      home,
      env: {
        PATH: '/usr/bin',
        UNSPLASH_ACCESS_KEY: 'unsplash-secret-1',
        OPENVERSE_CLIENT_SECRET: 'openverse-secret-1',
      },
      stock: { envFile: '/repo/.env' },
    });
    expect(env.STUDIO_ENV_FILE).toBe('/repo/.env');
    expect(JSON.stringify(env)).not.toMatch(/secret/);
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBeUndefined();
    expect(env.STUDIO_GENERATE_VOICE_ID).toBeUndefined();
  });

  it('leaves a run without it as it was', () => {
    expect(childEnv({ home, env: { PATH: '/usr/bin' } }).STUDIO_ENV_FILE).toBeUndefined();
  });

  it('denies the Read of the env file, with the characters of a path escaped', () => {
    expect(stockDenyRead('/repo (new)/.env')).toEqual(['Read(//repo \\(new\\)/.env)']);
  });
});
