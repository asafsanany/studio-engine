import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_GENERATE_VOICE_ID } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APIFY_TOKEN_ENV,
  ConfigError,
  ENV_FILE_ENV,
  ensureDirs,
  envFilePath,
  expandHome,
  HIGGSFIELD_API_KEY_ENV,
  loadConfig,
} from './config.js';

// Every test uses a temp home and an explicit env object, so the real ~/.studio-engine,
// ~/Studio Inbox and the developer's shell STUDIO_* variables are never read.
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'studio-config-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeConfigFile(contents: unknown): void {
  const dir = join(home, '.studio-engine');
  mkdirSync(dir, { recursive: true });
  const text = typeof contents === 'string' ? contents : JSON.stringify(contents);
  writeFileSync(join(dir, 'config.json'), text);
}

function load(env: Record<string, string> = {}) {
  return loadConfig({ home, env });
}

describe('defaults', () => {
  it('uses the documented defaults when nothing is set', () => {
    expect(load()).toEqual({
      inboxPath: join(home, 'Studio Inbox'),
      exportsDir: join(home, 'Studio Inbox', '_Exports'),
      dataDir: join(home, '.studio-engine'),
      dbPath: join(home, '.studio-engine', 'engine.db'),
      logsDir: join(home, '.studio-engine', 'logs'),
      port: 4310,
      host: '127.0.0.1',
      settleMs: 60_000,
      claudeBin: 'claude',
      model: undefined,
      runner: 'claude',
      runTimeoutMin: 90,
      review: true,
      manualStart: true,
      knownClientsOnly: true,
      series: true,
      jobSheet: true,
      analytics: true,
      phone: true,
      graphics: true,
      graphicsInEdits: true,
      music: true,
      stock: false,
      luts: true,
      lutsInEdits: true,
      fonts: true,
      fontsInNotes: true,
      quickFixes: true,
      claudePlanOnly: true,
      songs: true,
      songTools: { ytDlp: '/opt/homebrew/bin/yt-dlp', deno: '/opt/homebrew/bin/deno' },
      generate: true,
      generateBudgetUsd: 5,
      generateUsdPerCredit: 0.056,
      generateVoiceId: DEFAULT_GENERATE_VOICE_ID,
      draftChat: false,
      twoJobsAtOnce: true,
      instagram: true,
      instagramClients: 'active',
      currencySymbol: '$',
      usdToHomeCurrency: 1,
      instagramDmFrom: [],
      apiCreditsMonthlyUsd: undefined,
      planMonthlyUsd: undefined,
    });
  });
});

describe('draftChat (the Draft & chat switch)', () => {
  it('is off by default', () => {
    expect(load().draftChat).toBe(false);
  });

  it('can be turned on in config.json', () => {
    writeConfigFile({ draftChat: true });
    expect(load().draftChat).toBe(true);
  });

  it('is on for 1 and true, off for 0 and false, and the environment wins', () => {
    for (const on of ['1', 'true', 'TRUE']) {
      expect(load({ STUDIO_DRAFT_CHAT: on }).draftChat, on).toBe(true);
    }
    writeConfigFile({ draftChat: true });
    for (const off of ['0', 'false', 'FALSE']) {
      expect(load({ STUDIO_DRAFT_CHAT: off }).draftChat, off).toBe(false);
    }
  });
});

describe('instagram (the Clients × Instagram switch)', () => {
  it('is on by default', () => {
    expect(load().instagram).toBe(true);
  });

  it('can be turned off in config.json', () => {
    writeConfigFile({ instagram: false });
    expect(load().instagram).toBe(false);
  });

  it('is on for 1 and true, off for 0 and false, and the environment wins', () => {
    for (const on of ['1', 'true', 'TRUE']) {
      expect(load({ STUDIO_INSTAGRAM: on }).instagram, on).toBe(true);
    }
    writeConfigFile({ instagram: true });
    for (const off of ['0', 'false', 'FALSE']) {
      expect(load({ STUDIO_INSTAGRAM: off }).instagram, off).toBe(false);
    }
  });
});

describe('instagramClients (Which clients the Instagram scan reads)', () => {
  it('is active by default', () => {
    expect(load().instagramClients).toBe('active');
  });

  it('can be set to all in config.json, and the environment wins', () => {
    writeConfigFile({ instagramClients: 'all' });
    expect(load().instagramClients).toBe('all');
    expect(load({ STUDIO_INSTAGRAM_CLIENTS: 'active' }).instagramClients).toBe('active');
    expect(load({ STUDIO_INSTAGRAM_CLIENTS: 'all' }).instagramClients).toBe('all');
  });

  it('refuses a word that is neither, in config.json and in the environment', () => {
    writeConfigFile({ instagramClients: 'some' });
    expect(() => load()).toThrow(/instagramClients: must be active or all/);
    expect(() => load({ STUDIO_INSTAGRAM_CLIENTS: 'most' })).toThrow(
      /STUDIO_INSTAGRAM_CLIENTS: must be active or all/,
    );
  });
});

describe('merge order: defaults < config.json < env', () => {
  it('config.json overrides a default', () => {
    writeConfigFile({ port: 5000, claudeBin: '/opt/claude/bin/claude' });

    const config = load();

    expect(config.port).toBe(5000);
    expect(config.claudeBin).toBe('/opt/claude/bin/claude');
    expect(config.host).toBe('127.0.0.1');
  });

  it('env overrides config.json for the same field', () => {
    writeConfigFile({ port: 5000, host: 'localhost' });

    const config = load({ STUDIO_PORT: '6000' });

    expect(config.port).toBe(6000);
    expect(config.host).toBe('localhost');
  });

  it('applies each layer to its own fields in one load', () => {
    writeConfigFile({ settleMs: 1_000, model: 'from-file', port: 5000 });

    const config = load({ STUDIO_MODEL: 'from-env', STUDIO_SETTLE_MS: '2000' });

    expect(config.model).toBe('from-env');
    expect(config.settleMs).toBe(2_000);
    expect(config.port).toBe(5000);
    expect(config.host).toBe('127.0.0.1');
    expect(config.claudeBin).toBe('claude');
  });

  it('keeps a file value when env sets nothing for that field', () => {
    writeConfigFile({ model: 'from-file' });

    expect(load().model).toBe('from-file');
  });

  it('treats empty env values as unset', () => {
    const config = load({
      STUDIO_PORT: '',
      STUDIO_INBOX: '',
      STUDIO_MODEL: '',
      STUDIO_RUNNER: '',
      STUDIO_RUN_TIMEOUT_MIN: '',
      STUDIO_REVIEW: '',
    });

    expect(config.port).toBe(4310);
    expect(config.inboxPath).toBe(join(home, 'Studio Inbox'));
    expect(config.model).toBeUndefined();
    expect(config.runner).toBe('claude');
    expect(config.runTimeoutMin).toBe(90);
    expect(config.review).toBe(true);
  });
});

