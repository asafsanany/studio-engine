import { describe, expect, it, vi } from 'vitest';
import { COPY_TOAST_ID, COPY_TOAST_MS, copyError } from './copy-error';

function deps(writeText: (text: string) => Promise<void>) {
  const notify = { success: vi.fn(), error: vi.fn() };
  return { writeText: vi.fn(writeText), notify };
}

describe('copyError', () => {
  it('puts the whole error text on the clipboard and says so in a short toast', async () => {
    const d = deps(() => Promise.resolve());
    const error = 'Render stopped: not enough disk space.\nSee the job log.';
    await copyError(error, d);
    expect(d.writeText).toHaveBeenCalledWith(error);
    expect(d.notify.success).toHaveBeenCalledWith('Error copied', {
      id: COPY_TOAST_ID,
      duration: COPY_TOAST_MS,
    });
    expect(d.notify.error).not.toHaveBeenCalled();
  });

  it('keeps the toast short, and one at a time', () => {
    expect(COPY_TOAST_MS).toBeLessThanOrEqual(3000);
    expect(COPY_TOAST_ID).not.toBe('');
  });

  it('says it could not when the clipboard refuses, and does not claim a copy', async () => {
    const d = deps(() => Promise.reject(new Error('denied')));
    await copyError('boom', d);
    expect(d.notify.error).toHaveBeenCalledWith("Couldn't copy the error", {
      id: COPY_TOAST_ID,
      duration: COPY_TOAST_MS,
    });
    expect(d.notify.success).not.toHaveBeenCalled();
  });

  it('says it could not when there is no clipboard API at all', async () => {
    vi.stubGlobal('navigator', {});
    try {
      const notify = { success: vi.fn(), error: vi.fn() };
      await copyError('boom', { notify });
      expect(notify.error).toHaveBeenCalledTimes(1);
      expect(notify.success).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
