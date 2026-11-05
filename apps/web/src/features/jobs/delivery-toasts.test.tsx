import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeJob, makeJobDelivery } from '@/data/test-utils';
import { ACTION_ERROR_MS } from './cells/ActionError';

const sonner = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast };
});
vi.mock('sonner', () => sonner);

const {
  DELIVERY_TOAST_MS,
  DELIVERY_TOAST_STYLE,
  announceDelivered,
  announceDeliveryRemoved,
  announceDeliveryUndoRefused,
  announceUnapproved,
  announceUndelivered,
  announceUnpaid,
  deliveryToastId,
} = await import('./delivery-toasts');

// 21 October 09:00 UTC is the 21st in every zone from UTC-9 to UTC+14, so the month is October
// wherever the test runs.
const delivery = makeJobDelivery();
const job = makeJob({
  id: 'job-1',
  client: 'RGM',
  name: 'הכרזת הטורניר',
  state: 'ready',
  placeInLine: null,
  delivery,
});

beforeEach(() => {
  sonner.toast.mockClear();
  sonner.toast.error.mockClear();
});

/** The first (and only) toast of `fn`: what it says, and how it was asked for. */
function shown(fn: ReturnType<typeof vi.fn>) {
  expect(fn).toHaveBeenCalledOnce();
  const [message, options] = fn.mock.calls[0] as [React.ReactNode, Record<string, unknown>];
  return { text: renderToStaticMarkup(message), options };
}

const undoOf = (options: Record<string, unknown>) =>
  options.action as { label: string; onClick: () => void } | undefined;