describe('review (the Review switch)', () => {
  it('is on by default', () => {
    expect(load().review).toBe(true);
  });

  it('can be turned off in config.json', () => {
    writeConfigFile({ review: false });
    expect(load().review).toBe(false);
  });

  it('stays on when config.json says true', () => {
    writeConfigFile({ review: true });
    expect(load().review).toBe(true);
  });

  it('is off for STUDIO_REVIEW 0, false and FALSE, on for 1, true and TRUE', () => {
    for (const off of ['0', 'false', 'FALSE', 'False']) {
      expect(load({ STUDIO_REVIEW: off }).review, off).toBe(false);
    }
    for (const on of ['1', 'true', 'TRUE', 'True']) {
      expect(load({ STUDIO_REVIEW: on }).review, on).toBe(true);
    }
  });

  it('lets the environment win over config.json, both ways', () => {
    writeConfigFile({ review: false });
    expect(load({ STUDIO_REVIEW: '1' }).review).toBe(true);
    writeConfigFile({ review: true });
    expect(load({ STUDIO_REVIEW: '0' }).review).toBe(false);
    expect(load({ STUDIO_REVIEW: 'false' }).review).toBe(false);
  });

  it('counts an empty STUDIO_REVIEW as unset: on by default, the file value otherwise', () => {
    expect(load({ STUDIO_REVIEW: '' }).review).toBe(true);
    writeConfigFile({ review: false });
    expect(load({ STUDIO_REVIEW: '' }).review).toBe(false);
  });

  it('rejects anything else, so a typo cannot quietly leave it on', () => {
    for (const bad of ['off', 'no', 'yes', '2', 'on', 'tru', ' 1']) {
      expect(() => load({ STUDIO_REVIEW: bad }), bad).toThrow(
        /STUDIO_REVIEW.*must be 1, 0, true or false/,
      );
    }
  });

  it('wants a JSON boolean in config.json, not a string', () => {
    writeConfigFile({ review: 'false' });
    expect(() => load()).toThrow(/review/);
    writeConfigFile({ review: 0 });
    expect(() => load()).toThrow(/review/);
  });
});

describe('series (the Series switch)', () => {
  it('is on by default', () => {
    expect(load().series).toBe(true);
  });

  it('can be turned off in config.json', () => {
    writeConfigFile({ series: false });
    expect(load().series).toBe(false);
  });

  it('is on for STUDIO_SERIES 1 and true, off for 0 and false, and the environment wins', () => {
    writeConfigFile({ series: false });
    for (const on of ['1', 'true', 'TRUE'])
      expect(load({ STUDIO_SERIES: on }).series, on).toBe(true);
    writeConfigFile({ series: true });
    for (const off of ['0', 'false']) {
      expect(load({ STUDIO_SERIES: off }).series, off).toBe(false);
    }
    expect(load({ STUDIO_SERIES: '' }).series).toBe(true);
  });

  it('rejects anything else, in the environment and in config.json', () => {
    expect(() => load({ STUDIO_SERIES: 'on' })).toThrow(
      /STUDIO_SERIES.*must be 1, 0, true or false/,
    );
    writeConfigFile({ series: 'true' });
    expect(() => load()).toThrow(/series/);
  });
});

describe('remoteHosts and remoteLogins (the phone over Tailscale Serve)', () => {
  it('are unset by default: the engine reads them from Tailscale', () => {
    const config = load();
    expect(config.remoteHosts).toBeUndefined();
    expect(config.remoteLogins).toBeUndefined();
  });

  it('come from config.json, names normalised and logins lowercased', () => {
    writeConfigFile({
      remoteHosts: ['Studio-Mac.Tail1234.ts.net.', 'other.ts.net'],
      remoteLogins: ['Owner@Example.com'],
    });

    const config = load();

    expect(config.remoteHosts).toEqual(['studio-mac.tail1234.ts.net', 'other.ts.net']);
    expect(config.remoteLogins).toEqual(['owner@example.com']);
  });

  it('may be empty lists: nobody from outside this Mac', () => {
    writeConfigFile({ remoteHosts: [], remoteLogins: [] });
    expect(load()).toMatchObject({ remoteHosts: [], remoteLogins: [] });
  });

  it('reject a URL or a port instead of a name, and a login with spaces', () => {
    writeConfigFile({ remoteHosts: ['https://studio-mac.ts.net'] });
    expect(() => load()).toThrow(/remoteHosts\.0/);
    writeConfigFile({ remoteHosts: ['studio-mac.ts.net:443'] });
    expect(() => load()).toThrow(/remoteHosts\.0/);
    writeConfigFile({ remoteHosts: 'studio-mac.ts.net' });
    expect(() => load()).toThrow(/remoteHosts/);
    writeConfigFile({ remoteLogins: ['owner @example.com'] });
    expect(() => load()).toThrow(/remoteLogins\.0/);
  });
});

describe('pushSubject (who the push services can write to)', () => {
  it('is unset by default: the engine uses the Mac owner login', () => {
    expect(load().pushSubject).toBeUndefined();
  });

  it('comes from config.json, an email gets mailto: and an https address stays', () => {
    writeConfigFile({ pushSubject: 'owner@example.com' });
    expect(load().pushSubject).toBe('mailto:owner@example.com');
    writeConfigFile({ pushSubject: 'mailto:owner@example.com' });
    expect(load().pushSubject).toBe('mailto:owner@example.com');
    writeConfigFile({ pushSubject: 'https://studio.example.com/contact' });
    expect(load().pushSubject).toBe('https://studio.example.com/contact');
  });

  it('rejects what is neither an email nor an https address', () => {
    writeConfigFile({ pushSubject: 'owner' });
    expect(() => load()).toThrow(/pushSubject/);
    writeConfigFile({ pushSubject: 'http://studio.example.com' });
    expect(() => load()).toThrow(/pushSubject/);
  });
});

describe('jobSheet (the Job sheet switch)', () => {
  it('is on by default', () => {
    expect(load().jobSheet).toBe(true);
  });

  it('can be turned off in config.json', () => {
    writeConfigFile({ jobSheet: false });
    expect(load().jobSheet).toBe(false);
  });

  it('is off for STUDIO_JOB_SHEET 0 and false, on for 1 and true, and the environment wins', () => {
    for (const off of ['0', 'false', 'FALSE'])
      expect(load({ STUDIO_JOB_SHEET: off }).jobSheet, off).toBe(false);
    writeConfigFile({ jobSheet: false });
    for (const on of ['1', 'true']) {
      expect(load({ STUDIO_JOB_SHEET: on }).jobSheet, on).toBe(true);
    }
    expect(load({ STUDIO_JOB_SHEET: '' }).jobSheet).toBe(false);
  });

  it('does not move with the Series switch', () => {
    expect(load({ STUDIO_SERIES: '0' }).jobSheet).toBe(true);
    expect(load({ STUDIO_JOB_SHEET: '0' }).series).toBe(true);
  });

  it('rejects anything else, in the environment and in config.json', () => {
    expect(() => load({ STUDIO_JOB_SHEET: 'on' })).toThrow(
      /STUDIO_JOB_SHEET.*must be 1, 0, true or false/,
    );
    writeConfigFile({ jobSheet: 'true' });
    expect(() => load()).toThrow(/jobSheet/);
  });
});

