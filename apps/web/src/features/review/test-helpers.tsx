// Helpers shared by the review dialog's tests. Not imported by the app.

import type { ReviewNote } from '@studio/shared';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import { notesKey } from '@/data/notes-cache';
import { createTestQueryClient, makeReviewNote } from '@/data/test-utils';

/**
 * Server-render `node` with what the review dialog's parts need: a query client (the notes and the
 * job actions are hooks) and a tooltip provider. Pass a client to set its cache first.
 */
export function renderReview(
  node: ReactNode,
  queryClient: QueryClient = createTestQueryClient(),
): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

/** A client whose cache already holds these notes for `jobId`. */
export function clientWithNotes(
  jobId: string,
  notes: readonly ReviewNote[] | undefined,
): QueryClient {
  const queryClient = createTestQueryClient();
  if (notes !== undefined) queryClient.setQueryData(notesKey(jobId), [...notes]);
  return queryClient;
}

/** Three notes out of order: a Hebrew text note at 2.4, a voice note at 7.8, a text note at 15.6. */
export function sampleNotes(jobId: string): ReviewNote[] {
  return [
    makeReviewNote({
      id: 'n3',
      jobId,
      atSec: 15.6,
      text: 'לחתוך את השתיקה לפני "בסוף השבוע".',
      createdAt: '2026-10-20T14:03:00.000Z',
    }),
    makeReviewNote({
      id: 'n1',
      jobId,
      atSec: 2.4,
      text: 'הכותרת יורדת מהר מדי. להשאיר אותה עוד שנייה.',
      addToStyle: true,
      createdAt: '2026-10-20T14:01:00.000Z',
    }),
    makeReviewNote({
      id: 'n2',
      jobId,
      atSec: 7.8,
      kind: 'voice',
      text: 'כאן הכתוביות מכסות את הידיים של יוסי.',
      audioFile: 'edit/review/voice/n2.webm',
      audioSec: 9,
      transcriptStatus: 'done',
      createdAt: '2026-10-20T14:02:00.000Z',
    }),
  ];
}

/** The opening tag of the first element in `html` that has `attribute`. */
export function tagWith(html: string, attribute: string): string {
  const at = html.indexOf(attribute);
  if (at === -1) throw new Error(`no element with ${attribute} in the markup`);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}
