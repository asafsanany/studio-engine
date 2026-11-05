import { toast } from 'sonner';
import { ApiError, api } from '@/data';

/** The toast of a failed reveal: one id, so a second try replaces the note instead of stacking. */
export const REVEAL_TOAST_ID = 'reveal-client';

type NotifyError = (message: string, options: { id: string; description?: string }) => unknown;

export interface RevealClientDeps {
  /** `api.revealClient`, or a stand-in in tests. */
  reveal: (clientId: string) => Promise<void>;
  /** `toast.error` of sonner, or a stand-in in tests. */
  notify: { error: NotifyError };
}

/**
 * Show in Finder, from a client's right-click menu: asks the engine to open the client's folder.
 * Finder coming to the front is the sign that it worked, so success says nothing; a refusal (the
 * folder is gone: 404) or an engine that cannot be reached is said in a toast.
 */
export async function revealClient(
  clientId: string,
  { reveal = (id) => api.revealClient(id), notify = toast }: Partial<RevealClientDeps> = {},
): Promise<void> {
  try {
    await reveal(clientId);
  } catch (error) {
    notify.error("Couldn't show the folder in Finder", {
      id: REVEAL_TOAST_ID,
      description: error instanceof ApiError ? error.message : undefined,
    });
  }
}