describe('analytics (the Analytics switch)', () => {
  it('is on by default', () => {
    expect(load().analytics).toBe(true);
  });

  it('can be turned off in config.json', () => {
    writeConfigFile({ analytics: false });
    expect(load().analytics).toBe(false);
  });

  it('is on for STUDIO_ANALYTICS 1 and true, off for 0 and false, and the environment wins', () => {
    for (const on of ['1', 'true', 'TRUE'])
      expect(load({ STUDIO_ANALYTICS: on }).analytics, on).toBe(true);
    for (const off of ['0', 'false', 'FALSE'])
      expect(load({ STUDIO_ANALYTICS: off }).analytics, off).toBe(false);
    // Over config.json, both ways.
    writeConfigFile({ analytics: true });
    for (const off of ['0', 'false']) {
      expect(load({ STUDIO_ANALYTICS: off }).analytics, off).toBe(false);
    }
    writeConfigFile({ analytics: false });
    expect(load({ STUDIO_ANALYTICS: '1' }).analytics).toBe(true);
    // An empty variable says nothing: config.json decides.
    expect(load({ STUDIO_ANALYTICS: '' }).analytics).toBe(false);
  });

  it('does not move with the Series or Job sheet switches, nor they with it', () => {
    expect(load({ STUDIO_SERIES: '1', STUDIO_JOB_SHEET: '1' }).analytics).toBe(true);
    const analyticsOff = load({ STUDIO_ANALYTICS: '0' });
    expect(analyticsOff.series).toBe(true);
    expect(analyticsOff.jobSheet).toBe(true);
    expect(analyticsOff.review).toBe(true);
  });

  it('rejects anything else, in the environment and in config.json', () => {
    expect(() => load({ STUDIO_ANALYTICS: 'on' })).toThrow(
      /STUDIO_ANALYTICS.*must be 1, 0, true or false/,
    );
    writeConfigFile({ analytics: 'true' });
    expect(() => load()).toThrow(/analytics/);
  });
});

describe('phone (the Phone switch)', () => {
  it('is on by default', () => {
    expect(load().phone).toBe(true);
  });

  it('can be turned off in config.json', () => {
    writeConfigFile({ phone: false });
    expect(load().phone).toBe(false);
  });

  it('is off for STUDIO_PHONE 0 and false, on for 1 and true, and the environment wins', () => {
    for (const off of ['0', 'false', 'FALSE']) {
      expect(load({ STUDIO_PHONE: off }).phone, off).toBe(false);
    }
    writeConfigFile({ phone: false });
    for (const on of ['1', 'true']) expect(load({ STUDIO_PHONE: on }).phone, on).toBe(true);
    expect(load({ STUDIO_PHONE: '' }).phone).toBe(false);
  });

  it('does not move with the Series, Job sheet or Analytics switches', () => {
    expect(load({ STUDIO_SERIES: '0', STUDIO_JOB_SHEET: '1', STUDIO_ANALYTICS: '1' }).phone).toBe(
      true,
    );
    expect(load({ STUDIO_PHONE: '0' }).series).toBe(true);
    expect(load({ STUDIO_PHONE: '0' }).jobSheet).toBe(true);
    expect(load({ STUDIO_PHONE: '0' }).analytics).toBe(true);
  });

  it('rejects anything else, in the environment and in config.json', () => {
    expect(() => load({ STUDIO_PHONE: 'on' })).toThrow(/STUDIO_PHONE.*must be 1, 0, true or false/);
    writeConfigFile({ phone: 'true' });
    expect(() => load()).toThrow(/phone/);
  });
});

describe('graphics and graphicsInEdits (the Graphics switches)', () => {
  it('are both on by default', () => {
    expect(load()).toMatchObject({ graphics: true, graphicsInEdits: true });
  });

  it('can each be turned off in config.json, and the other stays on', () => {
    writeConfigFile({ graphicsInEdits: false });
    expect(load()).toMatchObject({ graphics: true, graphicsInEdits: false });
    writeConfigFile({ graphics: false, graphicsInEdits: true });
    expect(load()).toMatchObject({ graphics: false, graphicsInEdits: true });
  });

  it('are off for 0 and false, on for 1 and true, and the environment wins', () => {
    for (const off of ['0', 'false', 'FALSE']) {
      expect(load({ STUDIO_GRAPHICS: off }).graphics, off).toBe(false);
      expect(load({ STUDIO_GRAPHICS_IN_EDITS: off }).graphicsInEdits, off).toBe(false);
    }
    writeConfigFile({ graphics: false, graphicsInEdits: false });
    for (const on of ['1', 'true', 'TRUE']) {
      expect(load({ STUDIO_GRAPHICS: on }).graphics, on).toBe(true);
      expect(load({ STUDIO_GRAPHICS_IN_EDITS: on }).graphicsInEdits, on).toBe(true);
    }
    expect(load({ STUDIO_GRAPHICS: '' }).graphics).toBe(false);
    expect(load({ STUDIO_GRAPHICS_IN_EDITS: '' }).graphicsInEdits).toBe(false);
  });

  it('move apart from each other and from the other switches', () => {
    expect(load({ STUDIO_GRAPHICS: '0' }).graphicsInEdits).toBe(true);
    expect(load({ STUDIO_GRAPHICS_IN_EDITS: '0' }).graphics).toBe(true);
    expect(load({ STUDIO_GRAPHICS_IN_EDITS: '0' })).toMatchObject({
      series: true,
      jobSheet: true,
      analytics: true,
      phone: true,
    });
  });

  it('reject anything else, in the environment and in config.json', () => {
    expect(() => load({ STUDIO_GRAPHICS: 'on' })).toThrow(
      /STUDIO_GRAPHICS.*must be 1, 0, true or false/,
    );
    expect(() => load({ STUDIO_GRAPHICS_IN_EDITS: 'yes' })).toThrow(
      /STUDIO_GRAPHICS_IN_EDITS.*must be 1, 0, true or false/,
    );
    writeConfigFile({ graphics: 'true' });
    expect(() => load()).toThrow(/graphics/);
  });
});

describe('music (the Soundtrack switch)', () => {
  it('is on by default (U22)', () => {
    expect(load().music).toBe(true);
  });

  it('can be turned off in config.json', () => {
    writeConfigFile({ music: false });
    expect(load().music).toBe(false);
  });

  it('is on for 1 and true, off for 0 and false, and the environment wins', () => {
    writeConfigFile({ music: false });
    for (const on of ['1', 'true', 'TRUE']) {
      expect(load({ STUDIO_MUSIC: on }).music, on).toBe(true);
    }
    writeConfigFile({ music: true });
    for (const off of ['0', 'false', 'FALSE']) {
      expect(load({ STUDIO_MUSIC: off }).music, off).toBe(false);
    }
    // An empty value counts as unset, so config.json decides.
    expect(load({ STUDIO_MUSIC: '' }).music).toBe(true);
    writeConfigFile({ music: false });
    expect(load({ STUDIO_MUSIC: '' }).music).toBe(false);
  });

  it('is turned off by STUDIO_MUSIC=0 alone', () => {
    expect(load({ STUDIO_MUSIC: '0' }).music).toBe(false);
  });

  it('moves apart from the other switches', () => {
    expect(load({ STUDIO_MUSIC: '0' })).toMatchObject({
      review: true,
      series: true,
      jobSheet: true,
      analytics: true,
      phone: true,
      graphics: true,
      graphicsInEdits: true,
    });
  });

  it('rejects anything else, in the environment and in config.json', () => {
    expect(() => load({ STUDIO_MUSIC: 'on' })).toThrow(/STUDIO_MUSIC.*must be 1, 0, true or false/);
    writeConfigFile({ music: 'true' });
    expect(() => load()).toThrow(/music/);
  });
});

