// Helpers shared by the studio's tests. Not imported by the app.

import type { HealthResponse } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import type { ComposerController } from './use-studio-composer';

/** `/api/health` with Graphics on (the studio is Not found without it). */
export const HEALTH_ON: HealthResponse = {
  ok: true,
  version: '0.17.5',
  settleMs: 60_000,
  series: false,
  jobSheet: false,
  analytics: false,
  phone: false,
  graphics: true,
  graphicsInEdits: false,
  music: false,
  luts: false,
  lutsInEdits: false,
  fonts: false,
  fontsInNotes: false,
  quickFixes: false,
};

/** A query client that knows Graphics are on. */
export function clientWithGraphics(): QueryClient {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, HEALTH_ON);
  return queryClient;
}

/** Server-renders `node` inside the app's router, a query client and the tooltip provider. */
export function renderStudio(
  node: ReactNode,
  queryClient: QueryClient = clientWithGraphics(),
  path = '/graphics/new',
): Promise<string> {
  return renderAt(path, node, queryClient);
}

/** The opening tag of the first element in `html` that has `attribute`. */
export function tagWith(html: string, attribute: string): string {
  const at = html.indexOf(attribute);
  if (at === -1) throw new Error(`no element with ${attribute} in the markup`);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

/** The text of `html` without its tags, with the spaces between them squeezed. */
export function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A composer controller that does nothing: change what the test is about. */
export function makeComposer(overrides: Partial<ComposerController> = {}): ComposerController {
  return {
    draft: '',
    setDraft: () => {},
    files: [],
    addFiles: () => {},
    removeFile: () => {},
    effort: 'xhigh',
    setEffort: () => {},
    notice: null,
    sending: false,
    send: { enabled: false, reason: null },
    submit: () => {},
    voice: {
      snapshot: { phase: 'idle', pinnedSec: null, elapsedSec: 0, error: null },
      toggle: () => {},
      cancel: () => false,
      retry: () => {},
      discard: () => {},
    },
    ...overrides,
  };
}
