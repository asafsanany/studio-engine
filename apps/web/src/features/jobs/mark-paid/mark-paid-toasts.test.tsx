import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeJob, makeJobDelivery } from '@/data/test-utils';
import { ACTION_ERROR_MS } from '../cells/ActionError';

const sonner = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast };
});
vi.mock('sonner', () => sonner);

const { announcePaid, announcePaymentUndoRefused, paymentToastId } = await import(
  './mark-paid-toasts'
);

const client = { clientId: 'client-tavo', client: 'עו״ד דוד לוי' };

const owed = (id: string, price = 40, currency = 'ILS') => ({
  ...makeJob({ id, state: 'ready', placeInLine: null }),
  delivery: makeJobDelivery({ price, currency, paidOn: '2026-10-23' }),
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

describe('announcePaid', () => {
  it('says "<N> videos from <client> marked paid · ₪<total>", the client in <bdi>', () => {
    announcePaid(client, [owed('a'), owed('b'), owed('c')], () => {});
    expect(shown(sonner.toast).text).toBe(
      '3 videos from <bdi>עו״ד דוד לוי</bdi> marked paid · ₪120',
    );
  });

  it('says "1 video" for one', () => {
    announcePaid({ ...client, client: 'RGM' }, [owed('a')], () => {});
    expect(shown(sonner.toast).text).toBe('1 video from <bdi>RGM</bdi> marked paid · ₪40');
  });

  it('adds up the prices the server answered with, not a price it assumes', () => {
    announcePaid(client, [owed('a', 200), owed('b', 37.5)], () => {});
    expect(shown(sonner.toast).text).toContain('marked paid · ₪237.50');
  });

  it('lasts 7 seconds and has an Undo button that runs the undo', () => {
    const undo = vi.fn();
    announcePaid(client, [owed('a')], undo);
    const { options } = shown(sonner.toast);
    expect(options.duration).toBe(7000);
    expect(undoOf(options)?.label).toBe('Undo');
    undoOf(options)?.onClick();
    expect(undo).toHaveBeenCalledOnce();
  });

  it('is 380 px wide like the other delivery messages (sonner’s 356 wraps a Hebrew client)', () => {
    announcePaid(client, [owed('a')], () => {});
    expect((shown(sonner.toast).options.style as Record<string, string>)['--width']).toBe('380px');
  });

  it('draws Undo as the quiet outlined button of the other messages, not sonner’s inverted one', () => {
    announcePaid(client, [owed('a')], () => {});
    const { options } = shown(sonner.toast);
    expect((options.classNames as { actionButton: string }).actionButton).toContain(
      'border-white/15!',
    );
  });

  it('has an id of its own per payment: another payment keeps its Undo, the same one replaces the message', () => {
    announcePaid(client, [owed('a'), owed('b')], () => {});
    announcePaid(client, [owed('c')], () => {});
    announcePaid(client, [owed('a'), owed('b')], () => {});
    const ids = sonner.toast.mock.calls.map(([, options]) => (options as { id: string }).id);
    expect(ids[0]).toBe(paymentToastId('paid', ['a', 'b']));
    expect(ids[1]).toBe(paymentToastId('paid', ['c']));
    expect(ids[2]).toBe(ids[0]);
    expect(ids[1]).not.toBe(ids[0]);
  });
});

describe('announcePaymentUndoRefused', () => {
  it('says "Couldn’t undo the payment from <client>" with the server’s own words under it', () => {
    announcePaymentUndoRefused(client, ['a', 'b'], 'Nothing was changed: Video a is not paid.');
    const { text, options } = shown(sonner.toast.error);
    expect(text).toBe('Couldn&#x27;t undo the payment from <bdi>עו״ד דוד לוי</bdi>');
    expect(options.description).toBe('Nothing was changed: Video a is not paid.');
    expect(options.duration).toBe(ACTION_ERROR_MS);
  });

  it('has its own id, apart from the message of the payment', () => {
    expect(paymentToastId('undo-refused', ['a'])).not.toBe(paymentToastId('paid', ['a']));
  });
});
