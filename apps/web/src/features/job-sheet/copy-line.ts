// Copy for the line to post with the file that has no song (Songs, SG9): the text goes on the
// clipboard and the button says "Copied" for two seconds. A copy that fails says so in a toast and
// the button stays "Copy".

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

/** How long the button says "Copied". */
export const COPIED_MS = 2000;

/** The toast of a copy that failed: one id, so pressing twice replaces the note. */
export const COPY_LINE_TOAST_ID = 'copy-line';

export const COPY_LINE_FAILED = 'Couldn’t copy the line';

export interface CopyLineDeps {
  /** `navigator.clipboard.writeText`, or a stand-in in tests. */
  writeText: (text: string) => Promise<void>;
  /** sonner's `toast.error`, or a stand-in in tests. */
  notifyError: (message: string, options: { id: string; duration: number }) => unknown;
}

/** `navigator.clipboard.writeText`, rejecting (instead of throwing) when the API is unavailable. */
function writeToClipboard(text: string): Promise<void> {
  if (!navigator.clipboard) return Promise.reject(new Error('Clipboard API unavailable'));
  return navigator.clipboard.writeText(text);
}

/** Puts `text` on the clipboard. Resolves to whether it got there; a failure is a toast. */
export async function copyLine(
  text: string,
  { writeText = writeToClipboard, notifyError = toast.error }: Partial<CopyLineDeps> = {},
): Promise<boolean> {
  try {
    await writeText(text);
    return true;
  } catch {
    notifyError(COPY_LINE_FAILED, { id: COPY_LINE_TOAST_ID, duration: COPIED_MS });
    return false;
  }
}

/** `copied` is true for two seconds after `copy()` put the text on the clipboard. */
export function useCopyLine(text: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    copied,
    copy() {
      void copyLine(text).then((ok) => {
        if (!ok) return;
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      });
    },
  };
}
