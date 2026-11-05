import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data';
import { REVEAL_TOAST_ID, revealClient } from './reveal-client';

describe('revealClient', () => {
  it('asks the engine to open the folder of that client, and says nothing when it works', async () => {
    const reveal = vi.fn().mockResolvedValue(undefined);
    const error = vi.fn();
    await revealClient('4d337086919d', { reveal, notify: { error } });
    expect(reveal).toHaveBeenCalledExactlyOnceWith('4d337086919d');
    expect(error).not.toHaveBeenCalled();
  });

  it("says why when the engine refuses (the client's folder is gone)", async () => {
    const reveal = vi.fn().mockRejectedValue(new ApiError(404, 'Client abc not found'));
    const error = vi.fn();
    await revealClient('abc', { reveal, notify: { error } });
    expect(error).toHaveBeenCalledExactlyOnceWith("Couldn't show the folder in Finder", {
      id: REVEAL_TOAST_ID,
      description: 'Client abc not found',
    });
  });

  it('says so when the engine cannot be reached', async () => {
    const reveal = vi
      .fn()
      .mockRejectedValue(new ApiError(0, 'Cannot reach the Studio Engine server.'));
    const error = vi.fn();
    await revealClient('abc', { reveal, notify: { error } });
    expect(error).toHaveBeenCalledWith(
      "Couldn't show the folder in Finder",
      expect.objectContaining({ description: 'Cannot reach the Studio Engine server.' }),
    );
  });

  it('never throws, whatever went wrong', async () => {
    const reveal = vi.fn().mockRejectedValue(new TypeError('boom'));
    const error = vi.fn();
    await expect(revealClient('abc', { reveal, notify: { error } })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("Couldn't show the folder in Finder", {
      id: REVEAL_TOAST_ID,
      description: undefined,
    });
  });
});
