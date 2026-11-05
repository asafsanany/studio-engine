import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Runs the agent scripts in dry-run mode inside a temp copy of the repo layout, so nothing
// touches the real ~/Library/LaunchAgents or launchd. The repo path contains a space and an
// ampersand so the plist XML escaping is exercised.
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const LABEL = 'com.studio-engine.server';

let root: string;
let repo: string;
let home: string;
let agentDir: string;
let serverEntry: string;

function xml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function run(script: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [join(repo, 'scripts', script)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      STUDIO_AGENT_DIR: agentDir,
      STUDIO_AGENT_DRY_RUN: '1',
      STUDIO_AGENT_SKIP_BUILD: '1',
      ...env,
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-'));
  repo = join(root, 'Studio Repo & Co', 'studio-engine');
  home = join(root, 'home');
  agentDir = join(root, 'agents');
  serverEntry = join(repo, 'apps', 'server', 'dist', 'index.js');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'apps', 'server', 'dist'), { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const name of ['install-agent.sh', 'uninstall-agent.sh']) {
    copyFileSync(join(SCRIPTS_DIR, name), join(repo, 'scripts', name));
  }
  writeFileSync(serverEntry, '');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('install-agent.sh (dry run)', () => {
  it('writes a plist that starts the built server with node, without running launchctl', () => {
    const result = run('install-agent.sh');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('launchctl bootstrap');
    // Dry run must not create the log folder: that is part of a real install.
    expect(existsSync(join(home, '.studio-engine'))).toBe(false);

    const plist = readFileSync(join(agentDir, `${LABEL}.plist`), 'utf8');
    expect(plist).toMatch(new RegExp(`<key>Label</key>\\s*<string>${LABEL}</string>`));
    expect(plist).toMatch(
      /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/[^<]*\/node<\/string>/,
    );
    expect(plist).toContain(`<string>${xml(serverEntry)}</string>`);
    expect(plist).toContain(`<key>WorkingDirectory</key>\n  <string>${xml(repo)}</string>`);
    expect(plist).toMatch(/<key>NODE_ENV<\/key>\s*<string>production<\/string>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toContain(
      `<key>StandardOutPath</key>\n  <string>${xml(join(home, '.studio-engine', 'logs', 'server.log'))}</string>`,
    );
    expect(plist).toContain('/usr/bin:/bin:/usr/sbin:/sbin');

    if (process.platform === 'darwin') {
      const lint = spawnSync('plutil', ['-lint', join(agentDir, `${LABEL}.plist`)], {
        encoding: 'utf8',
      });
      expect(lint.status, lint.stdout + lint.stderr).toBe(0);
    }
  });

  it('fails with a clear message and writes no plist when the server is not built', () => {
    rmSync(serverEntry);

    const result = run('install-agent.sh');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('pnpm build');
    expect(existsSync(join(agentDir, `${LABEL}.plist`))).toBe(false);
  });
});

describe('uninstall-agent.sh (dry run)', () => {
  it('prints the bootout and removal it would do, and keeps the plist', () => {
    expect(run('install-agent.sh').status).toBe(0);
    const plist = join(agentDir, `${LABEL}.plist`);

    const result = run('uninstall-agent.sh');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`launchctl bootout gui/`);
    expect(result.stdout).toContain(`${LABEL}`);
    expect(existsSync(plist)).toBe(true);
  });
});
