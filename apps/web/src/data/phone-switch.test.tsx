import type { HealthResponse } from '@studio/shared';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { HEALTH_KEY, phoneEnabled } from './health-query';
import { usePhoneEnabled } from './hooks';
import { createTestQueryClient } from './test-utils';

// The Phone switch as the page reads it: off until the health answer says on.

const health: HealthResponse = {
  ok: true,
  version: '0.13.18',
  settleMs: 60_000,
  series: false,
  jobSheet: false,
  analytics: false,
  phone: false,
  graphics: false,
  graphicsInEdits: false,
  music: false,
  luts: false,
  lutsInEdits: false,
  fonts: false,
  fontsInNotes: false,
  quickFixes: false,
};

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

function Enabled() {
  return <p>{String(usePhoneEnabled())}</p>;
}

function render(): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Enabled />
    </QueryClientProvider>,
  );
}

describe('phoneEnabled', () => {
  it('is off until the health answer is in, and for an answer that says off', () => {
    expect(phoneEnabled(undefined)).toBe(false);
    expect(phoneEnabled(health)).toBe(false);
  });

  it('is on when the health answer says so', () => {
    expect(phoneEnabled({ ...health, phone: true })).toBe(true);
  });

  it('does not follow the Series or Job sheet switches', () => {
    expect(phoneEnabled({ ...health, series: true, jobSheet: true })).toBe(false);
  });
});

describe('usePhoneEnabled', () => {
  it('is false before the health answer is in', () => {
    expect(render()).toBe('<p>false</p>');
  });

  it('is false while the answer says off, true once it says on', () => {
    queryClient.setQueryData(HEALTH_KEY, health);
    expect(render()).toBe('<p>false</p>');

    queryClient.setQueryData(HEALTH_KEY, { ...health, phone: true });
    expect(render()).toBe('<p>true</p>');
  });
});