describe('stock (the Stock media switch)', () => {
  it('is off by default', () => {
    expect(load().stock).toBe(false);
  });

  it('can be turned on in config.json', () => {
    writeConfigFile({ stock: true });
    expect(load().stock).toBe(true);
  });

  it('is on for 1 and true, off for 0 and false, and the environment wins', () => {
    for (const on of ['1', 'true', 'TRUE']) {
      expect(load({ STUDIO_STOCK: on }).stock, on).toBe(true);
    }
    writeConfigFile({ stock: true });
    for (const off of ['0', 'false', 'FALSE']) {
      expect(load({ STUDIO_STOCK: off }).stock, off).toBe(false);
    }
    expect(load({ STUDIO_STOCK: '' }).stock).toBe(true);
  });

  it('does not move the music switch', () => {
    expect(load({ STUDIO_STOCK: '1' })).toMatchObject({ music: true, songs: true });
  });

  it('rejects anything else, in the environment and in config.json', () => {
    expect(() => load({ STUDIO_STOCK: 'on' })).toThrow(/STUDIO_STOCK.*must be 1, 0, true or false/);
    writeConfigFile({ stock: 'true' });
    expect(() => load()).toThrow(/stock/);
  });
});

describe('luts and lutsInEdits (the LUTs switches)', () => {
  it('luts and lutsInEdits are both on by default', () => {
    expect(load()).toMatchObject({ luts: true, lutsInEdits: true });
  });

  it('can each be set in config.json, and the other stays as it was', () => {
    writeConfigFile({ luts: false });
    expect(load()).toMatchObject({ luts: false, lutsInEdits: true });
    writeConfigFile({ luts: true, lutsInEdits: false });
    expect(load()).toMatchObject({ luts: true, lutsInEdits: false });
    writeConfigFile({ luts: false, lutsInEdits: true });
    expect(load()).toMatchObject({ luts: false, lutsInEdits: true });
  });

  it('are on for 1 and true, off for 0 and false, and the environment wins', () => {
    for (const on of ['1', 'true', 'TRUE']) {
      expect(load({ STUDIO_LUTS: on }).luts, on).toBe(true);
      expect(load({ STUDIO_LUTS_IN_EDITS: on }).lutsInEdits, on).toBe(true);
    }
    for (const off of ['0', 'false', 'FALSE']) {
      expect(load({ STUDIO_LUTS: off }).luts, off).toBe(false);
    }
    writeConfigFile({ luts: true, lutsInEdits: true });
    for (const off of ['0', 'false', 'FALSE']) {
      expect(load({ STUDIO_LUTS: off }).luts, off).toBe(false);
      expect(load({ STUDIO_LUTS_IN_EDITS: off }).lutsInEdits, off).toBe(false);
    }
    expect(load({ STUDIO_LUTS: '' }).luts).toBe(true);
    expect(load({ STUDIO_LUTS_IN_EDITS: '' }).lutsInEdits).toBe(true);
  });

  it('move apart from each other and from the other switches', () => {
    expect(load({ STUDIO_LUTS: '1' }).lutsInEdits).toBe(true);
    expect(load({ STUDIO_LUTS_IN_EDITS: '0' }).luts).toBe(true);
    expect(load({ STUDIO_LUTS_IN_EDITS: '1' }).luts).toBe(true);
    expect(load({ STUDIO_LUTS: '0', STUDIO_LUTS_IN_EDITS: '1' })).toMatchObject({
      luts: false,
      lutsInEdits: true,
    });
    expect(load({ STUDIO_LUTS: '1', STUDIO_LUTS_IN_EDITS: '1' })).toMatchObject({
      series: true,
      jobSheet: true,
      analytics: true,
      phone: true,
      graphics: true,
      graphicsInEdits: true,
      music: true,
    });
  });

  it('reject anything else, in the environment and in config.json', () => {
    expect(() => load({ STUDIO_LUTS: 'on' })).toThrow(/STUDIO_LUTS.*must be 1, 0, true or false/);
    expect(() => load({ STUDIO_LUTS_IN_EDITS: 'yes' })).toThrow(
      /STUDIO_LUTS_IN_EDITS.*must be 1, 0, true or false/,
    );
    writeConfigFile({ luts: 'true' });
    expect(() => load()).toThrow(/luts/);
  });
});

describe('fonts and fontsInNotes (the Fonts switches)', () => {
  it('are both on by default', () => {
    expect(load()).toMatchObject({ fonts: true, fontsInNotes: true });
  });

  it('can each be turned off in config.json, and the other stays on', () => {
    writeConfigFile({ fonts: false });
    expect(load()).toMatchObject({ fonts: false, fontsInNotes: true });
    writeConfigFile({ fontsInNotes: false });
    expect(load()).toMatchObject({ fonts: true, fontsInNotes: false });
    writeConfigFile({ fonts: true, fontsInNotes: false });
    expect(load()).toMatchObject({ fonts: true, fontsInNotes: false });
    writeConfigFile({ fonts: false, fontsInNotes: false });
    expect(load()).toMatchObject({ fonts: false, fontsInNotes: false });
  });

  it('are off for 0 and false, on for 1 and true, and the environment wins', () => {
    for (const off of ['0', 'false', 'FALSE']) {
      expect(load({ STUDIO_FONTS: off }).fonts, off).toBe(false);
      expect(load({ STUDIO_FONTS_IN_NOTES: off }).fontsInNotes, off).toBe(false);
    }
    writeConfigFile({ fonts: false, fontsInNotes: false });
    for (const on of ['1', 'true', 'TRUE']) {
      expect(load({ STUDIO_FONTS: on }).fonts, on).toBe(true);
      expect(load({ STUDIO_FONTS_IN_NOTES: on }).fontsInNotes, on).toBe(true);
    }
    expect(load({ STUDIO_FONTS: '' }).fonts).toBe(false);
    expect(load({ STUDIO_FONTS_IN_NOTES: '' }).fontsInNotes).toBe(false);
  });

  it('move apart from each other and from the other switches', () => {
    // Turning Fonts off leaves the notes switch at its own value (it just does nothing then).
    expect(load({ STUDIO_FONTS: '0' })).toMatchObject({ fonts: false, fontsInNotes: true });
    expect(load({ STUDIO_FONTS_IN_NOTES: '0' })).toMatchObject({
      fonts: true,
      fontsInNotes: false,
    });
    expect(load({ STUDIO_FONTS: '0', STUDIO_FONTS_IN_NOTES: '0' })).toMatchObject({
      fonts: false,
      fontsInNotes: false,
    });
    expect(load({ STUDIO_FONTS_IN_NOTES: '0' })).toMatchObject({
      series: true,
      jobSheet: true,
      analytics: true,
      phone: true,
      graphics: true,
      graphicsInEdits: true,
      music: true,
      luts: true,
      lutsInEdits: true,
    });
  });

  it('reject anything else, in the environment and in config.json', () => {
    expect(() => load({ STUDIO_FONTS: 'on' })).toThrow(/STUDIO_FONTS.*must be 1, 0, true or false/);
    expect(() => load({ STUDIO_FONTS_IN_NOTES: 'yes' })).toThrow(
      /STUDIO_FONTS_IN_NOTES.*must be 1, 0, true or false/,
    );
    writeConfigFile({ fonts: 'true' });
    expect(() => load()).toThrow(/fonts/);
  });
});

