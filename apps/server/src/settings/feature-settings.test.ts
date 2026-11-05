import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FeatureSettings, SettingsError } from './feature-settings.js';

let root: string;
let configPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-feature-settings-'));
  configPath = join(root, 'config.json');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ALL_ON = {
  graphics: true,
  fonts: true,
  luts: true,
  claudePlanOnly: true,
  draftChat: false,
  twoJobsAtOnce: true,
  quickFixes: true,
  instagram: true,
};

function settings(running = ALL_ON, env: Record<string, string | undefined> = {}) {
  return new FeatureSettings({ configPath, running, env });
}

const byKey = (features: ReturnType<FeatureSettings['read']>, key: string) =>
  features.find((feature) => feature.key === key);

describe('read', () => {
  it('has Draft & chat off and the rest on when there is no config.json', () => {
    expect(settings().read()).toEqual([
      { key: 'graphics', running: true, saved: true, lockedByEnv: false },
      { key: 'fonts', running: true, saved: true, lockedByEnv: false },
      { key: 'luts', running: true, saved: true, lockedByEnv: false },
      { key: 'claudePlanOnly', running: true, saved: true, lockedByEnv: false },
      { key: 'draftChat', running: false, saved: false, lockedByEnv: false },
      { key: 'twoJobsAtOnce', running: true, saved: true, lockedByEnv: false },
      { key: 'quickFixes', running: true, saved: true, lockedByEnv: false },
      { key: 'instagram', running: true, saved: true, lockedByEnv: false },
    ]);
  });

  it('reads Clients × Instagram from config.json and from STUDIO_INSTAGRAM', () => {
    writeFileSync(configPath, JSON.stringify({ instagram: false }));
    expect(byKey(settings().read(), 'instagram')).toEqual({
      key: 'instagram',
      running: true,
      saved: false,
      lockedByEnv: false,
    });
    const locked = settings({ ...ALL_ON, instagram: false }, { STUDIO_INSTAGRAM: '0' }).read();
    expect(byKey(locked, 'instagram')).toMatchObject({ running: false, lockedByEnv: true });
  });

  it('reads Two jobs at once from config.json and from STUDIO_TWO_JOBS_AT_ONCE', () => {
    writeFileSync(configPath, JSON.stringify({ twoJobsAtOnce: false }));
    expect(byKey(settings().read(), 'twoJobsAtOnce')).toEqual({
      key: 'twoJobsAtOnce',
      running: true,
      saved: false,
      lockedByEnv: false,
    });
    const locked = settings(ALL_ON, { STUDIO_TWO_JOBS_AT_ONCE: '0' }).read();
    expect(byKey(locked, 'twoJobsAtOnce')).toMatchObject({ saved: false, lockedByEnv: true });
  });

  it('reads Quick fixes from config.json and from STUDIO_QUICK_FIXES', () => {
    writeFileSync(configPath, JSON.stringify({ quickFixes: false }));
    expect(byKey(settings().read(), 'quickFixes')).toEqual({
      key: 'quickFixes',
      running: true,
      saved: false,
      lockedByEnv: false,
    });
    const locked = settings({ ...ALL_ON, quickFixes: false }, { STUDIO_QUICK_FIXES: '0' }).read();
    expect(byKey(locked, 'quickFixes')).toMatchObject({ running: false, lockedByEnv: true });
  });

  it('reads Draft & chat from config.json and from STUDIO_DRAFT_CHAT', () => {
    writeFileSync(configPath, JSON.stringify({ draftChat: true }));
    expect(byKey(settings().read(), 'draftChat')).toEqual({
      key: 'draftChat',
      running: false,
      saved: true,
      lockedByEnv: false,
    });
    const locked = settings({ ...ALL_ON, draftChat: true }, { STUDIO_DRAFT_CHAT: '1' }).read();
    expect(byKey(locked, 'draftChat')).toMatchObject({ running: true, lockedByEnv: true });
  });

  it('tells what config.json will do at the next boot apart from what runs now', () => {
    writeFileSync(configPath, JSON.stringify({ fonts: false }));
    const features = settings().read();
    expect(byKey(features, 'fonts')).toMatchObject({ running: true, saved: false });
    expect(byKey(features, 'graphics')).toMatchObject({ running: true, saved: true });
  });

  it('lets an environment variable beat config.json and locks the switch', () => {
    writeFileSync(configPath, JSON.stringify({ luts: true }));
    const features = settings({ ...ALL_ON, luts: false }, { STUDIO_LUTS: '0' }).read();
    expect(byKey(features, 'luts')).toEqual({
      key: 'luts',
      running: false,
      saved: false,
      lockedByEnv: true,
    });
  });

  it('reads Claude plan only from config.json and from STUDIO_CLAUDE_PLAN_ONLY', () => {
    writeFileSync(configPath, JSON.stringify({ claudePlanOnly: false }));
    expect(byKey(settings().read(), 'claudePlanOnly')).toEqual({
      key: 'claudePlanOnly',
      running: true,
      saved: false,
      lockedByEnv: false,
    });
    const locked = settings(
      { ...ALL_ON, claudePlanOnly: false },
      { STUDIO_CLAUDE_PLAN_ONLY: '0' },
    ).read();
    expect(byKey(locked, 'claudePlanOnly')).toEqual({
      key: 'claudePlanOnly',
      running: false,
      saved: false,
      lockedByEnv: true,
    });
  });

  it('treats an empty environment variable as unset', () => {
    expect(byKey(settings(ALL_ON, { STUDIO_FONTS: '' }).read(), 'fonts')?.lockedByEnv).toBe(false);
  });

  it('survives a config.json that cannot be read', () => {
    writeFileSync(configPath, '{ nope');
    // Each switch falls back to its default: on, except Draft & chat.
    expect(
      settings()
        .read()
        .map((feature) => feature.saved),
    ).toEqual([true, true, true, true, false, true, true, true]);
  });
});

