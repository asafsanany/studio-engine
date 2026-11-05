import { toast } from 'sonner';

/** The toast of a copy: one id, so copying twice replaces the note instead of stacking another. */
export const COPY_REEL_LINK_TOAST_ID = 'copy-reel-link';

/** How long the toast stays: it only confirms a click, so it is short. */
export const COPY_REEL_LINK_TOAST_MS = 2000;

type Notify = (message: string, options: { id: string; duration: number }) => unknown;

export interface CopyReelLinkDeps {
  /** `navigator.clipboard.writeText`, or a stand-in in tests. */
  writeText: (text: string) => Promise<void>;
  /** `toast.success` and `toast.error` of sonner, or stand-ins in tests. */
  notify: { success: Notify; error: Notify };
}

/** `navigator.clipboard.writeText`, rejecting (instead of throwing) when the API is unavailable. */
function writeToClipboard(text: string): Promise<void> {
  if (!navigator.clipboard) return Promise.reject(new Error('Clipboard API unavailable'));
  return navigator.clipboard.writeText(text);
}

/**
 * Copy link, from a reel's right-click menu: puts the reel's address on the clipboard and says so in
 * a short toast ("Link copied"), or says it could not ("Couldn't copy the link"). The menu closes
 * by itself when the item is chosen, so the toast is the only sign of the copy. Resolves to whether
 * the address was copied.
 */
export async function copyReelLink(
  url: string,
  { writeText = writeToClipboard, notify = toast }: Partial<CopyReelLinkDeps> = {},
): Promise<boolean> {
  try {
    await writeText(url);
  } catch {
    notify.error("Couldn't copy the link", {
      id: COPY_REEL_LINK_TOAST_ID,
      duration: COPY_REEL_LINK_TOAST_MS,
    });
    return false;
  }
  notify.success('Link copied', {
    id: COPY_REEL_LINK_TOAST_ID,
    duration: COPY_REEL_LINK_TOAST_MS,
  });
  return true;
}
