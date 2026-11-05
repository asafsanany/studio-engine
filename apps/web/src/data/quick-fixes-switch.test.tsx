import type { HealthResponse } from '@studio/shared';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { HEALTH_KEY, quickFixesEnabled } from './health-query';
import { useQuickFixesEnabled } from './hooks';
import { createTestQueryClient } from './test-utils';

// The Quick fixes switch as the page reads it: off until the health answer says on.

const health: HealthResponse = {
  ok: true,
  version: '0.42.7',
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
  return <p>{String(useQuickFixesEnabled())}</p>;
}

function render(): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Enabled />
    </QueryClientProvider>,
  );
}

describe('quickFixesEnabled', () => {
  it('is off until the health answer is in, and for an answer that says off', () => {
    expect(quickFixesEnabled(undefined)).toBe(false);
    expect(quickFixesEnabled(health)).toBe(false);
  });

  it('is on when the health answer says so, and not because another switch is on', () => {
    expect(quickFixesEnabled({ ...health, quickFixes: true })).toBe(true);
    expect(quickFixesEnabled({ ...health, phone: true, music: true })).toBe(false);
  });
});

describe('useQuickFixesEnabled', () => {
  it('is false before the health answer is in', () => {
    expect(render()).toBe('<p>false</p>');
  });

  it('is false while the answer says off, true once it says on', () => {
    queryClient.setQueryData(HEALTH_KEY, health);
    expect(render()).toBe('<p>false</p>');

    queryClient.setQueryData(HEALTH_KEY, { ...health, quickFixes: true });
    expect(render()).toBe('<p>true</p>');
  });
});
