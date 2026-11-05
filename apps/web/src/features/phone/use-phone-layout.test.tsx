import type { HealthResponse } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient } from '@/data/test-utils';
import {
  PHONE_SWITCH_KEY,
  phoneLayoutState,
  readRememberedPhoneSwitch,
  rememberPhoneSwitch,
  usePhoneLayout,
  usePhoneLayoutState,
} from './use-phone-layout';

const answered = { healthPending: false, remembered: null } as const;

describe('phoneLayoutState', () => {
  it('is the phone layout when the switch is on and the window is narrow', () => {
    expect(phoneLayoutState({ ...answered, phone: true, isMobile: true })).toBe('phone');
  });

  it('is the Mac layout with the switch off, at any width', () => {
    expect(phoneLayoutState({ ...answered, phone: false, isMobile: true })).toBe('mac');
    expect(phoneLayoutState({ ...answered, phone: false, isMobile: false })).toBe('mac');
  });

  it('is the Mac layout with the switch on and a wide window', () => {
    expect(phoneLayoutState({ ...answered, phone: true, isMobile: false })).toBe('mac');
  });

  it('is pending in a narrow window until the engine has answered, with nothing remembered', () => {
    expect(
      phoneLayoutState({ phone: undefined, healthPending: true, isMobile: true, remembered: null }),
    ).toBe('pending');
  });

  it('is the Mac layout in a wide window at once: the switch cannot matter there', () => {
    expect(
      phoneLayoutState({
        phone: undefined,
        healthPending: true,
        isMobile: false,
        remembered: null,
      }),
    ).toBe('mac');
    expect(
      phoneLayoutState({
        phone: undefined,
        healthPending: true,
        isMobile: false,
        remembered: true,
      }),
    ).toBe('mac');
  });

  it('starts in the layout the last answer remembered, before this one is in', () => {
    const waiting = { phone: undefined, healthPending: true, isMobile: true } as const;
    expect(phoneLayoutState({ ...waiting, remembered: true })).toBe('phone');
    expect(phoneLayoutState({ ...waiting, remembered: false })).toBe('mac');
  });

  it('lets the engine’s answer overrule what was remembered', () => {
    expect(
      phoneLayoutState({ phone: false, healthPending: false, isMobile: true, remembered: true }),
    ).toBe('mac');
    expect(
      phoneLayoutState({ phone: true, healthPending: false, isMobile: true, remembered: false }),
    ).toBe('phone');
  });

  it('keeps the remembered layout when the answer never comes: the offline screen can say why', () => {
    expect(
      phoneLayoutState({
        phone: undefined,
        healthPending: false,
        isMobile: true,
        remembered: true,
      }),
    ).toBe('phone');
  });

  it('is the Mac layout once the health answer has failed with nothing remembered', () => {
    // `healthPending` is false after an error, and `phone` stays undefined without data.
    expect(
      phoneLayoutState({
        phone: undefined,
        healthPending: false,
        isMobile: true,
        remembered: null,
      }),
    ).toBe('mac');
  });
});

describe('the remembered switch', () => {
  function memory(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      data,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    };
  }

  it('is read back as it was kept', () => {
    const storage = memory();
    expect(readRememberedPhoneSwitch(storage)).toBeNull();
    rememberPhoneSwitch(true, storage);
    expect(storage.data.get(PHONE_SWITCH_KEY)).toBe('1');
    expect(readRememberedPhoneSwitch(storage)).toBe(true);
    rememberPhoneSwitch(false, storage);
    expect(readRememberedPhoneSwitch(storage)).toBe(false);
  });

  it('ignores a value it did not write', () => {
    expect(readRememberedPhoneSwitch(memory({ [PHONE_SWITCH_KEY]: 'true' }))).toBeNull();
    expect(readRememberedPhoneSwitch(memory({ [PHONE_SWITCH_KEY]: '' }))).toBeNull();
  });

  it('survives blocked site data: nothing is remembered and nothing throws', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readRememberedPhoneSwitch(blocked)).toBeNull();
    expect(() => rememberPhoneSwitch(true, blocked)).not.toThrow();
    expect(readRememberedPhoneSwitch(null)).toBeNull();
    expect(() => rememberPhoneSwitch(true, null)).not.toThrow();
  });
});

describe('usePhoneLayout (with no window to measure)', () => {
  const health: HealthResponse = {
    ok: true,
    version: '0.13.18',
    settleMs: 60_000,
    series: false,
    jobSheet: false,
    analytics: false,
    phone: true,
    graphics: false,
    graphicsInEdits: false,
    music: false,
    luts: false,
    lutsInEdits: false,
    fonts: false,
    fontsInNotes: false,
    quickFixes: false,
  };

  function Probe() {
    return (
      <p>
        {String(usePhoneLayout())} {usePhoneLayoutState()}
      </p>
    );
  }

  function render(withHealth: boolean): string {
    const queryClient = createTestQueryClient();
    if (withHealth) queryClient.setQueryData(HEALTH_KEY, health);
    return renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  }

  it('is the Mac layout: a render with no window is not a narrow one', () => {
    expect(render(false)).toBe('<p>false mac</p>');
  });

  it('is still the Mac layout with the switch on', () => {
    expect(render(true)).toBe('<p>false mac</p>');
  });
});
