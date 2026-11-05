import type { HealthResponse } from '@studio/shared';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { analyticsEnabled, HEALTH_KEY, jobSheetEnabled } from './health-query';
import { useAnalyticsEnabled } from './hooks';
import { createTestQueryClient } from './test-utils';

// The Analytics switch as the page reads it: off until the health answer says on.

const health: HealthResponse = {
  ok: true,
  version: '0.13.19',
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
  return <p>{String(useAnalyticsEnabled())}</p>;
}

function render(): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Enabled />
    </QueryClientProvider>,
  );
}

describe('analyticsEnabled', () => {
  it('is off until the health answer is in, and for an answer that says off', () => {
    expect(analyticsEnabled(undefined)).toBe(false);
    expect(analyticsEnabled(health)).toBe(false);
  });

  it('is on when the health answer says so', () => {
    expect(analyticsEnabled({ ...health, analytics: true })).toBe(true);
  });

  it('does not follow the Series or Job sheet switches, nor they it', () => {
    expect(analyticsEnabled({ ...health, series: true, jobSheet: true })).toBe(false);
    expect(jobSheetEnabled({ ...health, analytics: true })).toBe(false);
  });
});

describe('useAnalyticsEnabled', () => {
  it('is false before the health answer is in', () => {
    expect(render()).toBe('<p>false</p>');
  });

  it('is false while the answer says off, true once it says on', () => {
    queryClient.setQueryData(HEALTH_KEY, health);
    expect(render()).toBe('<p>false</p>');

    queryClient.setQueryData(HEALTH_KEY, { ...health, analytics: true });
    expect(render()).toBe('<p>true</p>');
  });
});
