import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findTailscale,
  normaliseHostname,
  parseTailscaleStatus,
  serveCommand,
  TAILSCALE_APP_BIN,
  tailscaleCliEnv,
} from './tailscale-cli.js';

/** The parts of a real `tailscale status --json` (1.104) that matter, from a Mac signed in. */
const STATUS = {
  Version: '1.104.1-t7f4efe814-g4939ea2e4',
  BackendState: 'Running',
  Self: {
    ID: 'nAbC123CNTRL',
    HostName: 'Studio Mac',
    DNSName: 'studio-mac.tail1234.ts.net.',
    OS: 'macOS',
    UserID: 8447852929966730,
    AltSharerUserID: 1111,
  },
  MagicDNSSuffix: 'tail1234.ts.net',
  Peer: {
    'nodekey:abc': { DNSName: 'iphone.tail1234.ts.net.', UserID: 8447852929966730 },
    'nodekey:def': { DNSName: 'guest.tail1234.ts.net.', UserID: 2222 },
  },
  User: {
    '8447852929966730': { ID: 8447852929966730, LoginName: 'Owner@Example.com' },
    '2222': { ID: 2222, LoginName: 'guest@example.com' },
  },
};

describe('parseTailscaleStatus', () => {
  it("reads the Mac's name without the trailing dot, and its owner's login", () => {
    expect(parseTailscaleStatus(STATUS)).toEqual({
      dnsName: 'studio-mac.tail1234.ts.net',
      ownerLogin: 'owner@example.com',
    });
  });

  it('has neither when signed out, or when the answer is not what it expects', () => {
    const signedOut = { BackendState: 'NeedsLogin', Self: { DNSName: '', UserID: 0 }, User: null };
    for (const status of [signedOut, {}, null, 'text', { Self: 'x', User: [] }]) {
      expect(parseTailscaleStatus(status)).toEqual({ dnsName: null, ownerLogin: null });
    }
  });

  it('has no owner for a tagged Mac', () => {
    const tagged = {
      Self: { DNSName: 'studio-mac.tail1234.ts.net.', UserID: 9 },
      User: { '9': { LoginName: 'tagged-devices' } },
    };
    expect(parseTailscaleStatus(tagged)).toEqual({
      dnsName: 'studio-mac.tail1234.ts.net',
      ownerLogin: null,
    });
  });

  it('has no owner when the user id matches no user, or more than one', () => {
    const missing = {
      Self: { DNSName: 'm.ts.net.', UserID: 5 },
      User: { '6': { LoginName: 'a@b' } },
    };
    expect(parseTailscaleStatus(missing).ownerLogin).toBeNull();

    // Two ids past 2^53 that read as the same number: which one is the owner can't be told.
    const ambiguous = {
      Self: { DNSName: 'm.ts.net.', UserID: 2 ** 53 },
      User: {
        '9007199254740992': { LoginName: 'one@example.com' },
        '9007199254740993': { LoginName: 'two@example.com' },
      },
    };
    expect(parseTailscaleStatus(ambiguous).ownerLogin).toBeNull();
  });
});

describe('normaliseHostname', () => {
  it('lowercases and drops one trailing dot', () => {
    expect(normaliseHostname(' Studio-Mac.Tail1234.TS.net. ')).toBe('studio-mac.tail1234.ts.net');
    expect(normaliseHostname('localhost')).toBe('localhost');
  });
});

describe('serveCommand', () => {
  it('serves the engine port in the background, with the CLI it is given', () => {
    expect(serveCommand(4310)).toBe('tailscale serve --bg 4310');
    expect(serveCommand(5000, TAILSCALE_APP_BIN)).toBe(
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 5000',
    );
  });
});

describe('findTailscale', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tailscale-bin-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function executable(path: string) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '#!/bin/sh\n');
    chmodSync(path, 0o755);
    return path;
  }

  it('prefers `tailscale` on PATH, then the extra folders, then the Mac app', () => {
    const app = executable(join(dir, 'Tailscale.app/Contents/MacOS/Tailscale'));
    const brew = executable(join(dir, 'brew/tailscale'));
    const onPath = executable(join(dir, 'bin/tailscale'));
    const extraDirs = [join(dir, 'brew')];

    expect(findTailscale({ pathEnv: join(dir, 'bin'), extraDirs, appBin: app })).toEqual({
      path: onPath,
      onPath: true,
    });
    expect(findTailscale({ pathEnv: '', extraDirs, appBin: app })).toEqual({
      path: brew,
      onPath: false,
    });
    expect(findTailscale({ pathEnv: '', extraDirs: [], appBin: app })).toEqual({
      path: app,
      onPath: false,
    });
  });

  it('is null when there is none, or only a file that cannot run', () => {
    writeFileSync(join(dir, 'tailscale'), 'not a program');
    expect(findTailscale({ pathEnv: dir, extraDirs: [], appBin: join(dir, 'missing') })).toBeNull();
  });
});

describe('tailscaleCliEnv', () => {
  it('keeps the environment and tells the Mac app binary to act as the CLI (the agent has no TERM)', () => {
    expect(tailscaleCliEnv({ PATH: '/usr/bin', HOME: '/Users/me' })).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      TAILSCALE_BE_CLI: '1',
    });
  });
});