describe('quickFixes (the Quick fixes switch)', () => {
  it('is on by default', () => {
    expect(load().quickFixes).toBe(true);
  });

  it('can be turned off in config.json', () => {
    writeConfigFile({ quickFixes: false });
    expect(load().quickFixes).toBe(false);
    writeConfigFile({ quickFixes: true });
    expect(load().quickFixes).toBe(true);
  });

  it('is on for 1 and true, off for 0 and false, and the environment wins', () => {
    for (const on of ['1', 'true', 'TRUE']) {
      expect(load({ STUDIO_QUICK_FIXES: on }).quickFixes, on).toBe(true);
    }
    for (const off of ['0', 'false', 'FALSE']) {
      expect(load({ STUDIO_QUICK_FIXES: off }).quickFixes, off).toBe(false);
    }
    writeConfigFile({ quickFixes: true });
    expect(load({ STUDIO_QUICK_FIXES: '0' }).quickFixes).toBe(false);
    writeConfigFile({ quickFixes: false });
    expect(load({ STUDIO_QUICK_FIXES: '1' }).quickFixes).toBe(true);
    // An empty value counts as unset, so config.json decides.
    writeConfigFile({ quickFixes: true });
    expect(load({ STUDIO_QUICK_FIXES: '' }).quickFixes).toBe(true);
  });

  it('moves apart from the other switches', () => {
    expect(load({ STUDIO_QUICK_FIXES: '1' })).toMatchObject({
      review: true,
      series: true,
      jobSheet: true,
      analytics: true,
      phone: true,
      graphics: true,
      graphicsInEdits: true,
      music: true,
      luts: true,
      lutsInEdits: true,
      fonts: true,
      fontsInNotes: true,
    });
  });

  it('rejects anything else, in the environment and in config.json', () => {
    expect(() => load({ STUDIO_QUICK_FIXES: 'on' })).toThrow(
      /STUDIO_QUICK_FIXES.*must be 1, 0, true or false/,
    );
    writeConfigFile({ quickFixes: 'true' });
    expect(() => load()).toThrow(/quickFixes/);
  });
});

describe('claudePlanOnly (the Claude billing switch)', () => {
  it('is on by default: Claude runs use the plan login only', () => {
    expect(load().claudePlanOnly).toBe(true);
  });

  it('can be turned off in config.json', () => {
    writeConfigFile({ claudePlanOnly: false });
    expect(load().claudePlanOnly).toBe(false);
    writeConfigFile({ claudePlanOnly: true });
    expect(load().claudePlanOnly).toBe(true);
  });

  it('is on for 1 and true, off for 0 and false, and the environment wins', () => {
    for (const on of ['1', 'true', 'TRUE']) {
      expect(load({ STUDIO_CLAUDE_PLAN_ONLY: on }).claudePlanOnly, on).toBe(true);
    }
    for (const off of ['0', 'false', 'FALSE']) {
      expect(load({ STUDIO_CLAUDE_PLAN_ONLY: off }).claudePlanOnly, off).toBe(false);
    }
    writeConfigFile({ claudePlanOnly: true });
    expect(load({ STUDIO_CLAUDE_PLAN_ONLY: '0' }).claudePlanOnly).toBe(false);
    writeConfigFile({ claudePlanOnly: false });
    expect(load({ STUDIO_CLAUDE_PLAN_ONLY: '1' }).claudePlanOnly).toBe(true);
    // An empty value counts as unset, so config.json decides.
    expect(load({ STUDIO_CLAUDE_PLAN_ONLY: '' }).claudePlanOnly).toBe(false);
  });

  it('moves apart from the other switches', () => {
    expect(load({ STUDIO_CLAUDE_PLAN_ONLY: '0' })).toMatchObject({
      review: true,
      graphics: true,
      fonts: true,
      luts: true,
      quickFixes: true,
      claudePlanOnly: false,
    });
  });

  it('rejects anything else, in the environment and in config.json', () => {
    expect(() => load({ STUDIO_CLAUDE_PLAN_ONLY: 'off' })).toThrow(
      /STUDIO_CLAUDE_PLAN_ONLY.*must be 1, 0, true or false/,
    );
    writeConfigFile({ claudePlanOnly: 'false' });
    expect(() => load()).toThrow(/claudePlanOnly/);
  });
});

describe('songs (the Songs switch)', () => {
  /** loadConfig with a `log` that collects what it was told. */
  function loadWithLog(env: Record<string, string> = {}) {
    const lines: string[] = [];
    const config = loadConfig({ home, env, log: (line) => lines.push(line) });
    return { config, lines };
  }

  it('is on by default with music, with nothing to say (U22)', () => {
    const { config, lines } = loadWithLog();
    expect(config).toMatchObject({ songs: true, music: true });
    expect(lines).toEqual([]);
  });

  it('is off when music is off, and says nothing when songs was never set', () => {
    const fromEnv = loadWithLog({ STUDIO_MUSIC: '0' });
    expect(fromEnv.config).toMatchObject({ songs: false, music: false });
    expect(fromEnv.lines).toEqual([]);

    writeConfigFile({ music: false });
    const fromFile = loadWithLog();
    expect(fromFile.config).toMatchObject({ songs: false, music: false });
    expect(fromFile.lines).toEqual([]);
  });

  it('is off without music, even when asked for by name, and says so', () => {
    const fromEnv = loadWithLog({ STUDIO_SONGS: '1', STUDIO_MUSIC: '0' });
    expect(fromEnv.config.songs).toBe(false);
    expect(fromEnv.config.music).toBe(false);
    expect(fromEnv.lines).toHaveLength(1);
    expect(fromEnv.lines[0]).toMatch(/songs is on but music is off/);

    writeConfigFile({ songs: true, music: false });
    const fromFile = loadWithLog();
    expect(fromFile.config.songs).toBe(false);
    expect(fromFile.lines).toHaveLength(1);

    // Asked for with music turned off by the environment over config.json.
    writeConfigFile({ songs: true, music: true });
    const musicOff = loadWithLog({ STUDIO_MUSIC: '0' });
    expect(musicOff.config.songs).toBe(false);
    expect(musicOff.lines).toHaveLength(1);
  });

  it('stays quiet when songs is turned off with music', () => {
    const { config, lines } = loadWithLog({ STUDIO_SONGS: '0', STUDIO_MUSIC: '0' });
    expect(config).toMatchObject({ songs: false, music: false });
    expect(lines).toEqual([]);
  });

  it('asks for a log nobody gave without failing', () => {
    expect(load({ STUDIO_SONGS: '1', STUDIO_MUSIC: '0' }).songs).toBe(false);
  });

  it('is on with music on, whether asked for or left to the default', () => {
    const fromEnv = loadWithLog({ STUDIO_SONGS: '1', STUDIO_MUSIC: '1' });
    expect(fromEnv.config).toMatchObject({ songs: true, music: true });
    expect(fromEnv.lines).toEqual([]);

    writeConfigFile({ songs: true, music: true });
    expect(load().songs).toBe(true);
    writeConfigFile({ songs: true });
    expect(load({ STUDIO_MUSIC: 'true' }).songs).toBe(true);
    expect(loadWithLog({ STUDIO_MUSIC: '1' }).config).toMatchObject({ songs: true, music: true });
  });

  it('can be turned off alone, keeping music on', () => {
    expect(loadWithLog({ STUDIO_SONGS: '0' }).config).toMatchObject({ songs: false, music: true });
    writeConfigFile({ songs: false });
    expect(load()).toMatchObject({ songs: false, music: true });
  });

  it('is on for 1 and true, off for 0 and false, and the environment wins', () => {
    for (const on of ['1', 'true', 'TRUE']) {
      expect(load({ STUDIO_SONGS: on, STUDIO_MUSIC: '1' }).songs, on).toBe(true);
    }
    for (const off of ['0', 'false', 'FALSE']) {
      expect(load({ STUDIO_SONGS: off, STUDIO_MUSIC: '1' }).songs, off).toBe(false);
    }
    writeConfigFile({ songs: true, music: true });
    expect(load({ STUDIO_SONGS: '0' }).songs).toBe(false);
    writeConfigFile({ songs: false, music: true });
    expect(load({ STUDIO_SONGS: '1' }).songs).toBe(true);
    // An empty value counts as unset, so config.json decides.
    writeConfigFile({ songs: true, music: true });
    expect(load({ STUDIO_SONGS: '' }).songs).toBe(true);
    writeConfigFile({ songs: false, music: true });
    expect(load({ STUDIO_SONGS: '' }).songs).toBe(false);
  });

  it('rejects anything else, in the environment and in config.json', () => {
    expect(() => load({ STUDIO_SONGS: 'on' })).toThrow(/STUDIO_SONGS.*must be 1, 0, true or false/);
    writeConfigFile({ songs: 'true' });
    expect(() => load()).toThrow(/songs/);
  });

  it('moves apart from the other switches', () => {
    expect(load({ STUDIO_SONGS: '0', STUDIO_MUSIC: '0' })).toMatchObject({
      review: true,
      series: true,
      quickFixes: true,
      lutsInEdits: true,
      music: false,
      songs: false,
    });
  });
});

