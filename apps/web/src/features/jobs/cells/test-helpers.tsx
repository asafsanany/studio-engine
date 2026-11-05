// Helpers shared by the cell tests. Not imported by the app.

import type { Job } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createTestQueryClient } from '@/data/test-utils';
import { CANVAS_JOBS } from '../test-jobs';

/** A canvas job by id (j1 to j12). */
export function canvasJob(id: string): Job {
  const job = CANVAS_JOBS.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`no canvas job ${id}`);
  return job;
}

/** Server-render `node` with what the cells need: a query client and a tooltip provider. */
export function renderCell(node: ReactNode, queryClient = createTestQueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The visible text of some markup: tags removed, the screen-reader-only copies kept out. */
export function textOf(markup: string): string {
  return markup
    .replace(/<span class="sr-only">.*?<\/span>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
