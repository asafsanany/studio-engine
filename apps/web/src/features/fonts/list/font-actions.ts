import type { DeleteFontResponse } from '@studio/shared';
import { wentToTrash } from '@/features/graphics/list/graphic-list';
import { fontToken } from './font-list';

// What a row of the Fonts list can do (Show in Finder, Copy @name, Delete). The page hands each one
// the engine's mutations (FN1's hooks) and a way to say things; everything that decides lives here,
// so a test can drive it with plain functions. The engine decides what is allowed (404 for a family
// that is gone, a plain sentence when macOS would not do it), so every refusal is shown in the
// engine's own words and nothing is guessed on this side.

/** How the list says something. The page uses toasts. */
export interface FontNotice {
  /** A refusal or a failure: the engine's sentence. */
  error(message: string): void;
  /** A plain note, with an optional line of detail under it. */
  info(title: string, detail?: string): void;
}

/** What the actions need: the engine's mutations, the clipboard, a way to speak. */
export interface FontActionDeps {
  reveal(slug: string): Promise<unknown>;
  remove(slug: string): Promise<DeleteFontResponse>;
  /** Puts text on the clipboard. */
  copyText(text: string): Promise<void>;
  notice: FontNotice;
}

/** The actions of a row. Each resolves when it has finished; none rejects (refusals are said). */
export interface FontActions {
  /** Opens the family's folder in Finder. */
  reveal(slug: string): Promise<void>;
  /** Copies `@<family>` (the Regular weight's token). */
  copyToken(name: string): Promise<void>;
  /** Resolves `true` when the family is gone. */
  remove(slug: string, name: string): Promise<boolean>;
}

/** What went wrong, in words: an `ApiError`'s sentence, or a plain one for anything else. */
export function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'Something went wrong.';
}

/** What the Delete… dialog does while the engine works and when it is done. */
export interface DeleteDialogUi {
  /** Both buttons wait while the delete is on its way. */
  setPending(pending: boolean): void;
  /** Closes the dialog. */
  close(): void;
}

/**
 * Delete was pressed: the dialog waits (spinner, "Deleting…") until the engine has answered, then
 * closes whatever the answer was. A refusal is said by the action itself (a toast), and the family
 * stays in the list.
 */
export async function runDelete(
  target: { slug: string; name: string },
  remove: (slug: string, name: string) => Promise<boolean>,
  ui: DeleteDialogUi,
): Promise<boolean> {
  ui.setPending(true);
  try {
    return await remove(target.slug, target.name);
  } finally {
    ui.setPending(false);
    ui.close();
  }
}

export function createFontActions(deps: FontActionDeps): FontActions {
  const { notice } = deps;

  return {
    async reveal(slug) {
      try {
        await deps.reveal(slug);
      } catch (error) {
        notice.error(messageOf(error));
      }
    },
    async copyToken(name) {
      const token = fontToken(name);
      try {
        await deps.copyText(token);
        notice.info(`Copied ${token}`);
      } catch {
        notice.error('The clipboard did not take it.');
      }
    },
    async remove(slug, name) {
      try {
        const answer = await deps.remove(slug);
        if (!wentToTrash(answer.where)) {
          notice.info(
            `“${name}” is deleted, but not in the Trash`,
            `macOS would not take it there, so it is in ${answer.where}.`,
          );
        }
        return true;
      } catch (error) {
        notice.error(messageOf(error));
        return false;
      }
    },
  };
}
