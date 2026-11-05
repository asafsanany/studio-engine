import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { type ToastT, toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestQueryClient } from '@/data/test-utils';
import { ACTION_ERROR_MS } from './cells/ActionError';
import { canvasJob, textOf } from './cells/test-helpers';
import {
  announceRefusal,
  RefusedActionsHost,
  refusalTitle,
  refusalToastId,
} from './RefusedActionsHost';
import type { RefusedAction } from './row-refusals';

const refused: RefusedAction = {
  jobId: 'j2',
  action: 'hold',
  message: 'Only an arriving or queued job can be held.',
};

/** The words of a title, as the person reads them. */
const words = (title: ReactNode) => textOf(renderToStaticMarkup(title)).replaceAll('&#x27;', "'");

/** The notes the toast region holds right now (not the ones being dismissed). */
const shown = () => toast.getToasts().filter((note): note is ToastT => !('dismiss' in note));

// Sonner asks the browser for animation frames when a toast is dismissed.
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
});
afterEach(() => {
  toast.dismiss();
  vi.unstubAllGlobals();
});

describe('refusalTitle', () => {
  it('says which job, as "<Client> / <Job>", in the words of the action', () => {
    const job = canvasJob('j2');
    for (const action of ['start', 'hold', 'release', 'resume', 'retry'] as const) {
      expect(words(refusalTitle(action, job))).toBe(
        `Couldn't ${action} ${job.client} / ${job.name}`,
      );
    }
  });

  it('says it in the words of the stage change: deliver, undo the delivery of, undo the payment of', () => {
    const job = canvasJob('j2');
    const title = (action: 'deliver' | 'undeliver' | 'unpay') => words(refusalTitle(action, job));
    expect(title('deliver')).toBe(`Couldn't deliver ${job.client} / ${job.name}`);
    expect(title('undeliver')).toBe(`Couldn't undo the delivery of ${job.client} / ${job.name}`);
    expect(title('unpay')).toBe(`Couldn't undo the payment of ${job.client} / ${job.name}`);
  });

  it('keeps each Hebrew or mixed name in its own direction, so the slash cannot flip them', () => {
    const markup = renderToStaticMarkup(refusalTitle('hold', canvasJob('j1')));
    expect(markup).toContain('<bdi>מאפיית הצפון</bdi> / <bdi>פרומו לסוף השבוע</bdi>');
  });

  it('says "this job" for one that has left the list', () => {
    expect(words(refusalTitle('retry', undefined))).toBe("Couldn't retry this job");
  });
});

describe('announceRefusal', () => {
  it('shows a note with the job and the server’s reason', () => {
    announceRefusal(refused, canvasJob('j2'));
    const [note, ...others] = shown();
    expect(others).toEqual([]);
    expect(note?.type).toBe('error');
    expect(words(note?.title as ReactNode)).toBe("Couldn't hold Arc Fitness / Class schedule");
    expect(note?.description).toBe('Only an arriving or queued job can be held.');
  });

  it('stays as long as the tooltip it stands in for', () => {
    announceRefusal(refused, canvasJob('j2'));
    expect(shown()[0]?.duration).toBe(ACTION_ERROR_MS);
  });

  it('replaces the note when the same thing is refused again, and adds one for anything else', () => {
    announceRefusal(refused, canvasJob('j2'));
    announceRefusal({ ...refused, message: 'Still no.' }, canvasJob('j2'));
    expect(shown().map((note) => note.description)).toEqual(['Still no.']);

    announceRefusal({ ...refused, action: 'release' }, canvasJob('j2'));
    announceRefusal({ ...refused, jobId: 'j4' }, canvasJob('j4'));
    expect(shown()).toHaveLength(3);
  });

  it('can be dismissed, by the id of the refusal', () => {
    announceRefusal(refused, canvasJob('j2'));
    announceRefusal({ ...refused, jobId: 'j4' }, canvasJob('j4'));

    toast.dismiss(refusalToastId(refused));

    expect(shown().map((note) => note.id)).toEqual([refusalToastId({ ...refused, jobId: 'j4' })]);
  });
});

describe('<RefusedActionsHost>', () => {
  const host = (toaster?: boolean) =>
    renderToStaticMarkup(
      <QueryClientProvider client={createTestQueryClient()}>
        <RefusedActionsHost jobs={undefined} toaster={toaster} />
      </QueryClientProvider>,
    );

  it('provides the region the notes appear in, empty until there is a refusal', () => {
    const markup = host();
    expect(markup).toContain('aria-label="Notifications');
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('<li');
  });

  it('draws no region with `toaster={false}`: the phone shell has the one toaster of the phone layout', () => {
    expect(host(false)).toBe('');
    expect(host(true)).toContain('aria-label="Notifications');
  });
});
