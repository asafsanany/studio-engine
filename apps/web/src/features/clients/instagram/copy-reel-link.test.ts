import { describe, expect, it, vi } from 'vitest';
import { COPY_REEL_LINK_TOAST_ID, COPY_REEL_LINK_TOAST_MS, copyReelLink } from './copy-reel-link';

const URL = 'https://www.instagram.com/reel/Falcon21/';

function deps(writeText: (text: string) => Promise<void>) {
  return { writeText, notify: { success: vi.fn(), error: vi.fn() } };
}

describe('copyReelLink', () => {
  it('puts the reel’s address on the clipboard and says "Link copied"', async () => {
    const copy = deps(vi.fn().mockResolvedValue(undefined));
    expect(await copyReelLink(URL, copy)).toBe(true);
    expect(copy.writeText).toHaveBeenCalledWith(URL);
    expect(copy.notify.success).toHaveBeenCalledWith('Link copied', {
      id: COPY_REEL_LINK_TOAST_ID,
      duration: COPY_REEL_LINK_TOAST_MS,
    });
    expect(copy.notify.error).not.toHaveBeenCalled();
  });

  it('says it could not when the clipboard refuses', async () => {
    const copy = deps(vi.fn().mockRejectedValue(new Error('denied')));
    expect(await copyReelLink(URL, copy)).toBe(false);
    expect(copy.notify.error).toHaveBeenCalledWith("Couldn't copy the link", {
      id: COPY_REEL_LINK_TOAST_ID,
      duration: COPY_REEL_LINK_TOAST_MS,
    });
    expect(copy.notify.success).not.toHaveBeenCalled();
  });
});