describe('announceDelivered', () => {
  it('says "Delivered to <client> · ₪40 counts in October", the client in <bdi>', () => {
    announceDelivered(job, () => {});
    expect(shown(sonner.toast).text).toBe('Delivered to <bdi>RGM</bdi> · ₪40 counts in October');
  });

  it('keeps a Hebrew client in its own direction', () => {
    announceDelivered({ ...job, client: 'עו״ד דוד לוי' }, () => {});
    expect(shown(sonner.toast).text).toBe(
      'Delivered to <bdi>עו״ד דוד לוי</bdi> · ₪40 counts in October',
    );
  });

  it('reads the price the delivery froze', () => {
    announceDelivered({ ...job, delivery: makeJobDelivery({ price: 200 }) }, () => {});
    expect(shown(sonner.toast).text).toContain('₪200 counts in October');
  });

  it('lasts 7 seconds and has an Undo button that runs the undo', () => {
    const undo = vi.fn();
    announceDelivered(job, undo);
    const { options } = shown(sonner.toast);
    expect(options.duration).toBe(7000);
    expect(DELIVERY_TOAST_MS).toBe(7000);
    expect(undoOf(options)?.label).toBe('Undo');
    undoOf(options)?.onClick();
    expect(undo).toHaveBeenCalledOnce();
  });

  it('draws Undo as the quiet outlined button of the other messages, not sonner’s inverted one', () => {
    announceDelivered(job, () => {});
    const { options } = shown(sonner.toast);
    expect((options.classNames as { actionButton: string }).actionButton).toContain(
      'border-white/15!',
    );
  });

  it('replaces the earlier message of the same job, and leaves other jobs’ messages alone', () => {
    announceDelivered(job, () => {});
    announceDelivered({ ...job, id: 'job-2' }, () => {});
    const ids = sonner.toast.mock.calls.map(([, options]) => (options as { id: string }).id);
    expect(ids).toEqual([
      deliveryToastId('delivered', 'job-1'),
      deliveryToastId('delivered', 'job-2'),
    ]);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('the width of the messages', () => {
  const widthOf = (options: Record<string, unknown>) =>
    (options.style as Record<string, string> | undefined)?.['--width'];

  it('is the board’s 380 px, so "Delivered to LAKESHORE · ₪40 counts in October" is one line', () => {
    expect(DELIVERY_TOAST_STYLE).toEqual({ '--width': '380px' });
  });

  it.each([
    ['Delivered', () => announceDelivered(job, () => {})],
    ['Back to Approved', () => announceUndelivered(job, () => {})],
    ['Back to Delivered', () => announceUnpaid(job, () => {})],
    ['Back to Delivered with nothing to undo', () => announceUnpaid(job, undefined)],
  ])('widens the "%s" message', (_name, announce) => {
    announce();
    expect(widthOf(shown(sonner.toast).options)).toBe('380px');
  });

  it('leaves the refused-undo error at sonner’s own width', () => {
    announceDeliveryUndoRefused(job, 'Not paid.');
    const options = sonner.toast.error.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options.style).toBeUndefined();
  });
});

describe('announceUnapproved', () => {
  it('says where the video went, with its name in its own direction, and has no Undo', () => {
    announceUnapproved(job);
    const { text, options } = shown(sonner.toast);
    expect(text).toBe('Back in Review: “<bdi>הכרזת הטורניר</bdi>”');
    expect(undoOf(options)).toBeUndefined();
    expect(options.id).toBe(deliveryToastId('unapproved', job.id));
    expect(options.duration).toBe(DELIVERY_TOAST_MS);
  });
});

describe('announceUndelivered', () => {
  it('says "Back to Approved · ₪40 taken off October"', () => {
    announceUndelivered(job, () => {});
    expect(shown(sonner.toast).text).toBe('Back to Approved · ₪40 taken off October');
  });

  it('says only "Back to Approved" when the job had no delivery to take off', () => {
    announceUndelivered({ ...job, delivery: null }, () => {});
    expect(shown(sonner.toast).text).toBe('Back to Approved');
  });

  it('lasts 7 seconds and has an Undo button', () => {
    const undo = vi.fn();
    announceUndelivered(job, undo);
    const { options } = shown(sonner.toast);
    expect(options.duration).toBe(7000);
    undoOf(options)?.onClick();
    expect(undo).toHaveBeenCalledOnce();
  });
});

describe('announceUnpaid', () => {
  it('says "Back to Delivered · not paid yet"', () => {
    announceUnpaid(job, () => {});
    expect(shown(sonner.toast).text).toBe('Back to Delivered · not paid yet');
  });

  it('says "Back to Uploaded · not paid yet" for a video a reel is linked to', () => {
    const uploaded = {
      ...job,
      delivery: makeJobDelivery({ uploadedAt: '2026-10-20T09:30:00.000Z', paidOn: '2026-10-23' }),
    };
    announceUnpaid(uploaded, () => {});
    expect(shown(sonner.toast).text).toBe('Back to Uploaded · not paid yet');
  });

  it('says Delivered when all it knows is the job’s id', () => {
    announceUnpaid({ id: 'job-1' }, () => {});
    expect(shown(sonner.toast).text).toBe('Back to Delivered · not paid yet');
  });

  it('lasts 7 seconds and has an Undo button', () => {
    const undo = vi.fn();
    announceUnpaid(job, undo);
    const { options } = shown(sonner.toast);
    expect(options.duration).toBe(7000);
    undoOf(options)?.onClick();
    expect(undo).toHaveBeenCalledOnce();
  });

  it('has no Undo when there is no payment to put back', () => {
    announceUnpaid(job, undefined);
    const { options } = shown(sonner.toast);
    expect(options.action).toBeUndefined();
    expect(options.duration).toBe(7000);
  });
});

describe('announceDeliveryUndoRefused', () => {
  it('is an error: "Couldn’t undo <client> / <job>" and the server’s words, kept as long as a refusal is', () => {
    announceDeliveryUndoRefused(job, 'This job is paid already.');
    expect(sonner.toast).not.toHaveBeenCalled();
    expect(sonner.toast.error).toHaveBeenCalledOnce();
    const [title, options] = sonner.toast.error.mock.calls[0] as [
      React.ReactNode,
      Record<string, unknown>,
    ];
    expect(renderToStaticMarkup(title)).toBe(
      'Couldn&#x27;t undo <bdi>RGM</bdi> / <bdi>הכרזת הטורניר</bdi>',
    );
    expect(options.description).toBe('This job is paid already.');
    expect(options.duration).toBe(ACTION_ERROR_MS);
    expect(options.id).toBe(deliveryToastId('undo-refused', 'job-1'));
  });

  it('says why the video can’t go back to Approved while a reel is linked to it', () => {
    const message = 'This video is on Instagram: unlink the reel on the client page first.';
    announceDeliveryUndoRefused(job, message);
    const [, options] = sonner.toast.error.mock.calls[0] as [
      React.ReactNode,
      Record<string, unknown>,
    ];
    expect(options.description).toBe(message);
  });
});

describe('deliveryToastId', () => {
  it('gives each kind of message its own id, so a closing Undo cannot swallow the next message', () => {
    const ids = (['delivered', 'undelivered', 'unpaid', 'undo-refused'] as const).map((kind) =>
      deliveryToastId(kind, 'job-1'),
    );
    expect(new Set(ids).size).toBe(4);
  });
});

describe('announceDeliveryRemoved (a video whose folder was deleted)', () => {
  it('says "Delivery removed · ₪40 taken off October" and why it can’t go back to Approved', () => {
    announceDeliveryRemoved(job);
    const { text, options } = shown(sonner.toast);
    expect(text).toBe('Delivery removed · ₪40 taken off October');
    expect(options.description).toBe('Its folder is deleted, so it can’t go back to Approved.');
  });

  it('has no Undo: Mark delivered needs a job, and there is none', () => {
    announceDeliveryRemoved(job);
    expect(undoOf(shown(sonner.toast).options)).toBeUndefined();
  });

  it('lasts 7 seconds, is 380 px wide and replaces the earlier message of the same video', () => {
    announceDeliveryRemoved(job);
    const { options } = shown(sonner.toast);
    expect(options.duration).toBe(7000);
    expect((options.style as Record<string, string>)['--width']).toBe('380px');
    expect(options.id).toBe(deliveryToastId('undelivered', 'job-1'));
  });

  it('says only "Delivery removed" when the video had no delivery to take off', () => {
    announceDeliveryRemoved({ ...job, delivery: null });
    expect(shown(sonner.toast).text).toBe('Delivery removed');
  });
});