describe('songTools (the programs Songs runs)', () => {
  it('are the Homebrew paths by default: launchd has no Homebrew PATH', () => {
    expect(load().songTools).toEqual({
      ytDlp: '/opt/homebrew/bin/yt-dlp',
      deno: '/opt/homebrew/bin/deno',
    });
  });

  it('can each be set in the environment, keeping the other’s default', () => {
    expect(load({ STUDIO_YT_DLP: '/usr/local/bin/yt-dlp' }).songTools).toEqual({
      ytDlp: '/usr/local/bin/yt-dlp',
      deno: '/opt/homebrew/bin/deno',
    });
    expect(load({ STUDIO_DENO: '~/bin/deno' }).songTools).toEqual({
      ytDlp: '/opt/homebrew/bin/yt-dlp',
      deno: join(home, 'bin', 'deno'),
    });
    expect(load({ STUDIO_YT_DLP: '/a/yt-dlp', STUDIO_DENO: '/b/deno' }).songTools).toEqual({
      ytDlp: '/a/yt-dlp',
      deno: '/b/deno',
    });
  });

  it('count an empty value as unset, and refuse a path that is not absolute', () => {
    expect(load({ STUDIO_YT_DLP: '' }).songTools.ytDlp).toBe('/opt/homebrew/bin/yt-dlp');
    expect(() => load({ STUDIO_YT_DLP: 'yt-dlp' })).toThrow(/STUDIO_YT_DLP.*absolute/);
    expect(() => load({ STUDIO_DENO: 'deno' })).toThrow(/STUDIO_DENO.*absolute/);
  });

  it('are not a config.json setting', () => {
    writeConfigFile({ songTools: { ytDlp: '/x' } });
    expect(() => load()).toThrow(/songTools/);
  });

  it('gives each load its own object', () => {
    const first = load().songTools;
    first.ytDlp = '/changed';
    expect(load().songTools.ytDlp).toBe('/opt/homebrew/bin/yt-dlp');
  });
});

describe('APIFY_TOKEN_ENV', () => {
  it('is the name of the key, and only the name', () => {
    expect(APIFY_TOKEN_ENV).toBe('APIFY_TOKEN');
  });
});

describe('runTimeoutMin', () => {
  it('defaults to 90 minutes', () => {
    expect(load().runTimeoutMin).toBe(90);
  });

  it('can be set in config.json, and STUDIO_RUN_TIMEOUT_MIN wins over it', () => {
    writeConfigFile({ runTimeoutMin: 120 });
    expect(load().runTimeoutMin).toBe(120);
    expect(load({ STUDIO_RUN_TIMEOUT_MIN: '45' }).runTimeoutMin).toBe(45);
  });

  it('rejects zero, fractions, text and absurd values, naming where they came from', () => {
    expect(() => load({ STUDIO_RUN_TIMEOUT_MIN: '0' })).toThrow(/STUDIO_RUN_TIMEOUT_MIN/);
    expect(() => load({ STUDIO_RUN_TIMEOUT_MIN: '1.5' })).toThrow(/STUDIO_RUN_TIMEOUT_MIN/);
    expect(() => load({ STUDIO_RUN_TIMEOUT_MIN: 'ninety' })).toThrow(/whole number/);
    expect(() => load({ STUDIO_RUN_TIMEOUT_MIN: '9000000' })).toThrow(ConfigError);
    writeConfigFile({ runTimeoutMin: 2.5 });
    expect(() => load()).toThrow(/runTimeoutMin/);
    writeConfigFile({ runTimeoutMin: '90' });
    expect(() => load()).toThrow(/runTimeoutMin/);
  });
});

describe('runner', () => {
  it('defaults to the real claude runner', () => {
    expect(load().runner).toBe('claude');
  });

  it('can be set to fake in config.json', () => {
    writeConfigFile({ runner: 'fake' });

    expect(load().runner).toBe('fake');
  });

  it('can be set with STUDIO_RUNNER, which wins over config.json', () => {
    writeConfigFile({ runner: 'fake' });

    expect(load({ STUDIO_RUNNER: 'claude' }).runner).toBe('claude');
    expect(load({ STUDIO_RUNNER: 'fake' }).runner).toBe('fake');
  });

  it('rejects any other runner, naming where it came from', () => {
    expect(() => load({ STUDIO_RUNNER: 'gpt' })).toThrow(ConfigError);
    expect(() => load({ STUDIO_RUNNER: 'gpt' })).toThrow(/STUDIO_RUNNER.*claude or fake/);
    writeConfigFile({ runner: 'FAKE' });
    expect(() => load()).toThrow(/runner.*claude or fake/);
  });
});

