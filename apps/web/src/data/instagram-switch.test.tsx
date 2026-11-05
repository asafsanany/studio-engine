import type { HealthResponse } from '@studio/shared';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { HEALTH_KEY } from './health-query';
import { useInstagramEnabled } from './hooks';
import { createTestQueryClient } from './test-utils';

// The Clients × Instagram switch as the page reads it: off until the health answer says on.

const health: HealthResponse = {
  ok: true,
  version: '0.63.1',
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
  return <p>{String(useInstagramEnabled())}</p>;
}

function render(): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Enabled />
    </QueryClientProvider>,
  );
}

describe('useInstagramEnabled', () => {
  it('is false before the health answer is in', () => {
    expect(render()).toBe('<p>false</p>');
  });

  it('is false for an engine from before Clients × Instagram, and while the answer says off', () => {
    queryClient.setQueryData(HEALTH_KEY, health);
    expect(render()).toBe('<p>false</p>');

    queryClient.setQueryData(HEALTH_KEY, { ...health, instagram: false });
    expect(render()).toBe('<p>false</p>');
  });

  it('is true once the answer says on', () => {
    queryClient.setQueryData(HEALTH_KEY, { ...health, instagram: true });
    expect(render()).toBe('<p>true</p>');
  });
});
