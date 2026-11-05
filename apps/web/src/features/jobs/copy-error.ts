import { toast } from 'sonner';

/** The toast of a copy: one id, so copying twice replaces the note instead of stacking another. */
export const COPY_TOAST_ID = 'copy-error';

/** How long the toast stays: it only confirms a click, so it is shorter than a refusal's. */
export const COPY_TOAST_MS = 2000;

type Notify = (message: string, options: { id: string; duration: number }) => unknown;

export interface CopyErrorDeps {
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
 * Copy error, from the row's right-click menu: puts the job's full error text on the clipboard and
 * says so in a short toast ("Error copied"), or says it could not ("Couldn't copy the error").
 * The menu closes by itself when the item is chosen, so the toast is the only sign of the copy.
 * Resolves to whether the text was copied, for the phone sheet's button, which says "Copied".
 */
export async function copyError(
  text: string,
  { writeText = writeToClipboard, notify = toast }: Partial<CopyErrorDeps> = {},
): Promise<boolean> {
  try {
    await writeText(text);
  } catch {
    notify.error("Couldn't copy the error", { id: COPY_TOAST_ID, duration: COPY_TOAST_MS });
    return false;
  }
  notify.success('Error copied', { id: COPY_TOAST_ID, duration: COPY_TOAST_MS });
  return true;
}