describe('derived paths', () => {
  it('follow an overridden inbox and data dir', () => {
    const config = load({
      STUDIO_INBOX: join(home, 'Clips'),
      STUDIO_DATA_DIR: join(home, 'data'),
    });

    expect(config.exportsDir).toBe(join(home, 'Clips', '_Exports'));
    expect(config.dbPath).toBe(join(home, 'data', 'engine.db'));
    expect(config.logsDir).toBe(join(home, 'data', 'logs'));
  });

  it('keep an explicit exportsDir from config.json when the inbox moves', () => {
    writeConfigFile({ exportsDir: join(home, 'Exports') });

    const config = load({ STUDIO_INBOX: join(home, 'Clips') });

    expect(config.exportsDir).toBe(join(home, 'Exports'));
  });

  it('prefer an env exportsDir over a config.json exportsDir', () => {
    writeConfigFile({ exportsDir: join(home, 'FromFile') });

    const config = load({ STUDIO_EXPORTS_DIR: join(home, 'FromEnv') });

    expect(config.exportsDir).toBe(join(home, 'FromEnv'));
  });

  it('prefer an explicit dbPath and logsDir over the data dir', () => {
    const config = load({
      STUDIO_DATA_DIR: join(home, 'data'),
      STUDIO_DB_PATH: join(home, 'elsewhere', 'db.sqlite'),
      STUDIO_LOGS_DIR: join(home, 'logs'),
    });

    expect(config.dbPath).toBe(join(home, 'elsewhere', 'db.sqlite'));
    expect(config.logsDir).toBe(join(home, 'logs'));
  });
});

describe('path handling', () => {
  it('expands ~ in config.json and env paths', () => {
    writeConfigFile({ inboxPath: '~/Clips' });

    const config = load({ STUDIO_DATA_DIR: '~/data' });

    expect(config.inboxPath).toBe(join(home, 'Clips'));
    expect(config.dataDir).toBe(join(home, 'data'));
  });

  it('expands ~ in claudeBin but leaves a bare command name alone', () => {
    expect(load({ STUDIO_CLAUDE_BIN: '~/.local/bin/claude' }).claudeBin).toBe(
      join(home, '.local', 'bin', 'claude'),
    );
    expect(load({ STUDIO_CLAUDE_BIN: 'claude' }).claudeBin).toBe('claude');
  });

  it('expandHome only touches a leading ~', () => {
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~/x/y', '/h')).toBe('/h/x/y');
    expect(expandHome('/abs/~/x', '/h')).toBe('/abs/~/x');
    expect(expandHome('~other/x', '/h')).toBe('~other/x');
  });
});

describe('validation', () => {
  it('names the env variable for a non-numeric port', () => {
    expect(() => load({ STUDIO_PORT: 'abc' })).toThrow(ConfigError);
    expect(() => load({ STUDIO_PORT: 'abc' })).toThrow(/STUDIO_PORT/);
  });

  it('rejects ports outside 1 to 65535', () => {
    expect(() => load({ STUDIO_PORT: '0' })).toThrow(/STUDIO_PORT/);
    expect(() => load({ STUDIO_PORT: '70000' })).toThrow(/STUDIO_PORT/);
    writeConfigFile({ port: 70000 });
    expect(() => load()).toThrow(ConfigError);
  });

  it('rejects unknown keys in config.json so typos are not ignored', () => {
    writeConfigFile({ prot: 4000 });

    expect(() => load()).toThrow(/prot/);
  });

  it('names config.json when it is not valid JSON', () => {
    writeConfigFile('{ not json');

    expect(() => load()).toThrow(/config\.json.*JSON/);
  });

  it('rejects a wrong type in config.json', () => {
    writeConfigFile({ port: '4310' });

    expect(() => load()).toThrow(ConfigError);
  });

  it('rejects a relative path once ~ is expanded', () => {
    expect(() => load({ STUDIO_INBOX: 'Studio Inbox' })).toThrow(/absolute path/);
    expect(() => load({ STUDIO_INBOX: '~user/Clips' })).toThrow(/absolute path/);
  });

  it('rejects a non-loopback host, so the server never binds 0.0.0.0', () => {
    expect(() => load({ STUDIO_HOST: '0.0.0.0' })).toThrow(/STUDIO_HOST/);
    writeConfigFile({ host: '192.168.1.5' });
    expect(() => load()).toThrow(ConfigError);
  });

  it('accepts each loopback host', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(load({ STUDIO_HOST: host }).host).toBe(host);
    }
  });

  it('rejects a negative or fractional settleMs', () => {
    expect(() => load({ STUDIO_SETTLE_MS: '-1' })).toThrow(/STUDIO_SETTLE_MS/);
    expect(() => load({ STUDIO_SETTLE_MS: '1.5' })).toThrow(/STUDIO_SETTLE_MS/);
  });

  it('reports every problem in one error', () => {
    writeConfigFile({ prot: 1 });

    let caught: unknown;
    try {
      load({ STUDIO_PORT: 'x', STUDIO_SETTLE_MS: '-1' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).issues).toHaveLength(3);
  });
});

describe('ensureDirs', () => {
  it('creates the inbox, _Exports, data and logs folders', () => {
    const config = load();

    ensureDirs(config);

    expect(statSync(join(home, 'Studio Inbox', '_Exports')).isDirectory()).toBe(true);
    expect(statSync(join(home, '.studio-engine', 'logs')).isDirectory()).toBe(true);
  });

  it('creates overridden folders, not the defaults', () => {
    const config = load({
      STUDIO_INBOX: join(home, 'Clips'),
      STUDIO_DATA_DIR: join(home, 'data'),
    });

    ensureDirs(config);

    expect(existsSync(join(home, 'Clips', '_Exports'))).toBe(true);
    expect(existsSync(join(home, 'data', 'logs'))).toBe(true);
    expect(existsSync(join(home, 'Studio Inbox'))).toBe(false);
  });

  it('is safe to run on every boot', () => {
    const config = load();

    ensureDirs(config);

    expect(() => ensureDirs(config)).not.toThrow();
  });

  it('writes no config file or database', () => {
    const config = load();

    ensureDirs(config);

    expect(existsSync(join(home, '.studio-engine', 'config.json'))).toBe(false);
    expect(existsSync(config.dbPath)).toBe(false);
  });
});

describe('generate (the Generated videos switch)', () => {
  it('is on by default', () => {
    expect(load().generate).toBe(true);
  });

  it('is on for 1 and true, off for 0 and false, in the environment and in config.json', () => {
    for (const on of ['1', 'true', 'TRUE']) {
      expect(load({ STUDIO_GENERATE: on }).generate, on).toBe(true);
    }
    for (const off of ['0', 'false', 'FALSE']) {
      expect(load({ STUDIO_GENERATE: off }).generate, off).toBe(false);
    }
    writeConfigFile({ generate: true });
    expect(load().generate).toBe(true);
    // The environment wins over the file, and an empty value counts as unset.
    expect(load({ STUDIO_GENERATE: '0' }).generate).toBe(false);
    expect(load({ STUDIO_GENERATE: '' }).generate).toBe(true);
    writeConfigFile({ generate: false });
    expect(load({ STUDIO_GENERATE: '1' }).generate).toBe(true);
  });

  it('rejects anything else, in the environment and in config.json', () => {
    expect(() => load({ STUDIO_GENERATE: 'yes' })).toThrow(
      /STUDIO_GENERATE.*must be 1, 0, true or false/,
    );
    writeConfigFile({ generate: 'true' });
    expect(() => load()).toThrow(/generate/);
  });

  it('does not need music, and does not move the other switches', () => {
    expect(load({ STUDIO_GENERATE: '1', STUDIO_MUSIC: '0' })).toMatchObject({
      generate: true,
      music: false,
      songs: false,
      review: true,
      quickFixes: true,
    });
    expect(load({ STUDIO_GENERATE: '1' })).toMatchObject({ generate: true, music: true });
  });
});

