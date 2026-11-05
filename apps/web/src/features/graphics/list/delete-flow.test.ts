import { describe, expect, it, vi } from 'vitest';
import { runDelete } from './delete-flow';

const target = { id: '3f9a1c2b7d4e', name: 'Name on a white pill' };

function ui() {
  const calls: string[] = [];
  return {
    calls,
    ui: {
      setPending: vi.fn((pending: boolean) => calls.push(`pending:${pending}`)),
      close: vi.fn(() => calls.push('close')),
    },
  };
}

describe('runDelete', () => {
  it('waits while the engine works, then stops waiting and closes the dialog', async () => {
    const { calls, ui: dialog } = ui();
    const remove = vi.fn(async () => {
      calls.push('request');
      return true;
    });
    await expect(runDelete(target, remove, dialog)).resolves.toBe(true);
    expect(remove).toHaveBeenCalledExactlyOnceWith(target.id, target.name);
    expect(calls).toEqual(['pending:true', 'request', 'pending:false', 'close']);
  });

  it('closes the dialog when the engine refused too (the refusal is said by the action)', async () => {
    const { calls, ui: dialog } = ui();
    await expect(runDelete(target, async () => false, dialog)).resolves.toBe(false);
    expect(calls).toEqual(['pending:true', 'pending:false', 'close']);
  });

  it('closes the dialog even when the request throws', async () => {
    const { calls, ui: dialog } = ui();
    await expect(
      runDelete(
        target,
        async () => {
          throw new Error('boom');
        },
        dialog,
      ),
    ).rejects.toThrow('boom');
    expect(calls).toEqual(['pending:true', 'pending:false', 'close']);
  });
});
