import type { DeleteFontResponse } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createFontActions,
  type FontActionDeps,
  type FontNotice,
  messageOf,
  runDelete,
} from './font-actions';

function setup(overrides: Partial<FontActionDeps> = {}) {
  const notice: FontNotice = { error: vi.fn(), info: vi.fn() };
  const deps: FontActionDeps = {
    reveal: vi.fn().mockResolvedValue(undefined),
    remove: vi
      .fn<(slug: string) => Promise<DeleteFontResponse>>()
      .mockResolvedValue({ ok: true, where: '/Users/owner/.Trash/Heebo' }),
    copyText: vi.fn().mockResolvedValue(undefined),
    notice,
    ...overrides,
  };
  return { actions: createFontActions(deps), deps, notice };
}

describe('messageOf', () => {
  it('uses an error’s sentence, or a plain one', () => {
    expect(messageOf(new Error('Could not open Finder.'))).toBe('Could not open Finder.');
    expect(messageOf(new Error(''))).toBe('Something went wrong.');
    expect(messageOf('nope')).toBe('Something went wrong.');
  });
});

describe('Show in Finder', () => {
  it('asks the engine to show the family’s folder', async () => {
    const { actions, deps, notice } = setup();
    await actions.reveal('heebo');
    expect(deps.reveal).toHaveBeenCalledWith('heebo');
    expect(notice.error).not.toHaveBeenCalled();
  });

  it('says the engine’s sentence when it refuses, and does not reject', async () => {
    const { actions, notice } = setup({
      reveal: vi.fn().mockRejectedValue(new Error('Finder would not open it.')),
    });
    await expect(actions.reveal('heebo')).resolves.toBeUndefined();
    expect(notice.error).toHaveBeenCalledWith('Finder would not open it.');
  });
});

describe('Copy @name', () => {
  it('puts @<family> on the clipboard and says so', async () => {
    const { actions, deps, notice } = setup();
    await actions.copyToken('Amatic SC');
    expect(deps.copyText).toHaveBeenCalledWith('@Amatic SC');
    expect(notice.info).toHaveBeenCalledWith('Copied @Amatic SC');
  });

  it('says so when the clipboard refuses', async () => {
    const { actions, notice } = setup({ copyText: vi.fn().mockRejectedValue(new Error('denied')) });
    await actions.copyToken('Heebo');
    expect(notice.error).toHaveBeenCalledWith('The clipboard did not take it.');
    expect(notice.info).not.toHaveBeenCalled();
  });
});

describe('Delete', () => {
  it('deletes the family and says nothing when it went to the Trash', async () => {
    const { actions, deps, notice } = setup();
    await expect(actions.remove('heebo', 'Heebo')).resolves.toBe(true);
    expect(deps.remove).toHaveBeenCalledWith('heebo');
    expect(notice.info).not.toHaveBeenCalled();
    expect(notice.error).not.toHaveBeenCalled();
  });

  it('says where the files are when macOS would not take them to the Trash', async () => {
    const { actions, notice } = setup({
      remove: vi.fn().mockResolvedValue({ ok: true, where: '/Users/owner/Studio Inbox/_Deleted' }),
    });
    await expect(actions.remove('heebo', 'Heebo')).resolves.toBe(true);
    expect(notice.info).toHaveBeenCalledWith(
      '“Heebo” is deleted, but not in the Trash',
      'macOS would not take it there, so it is in /Users/owner/Studio Inbox/_Deleted.',
    );
  });

  it('says the engine’s sentence and keeps the family when it refuses', async () => {
    const { actions, notice } = setup({
      remove: vi.fn().mockRejectedValue(new Error('Could not move Heebo to the Trash.')),
    });
    await expect(actions.remove('heebo', 'Heebo')).resolves.toBe(false);
    expect(notice.error).toHaveBeenCalledWith('Could not move Heebo to the Trash.');
  });
});

describe('runDelete', () => {
  const target = { slug: 'heebo', name: 'Heebo' };

  it('keeps the dialog waiting until the engine has answered, then closes it', async () => {
    const calls: string[] = [];
    let answer: (value: boolean) => void = () => {};
    const remove = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const run = runDelete(target, remove, {
      setPending: (pending) => calls.push(`pending:${pending}`),
      close: () => calls.push('close'),
    });
    expect(calls).toEqual(['pending:true']);
    answer(true);
    await expect(run).resolves.toBe(true);
    expect(calls).toEqual(['pending:true', 'pending:false', 'close']);
    expect(remove).toHaveBeenCalledWith('heebo', 'Heebo');
  });

  it('closes the dialog even when the family stays', async () => {
    const calls: string[] = [];
    await expect(
      runDelete(target, async () => false, {
        setPending: (pending) => calls.push(`pending:${pending}`),
        close: () => calls.push('close'),
      }),
    ).resolves.toBe(false);
    expect(calls).toEqual(['pending:true', 'pending:false', 'close']);
  });
});