describe('generateBudgetUsd (what one generated video may spend)', () => {
  it('is $5 by default (Kling 3.0 on the plan’s credits: a 35 s pass is about $3)', () => {
    expect(load().generateBudgetUsd).toBe(5);
  });

  it('can be set in config.json and in the environment, which wins', () => {
    writeConfigFile({ generateBudgetUsd: 4.5 });
    expect(load().generateBudgetUsd).toBe(4.5);
    expect(load({ STUDIO_GENERATE_BUDGET_USD: '5' }).generateBudgetUsd).toBe(5);
    expect(load({ STUDIO_GENERATE_BUDGET_USD: '2.25' }).generateBudgetUsd).toBe(2.25);
    expect(load({ STUDIO_GENERATE_BUDGET_USD: '' }).generateBudgetUsd).toBe(4.5);
  });

  it('must be above 0', () => {
    expect(() => load({ STUDIO_GENERATE_BUDGET_USD: '0' })).toThrow(
      /STUDIO_GENERATE_BUDGET_USD.*above 0/,
    );
    expect(() => load({ STUDIO_GENERATE_BUDGET_USD: '0.0' })).toThrow(/above 0/);
    writeConfigFile({ generateBudgetUsd: 0 });
    expect(() => load()).toThrow(/generateBudgetUsd.*above 0/);
    writeConfigFile({ generateBudgetUsd: -1 });
    expect(() => load()).toThrow(/generateBudgetUsd/);
  });

  it('must be a number of dollars', () => {
    expect(() => load({ STUDIO_GENERATE_BUDGET_USD: '$5' })).toThrow(/number of dollars/);
    expect(() => load({ STUDIO_GENERATE_BUDGET_USD: '1e3' })).toThrow(/number of dollars/);
    expect(() => load({ STUDIO_GENERATE_BUDGET_USD: '-3' })).toThrow(/number of dollars/);
    writeConfigFile({ generateBudgetUsd: '5' });
    expect(() => load()).toThrow(/generateBudgetUsd/);
  });
});

describe('generateUsdPerCredit (what a Higgsfield plan credit is worth)', () => {
  it('is $0.056 by default, the 1,000 credit pack', () => {
    expect(load().generateUsdPerCredit).toBe(0.056);
  });

  it('can be set in config.json and in the environment, which wins', () => {
    writeConfigFile({ generateUsdPerCredit: 0.049 });
    expect(load().generateUsdPerCredit).toBe(0.049);
    expect(load({ STUDIO_GENERATE_USD_PER_CREDIT: '0.039' }).generateUsdPerCredit).toBe(0.039);
    expect(load({ STUDIO_GENERATE_USD_PER_CREDIT: '' }).generateUsdPerCredit).toBe(0.049);
  });

  it('must be above 0', () => {
    expect(() => load({ STUDIO_GENERATE_USD_PER_CREDIT: '0' })).toThrow(/above 0/);
    writeConfigFile({ generateUsdPerCredit: 0 });
    expect(() => load()).toThrow(/generateUsdPerCredit.*above 0/);
  });
});

describe('generateVoiceId (the ElevenLabs voice of a generated video)', () => {
  it('is Kal Jones by default', () => {
    expect(load().generateVoiceId).toBe('68RUZBDjLe2YBQvv8zFx');
    expect(load().generateVoiceId).toBe(DEFAULT_GENERATE_VOICE_ID);
  });

  it('can be set in config.json and in the environment, which wins', () => {
    writeConfigFile({ generateVoiceId: 'JBFqnCBsd6RMkjVDRZzb' });
    expect(load().generateVoiceId).toBe('JBFqnCBsd6RMkjVDRZzb');
    expect(load({ STUDIO_GENERATE_VOICE_ID: ' onwK4e9ZLuTAKqWW03F9 ' }).generateVoiceId).toBe(
      'onwK4e9ZLuTAKqWW03F9',
    );
    expect(load({ STUDIO_GENERATE_VOICE_ID: '' }).generateVoiceId).toBe('JBFqnCBsd6RMkjVDRZzb');
  });

  it('must look like a voice id', () => {
    expect(() => load({ STUDIO_GENERATE_VOICE_ID: 'not a voice' })).toThrow(
      /STUDIO_GENERATE_VOICE_ID.*voice id/,
    );
    expect(() => load({ STUDIO_GENERATE_VOICE_ID: '../x' })).toThrow(/voice id/);
    writeConfigFile({ generateVoiceId: 'x' });
    expect(() => load()).toThrow(/generateVoiceId.*voice id/);
    writeConfigFile({ generateVoiceId: 7 });
    expect(() => load()).toThrow(/generateVoiceId/);
  });
});

describe('the keys of Generated videos', () => {
  it('name the Higgsfield key and the env file, and never carry a value', () => {
    expect(HIGGSFIELD_API_KEY_ENV).toBe('HIGGSFIELD_API_KEY');
    expect(ENV_FILE_ENV).toBe('STUDIO_ENV_FILE');
    const config = load({ HIGGSFIELD_API_KEY: 'id:secret-value', STUDIO_ENV_FILE: '/x/.env' });
    expect(JSON.stringify(config)).not.toContain('secret-value');
    expect(Object.keys(config)).not.toContain('higgsfieldApiKey');
  });

  it('are not config.json settings', () => {
    writeConfigFile({ higgsfieldApiKey: 'id:secret' });
    expect(() => load()).toThrow(/higgsfieldApiKey/);
  });
});

describe('envFilePath (where the repo’s .env is)', () => {
  it('is the .env at the root of the repo by default, whatever folder the server starts in', () => {
    const path = envFilePath({}, home);
    expect(path.endsWith('/.env')).toBe(true);
    expect(path.startsWith('/')).toBe(true);
    // apps/server/src/config.ts is three folders below the root.
    expect(path).toBe(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env'));
  });

  it('is STUDIO_ENV_FILE when that is an absolute path or starts with ~/', () => {
    expect(envFilePath({ STUDIO_ENV_FILE: '/tmp/scratch/.env' }, home)).toBe('/tmp/scratch/.env');
    expect(envFilePath({ STUDIO_ENV_FILE: '~/keys/.env' }, home)).toBe(join(home, 'keys', '.env'));
  });

  it('ignores an empty or relative STUDIO_ENV_FILE, so a run is never given a path that moves', () => {
    const repo = envFilePath({}, home);
    expect(envFilePath({ STUDIO_ENV_FILE: '' }, home)).toBe(repo);
    expect(envFilePath({ STUDIO_ENV_FILE: '   ' }, home)).toBe(repo);
    expect(envFilePath({ STUDIO_ENV_FILE: '.env' }, home)).toBe(repo);
  });

  it('does not need the file to exist and never reads it', () => {
    const path = join(home, 'missing', '.env');
    expect(envFilePath({ STUDIO_ENV_FILE: path }, home)).toBe(path);
    expect(existsSync(path)).toBe(false);
  });
});
