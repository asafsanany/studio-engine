import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_ERROR_MS } from '../cells/ActionError';
import type { UseLookTarget } from './use-look-dialog';

const sonner = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast };
});
vi.mock('sonner', () => sonner);

const {
  USE_LOOK_TOAST_MS,
  announceLookRefused,
  announceLookUndone,
  announceLookUsed,
  announceUndoRefused,
  lookToastId,
} = await import('./use-look-toasts');

const TARGET: UseLookTarget = {
  jobId: 'job-new',
  jobName: 'Studio tour',
  clientId: 'client-1',
  client: 'Arc Fitness',
};

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

describe('announceLookUsed', () => {
  it('says "<client> now uses the look from <job>." with the names in <bdi>', () => {
    announceLookUsed(TARGET, () => {});
    expect(shown(sonner.toast).text).toBe(
      '<bdi>Arc Fitness</bdi> now uses the look from <bdi>Studio tour</bdi>.',
    );
  });

  it('keeps Hebrew names in their own direction', () => {
    announceLookUsed({ ...TARGET, client: 'מרפאת מירה', jobName: 'טיפים' }, () => {});
    expect(shown(sonner.toast).text).toBe(
      '<bdi>מרפאת מירה</bdi> now uses the look from <bdi>טיפים</bdi>.',
    );
  });

  it('has an Undo button that runs the undo', () => {
    const undo = vi.fn();
    announceLookUsed(TARGET, undo);
    const { options } = shown(sonner.toast);
    const action = options.action as { label: string; onClick: () => void };
    expect(action.label).toBe('Undo');
    expect(undo).not.toHaveBeenCalled();
    action.onClick();
    expect(undo).toHaveBeenCalledOnce();
  });

  it('stays long enough to use the button, and is drawn like the board’s (a quiet outlined button)', () => {
    announceLookUsed(TARGET, () => {});
    const { options } = shown(sonner.toast);
    expect(options.duration).toBe(USE_LOOK_TOAST_MS);
    expect(USE_LOOK_TOAST_MS).toBeGreaterThan(4_000);
    const classNames = options.classNames as { actionButton: string };
    expect(classNames.actionButton).toContain('border-white/15!');
    expect(classNames.actionButton).toContain('cursor-pointer');
    // The hover fill fades like every other button's (150 ms, ease-in-out), not instantly.
    expect(classNames.actionButton).toContain('transition-colors!');
    expect(classNames.actionButton).toContain('duration-150!');
    expect(classNames.actionButton).toContain('ease-in-out!');
  });

  it('replaces the message of an earlier look of the same client, so Undo is the newest’s', () => {
    announceLookUsed(TARGET, () => {});
    const { options } = shown(sonner.toast);
    expect(options.id).toBe(lookToastId('used', 'client-1'));
    expect(lookToastId('used', 'client-1')).not.toBe(lookToastId('used', 'client-2'));
  });
});

describe('the other messages', () => {
  it('uses an id of its own for each kind: Undo closes its message, and a new one with that id would be lost', () => {
    const ids = (['used', 'refused', 'undone', 'undo-refused'] as const).map((kind) =>
      lookToastId(kind, 'client-1'),
    );
    expect(new Set(ids).size).toBe(4);
  });

  it('says why Use this look was refused, in the server’s words', () => {
    announceLookRefused(TARGET, 'The style is being analysed. Try again once it is done.');
    expect(sonner.toast.error).toHaveBeenCalledExactlyOnceWith("Couldn't use this look", {
      id: lookToastId('refused', 'client-1'),
      description: 'The style is being analysed. Try again once it is done.',
      duration: ACTION_ERROR_MS,
    });
  });

  it('says the client is back to its earlier look once Undo worked', () => {
    announceLookUndone(TARGET);
    const { text, options } = shown(sonner.toast);
    expect(text).toBe('<bdi>Arc Fitness</bdi> is back to its earlier look.');
    expect(options.id).toBe(lookToastId('undone', 'client-1'));
    expect(options.action).toBeUndefined();
  });

  it('says why Undo was refused, in the server’s words', () => {
    announceUndoRefused(TARGET, 'The style is being analysed. Undo once it is done.');
    expect(sonner.toast.error).toHaveBeenCalledExactlyOnceWith("Couldn't undo this look", {
      id: lookToastId('undo-refused', 'client-1'),
      description: 'The style is being analysed. Undo once it is done.',
      duration: ACTION_ERROR_MS,
    });
  });
});