describe('Which clients the Instagram scan reads (instagramClients)', () => {
  const clients = (
    running: 'active' | 'all' = 'active',
    env: Record<string, string | undefined> = {},
  ) => new FeatureSettings({ configPath, running: ALL_ON, instagramClients: running, env });

  it('is active when config.json says nothing, and when it says something that is not a choice', () => {
    expect(clients().readInstagramClients()).toEqual({
      running: 'active',
      saved: 'active',
      lockedByEnv: false,
    });
    writeFileSync(configPath, JSON.stringify({ instagramClients: 'some' }));
    expect(clients().readInstagramClients().saved).toBe('active');
    writeFileSync(configPath, '{ nope');
    expect(clients().readInstagramClients().saved).toBe('active');
  });

  it('reads config.json for the next boot apart from what runs now', () => {
    writeFileSync(configPath, JSON.stringify({ instagramClients: 'all' }));
    expect(clients('active').readInstagramClients()).toEqual({
      running: 'active',
      saved: 'all',
      lockedByEnv: false,
    });
  });

  it('lets STUDIO_INSTAGRAM_CLIENTS beat config.json and locks it', () => {
    writeFileSync(configPath, JSON.stringify({ instagramClients: 'all' }));
    expect(
      clients('active', { STUDIO_INSTAGRAM_CLIENTS: 'active' }).readInstagramClients(),
    ).toEqual({ running: 'active', saved: 'active', lockedByEnv: true });
    expect(
      clients('all', { STUDIO_INSTAGRAM_CLIENTS: '' }).readInstagramClients().lockedByEnv,
    ).toBe(false);
  });

  it('is part of the answer the settings page gets, beside the switches', () => {
    expect(clients().response(true)).toMatchObject({
      instagramClients: { running: 'active', saved: 'active', lockedByEnv: false },
      canRestart: true,
    });
  });

  it('is written to config.json beside the other keys, and refused when the environment decides', () => {
    writeFileSync(configPath, JSON.stringify({ fonts: true }));
    clients().write({ instagramClients: 'all' });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      fonts: true,
      instagramClients: 'all',
    });
    clients().write({ instagramClients: 'active', fonts: false });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      fonts: false,
      instagramClients: 'active',
    });
    expect(() =>
      clients('active', { STUDIO_INSTAGRAM_CLIENTS: 'active' }).write({ instagramClients: 'all' }),
    ).toThrow(/STUDIO_INSTAGRAM_CLIENTS/);
  });
});

describe('write', () => {
  it('creates config.json with the switch', () => {
    settings().write({ graphics: false });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ graphics: false });
  });

  it('keeps every other key and changes only the ones it is given', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ remoteLogins: ['owner@example.com'], fonts: true, port: 4310 }),
    );
    settings().write({ fonts: false, luts: false });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      remoteLogins: ['owner@example.com'],
      fonts: false,
      port: 4310,
      luts: false,
    });
  });

  it('saves Claude plan only to config.json and refuses it when the environment decides', () => {
    settings().write({ claudePlanOnly: false });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ claudePlanOnly: false });
    expect(() =>
      settings(ALL_ON, { STUDIO_CLAUDE_PLAN_ONLY: '1' }).write({ claudePlanOnly: false }),
    ).toThrow(/STUDIO_CLAUDE_PLAN_ONLY/);
  });

  it('leaves no temporary file behind', () => {
    settings().write({ graphics: false });
    expect(existsSync(`${configPath}.tmp`)).toBe(false);
  });

  it('is read back as the saved value, while the running one stays', () => {
    const s = settings();
    s.write({ graphics: false });
    expect(byKey(s.read(), 'graphics')).toMatchObject({ running: true, saved: false });
  });

  it('refuses a switch an environment variable decides, and writes nothing', () => {
    const s = settings(ALL_ON, { STUDIO_GRAPHICS: '1' });
    expect(() => s.write({ graphics: false, fonts: false })).toThrow(SettingsError);
    expect(existsSync(configPath)).toBe(false);
  });

  it('refuses a config.json that is not JSON, and leaves it as it is', () => {
    writeFileSync(configPath, '{ nope');
    expect(() => settings().write({ fonts: false })).toThrow(/can't be read as JSON/);
    expect(readFileSync(configPath, 'utf8')).toBe('{ nope');
  });

  it('refuses a config.json that is not an object', () => {
    writeFileSync(configPath, '[]');
    expect(() => settings().write({ fonts: false })).toThrow(/not a JSON object/);
  });
});
