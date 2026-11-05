// What the buttons of a graphic's page do (Graphics plan, "Studio"): Send, Stop, Retry, "Use vN
// again", rename, the switch, the When line, Show in Finder, Duplicate and Delete. Each one calls
// the graphics hooks' `mutateAsync` (passed in, so a test can pass mocks), says the server's own
// sentence in a toast when it refuses, and answers whether it worked, so the caller can close or
// keep what it was showing. No React.

import type {
  DeleteGraphicResponse,
  Effort,
  GraphicDetail,
  UpdateGraphicRequest,
} from '@studio/shared';
import type { GraphicSend } from '@/data';
import { wentToTrash } from '../list/graphic-list';
import { effortToSend } from './studio-logic';

/** A sentence for an error: the server's words (an ApiError's message), else the error's own. */
export function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return String(error);
}

// --- Send -----------------------------------------------------------------------------------------

export interface SubmitInput {
  /** The graphic the message goes to; `undefined` creates a new one (/graphics/new). */
  graphicId: string | undefined;
  /** The draft; may be empty when files are attached. */
  text: string;
  files: readonly File[];
  /** The level picked next to Send. The default goes as none. */
  effort: Effort;
  onProgress?: (percent: number) => void;
}

export interface SubmitDeps {
  create(send: GraphicSend): Promise<GraphicDetail>;
  send(input: { id: string; send: GraphicSend }): Promise<GraphicDetail>;
}

export type SubmitResult =
  | { ok: true; detail: GraphicDetail; created: boolean }
  | { ok: false; error: string };

/**
 * Sends the message: the first one of /graphics/new creates the graphic, every later one goes to
 * it. A message may be only files (the text is then empty). On a refusal (a version is being
 * made, a file is not allowed) `error` is the server's sentence and nothing was sent.
 */
export async function submitMessage(input: SubmitInput, deps: SubmitDeps): Promise<SubmitResult> {
  const send: GraphicSend = {
    text: input.text.trim(),
    effort: effortToSend(input.effort),
    files: input.files,
    onProgress: input.onProgress,
  };
  try {
    if (input.graphicId === undefined) {
      return { ok: true, detail: await deps.create(send), created: true };
    }
    return { ok: true, detail: await deps.send({ id: input.graphicId, send }), created: false };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

// --- the other buttons ----------------------------------------------------------------------------

/** The graphics hooks' `mutateAsync`, as the page's buttons use them. */
export interface StudioApi {
  stop(input: { id: string; messageId: string }): Promise<unknown>;
  retry(input: { id: string; messageId: string }): Promise<unknown>;
  restore(input: { id: string; version: number }): Promise<unknown>;
  update(input: { id: string; patch: UpdateGraphicRequest }): Promise<unknown>;
  duplicate(id: string): Promise<GraphicDetail>;
  reveal(id: string): Promise<unknown>;
  remove(id: string): Promise<DeleteGraphicResponse>;
}

export interface StudioActionDeps {
  /** The graphic's id. */
  id: string;
  api: StudioApi;
  /** How the page says things: a refusal in the server's words, or a plain note (toasts). */
  notify: StudioNotice;
  /** Duplicate worked: open the copy. */
  openGraphic(id: string): void;
  /** Delete worked: back to the library. Resolves once the library is open. */
  goToList(): Promise<unknown>;
}

/** How the page says something. */
export interface StudioNotice {
  /** A refusal or a failure: the engine's sentence. */
  error(message: string): void;
  /** A plain note, with a line of detail under it. */
  info(title: string, detail: string): void;
}

export interface StudioActions {
  stop(messageId: string): Promise<boolean>;
  retry(messageId: string): Promise<boolean>;
  /** "Use vN again". */
  restore(version: number): Promise<boolean>;
  rename(name: string): Promise<boolean>;
  setUses(uses: boolean): Promise<boolean>;
  /** Saves the When line, unless it is what the graphic has already. */
  saveWhen(text: string, current: string): Promise<boolean>;
  reveal(): Promise<boolean>;
  duplicate(): Promise<boolean>;
  /** Deletes the graphic named `name` and opens the library; says so when it did not go to the Trash. */
  remove(name: string): Promise<boolean>;
}

/** The page's buttons for graphic `deps.id`. */
export function createStudioActions(deps: StudioActionDeps): StudioActions {
  const { id, api } = deps;

  async function attempt(run: () => Promise<unknown>): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (error) {
      deps.notify.error(errorText(error));
      return false;
    }
  }

  return {
    stop: (messageId) => attempt(() => api.stop({ id, messageId })),
    retry: (messageId) => attempt(() => api.retry({ id, messageId })),
    restore: (version) => attempt(() => api.restore({ id, version })),
    rename: (name) => attempt(() => api.update({ id, patch: { name } })),
    setUses: (uses) => attempt(() => api.update({ id, patch: { uses } })),
    async saveWhen(text, current) {
      const when = text.trim();
      if (when === current.trim()) return true;
      return attempt(() => api.update({ id, patch: { when } }));
    },
    reveal: () => attempt(() => api.reveal(id)),
    async duplicate() {
      try {
        const copy = await api.duplicate(id);
        deps.openGraphic(copy.id);
        return true;
      } catch (error) {
        deps.notify.error(errorText(error));
        return false;
      }
    },
    async remove(name) {
      let answer: DeleteGraphicResponse;
      try {
        answer = await api.remove(id);
      } catch (error) {
        deps.notify.error(errorText(error));
        return false;
      }
      // The library says it next to the list, where the graphic is no longer.
      await deps.goToList();
      if (!wentToTrash(answer.where)) {
        deps.notify.info(
          `“${name}” is deleted, but not in the Trash`,
          `macOS would not take it there, so it is in ${answer.where}.`,
        );
      }
      return true;
    },
  };
}
