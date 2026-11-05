import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSTAGRAM_CLIENTS,
  FEATURE_SWITCH_DEFAULTS,
  FEATURE_SWITCH_KEYS,
  featureNeedsRestart,
  settingsNeedRestart,
  settingsResponseSchema,
  updateSettingsRequestSchema,
} from './settings.ts';

const feature = (running: boolean, saved: boolean) => ({
  key: 'fonts' as const,
  running,
  saved,
  lockedByEnv: false,
});

describe('FEATURE_SWITCH_DEFAULTS', () => {
  it('has Draft & chat off, and every other switch on', () => {
    const off = FEATURE_SWITCH_KEYS.filter((key) => !FEATURE_SWITCH_DEFAULTS[key]);
    expect(off).toEqual(['draftChat']);
  });
});

describe('updateSettingsRequestSchema', () => {
  it('takes one or more of the switches, Claude plan only included', () => {
    expect(FEATURE_SWITCH_KEYS).toContain('claudePlanOnly');
    for (const key of FEATURE_SWITCH_KEYS) {
      expect(updateSettingsRequestSchema.parse({ [key]: false })).toEqual({ [key]: false });
    }
    expect(updateSettingsRequestSchema.parse({ graphics: true, luts: false })).toEqual({
      graphics: true,
      luts: false,
    });
  });

  it.each([{}, { graphics: undefined }, { graphics: 'off' }, { music: true }])(
    'rejects %j',
    (body) => {
      expect(updateSettingsRequestSchema.safeParse(body).success).toBe(false);
    },
  );
});

describe('settingsResponseSchema', () => {
  it('parses the switches and canRestart', () => {
    const body = { features: [feature(true, false)], canRestart: true };
    expect(settingsResponseSchema.parse(body)).toEqual(body);
  });
});

describe('restart needed', () => {
  it('is when a switch runs one way and is saved the other', () => {
    expect(featureNeedsRestart(feature(true, false))).toBe(true);
    expect(featureNeedsRestart(feature(false, true))).toBe(true);
    expect(featureNeedsRestart(feature(true, true))).toBe(false);
    expect(settingsNeedRestart({ features: [feature(true, true), feature(true, false)] })).toBe(
      true,
    );
    expect(settingsNeedRestart({ features: [feature(true, true)] })).toBe(false);
  });

  it('is also when Which clients runs one way and is saved the other', () => {
    const features = [feature(true, true)];
    const same = { running: 'active', saved: 'active', lockedByEnv: false } as const;
    expect(settingsNeedRestart({ features, instagramClients: same })).toBe(false);
    expect(settingsNeedRestart({ features, instagramClients: { ...same, saved: 'all' } })).toBe(
      true,
    );
  });
});

describe('Which clients the Instagram scan reads', () => {
  it('is active by default, and the update takes active or all', () => {
    expect(DEFAULT_INSTAGRAM_CLIENTS).toBe('active');
    expect(updateSettingsRequestSchema.parse({ instagramClients: 'all' })).toEqual({
      instagramClients: 'all',
    });
    expect(updateSettingsRequestSchema.safeParse({ instagramClients: 'some' }).success).toBe(false);
  });

  it('is part of the response, and optional there', () => {
    const body = {
      features: [feature(true, true)],
      instagramClients: { running: 'active', saved: 'all', lockedByEnv: false },
      canRestart: false,
    };
    expect(settingsResponseSchema.parse(body)).toEqual(body);
  });
});
