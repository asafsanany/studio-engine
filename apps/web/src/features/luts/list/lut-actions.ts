import {
  cleanLutName,
  type DeleteLutResponse,
  type LutDetail,
  type UpdateLutRequest,
} from '@studio/shared';
import { wentToTrash } from './lut-list';

// What a row of the LUTs list can do (rename, show in Finder, duplicate, copy @luts/name, delete).
// The page hands each one the engine's mutations (LU0's hooks) and a way to say things; everything
// that decides lives here, so a test can drive it with plain functions. The engine decides what is
// allowed (422 for a name, 403 for a built-in LUT, 404 for a file that is gone), so every refusal
// is shown in the engine's own words and nothing is guessed on this side.

/** How the list says something. The page uses toasts. */
export interface LutNotice {
  /** A refusal or a failure: the engine's sentence. */
  error(message: string): void;
  /** A plain note, with an optional line of detail under it. */
  info(title: string, detail?: string): void;
}

/** What the actions need: the engine's mutations, the clipboard, a way to speak. */
export interface LutActionDeps {
  update(variables: { slug: string; patch: UpdateLutRequest }): Promise<LutDetail>;
  duplicate(slug: string): Promise<LutDetail>;
  reveal(slug: string): Promise<unknown>;
  remove(slug: string): Promise<DeleteLutResponse>;
  /** Puts text on the clipboard. */
  copyText(text: string): Promise<void>;
  notice: LutNotice;
}

/** The actions of a row. Each resolves when it has finished; none rejects (refusals are said). */
export interface LutActions {
  /** Resolves the LUT's new slug when the engine took the name, `null` when it refused. */
  rename(slug: string, name: string): Promise<string | null>;
  duplicate(slug: string): Promise<void>;
  reveal(slug: string): Promise<void>;
  /** Copies `@luts/<slug>`. */
  copyToken(slug: string): Promise<void>;
  /** Resolves `true` when the LUT is gone. */
  remove(slug: string, name: string): Promise<boolean>;
}

/** What went wrong, in words: an `ApiError`'s sentence, or a plain one for anything else. */
export function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'Something went wrong.';
}

/** What typing a new name into a row comes to. */
export type RenameOutcome =
  | { kind: 'save'; name: string }
  /** Nothing to save: it is empty, or it is the name the LUT has. */
  | { kind: 'cancel' };

/**
 * A rename is saved when the typed name, cleaned the way the engine cleans it, is not empty and is
 * not what the LUT is called already. Anything else puts the old name back without asking.
 */
export function renameOutcome(current: string, typed: string): RenameOutcome {
  const cleaned = cleanLutName(typed);
  if (cleaned === '' || cleaned === current) return { kind: 'cancel' };
  return { kind: 'save', name: typed };
}

/** The token a note writes to use a LUT. */
export function lutToken(slug: string): string {
  return `@luts/${slug}`;
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
 * closes whatever the answer was. A refusal is said by the action itself (a toast), and the LUT
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

export function createLutActions(deps: LutActionDeps): LutActions {
  const { notice } = deps;

  return {
    async rename(slug, name) {
      try {
        return (await deps.update({ slug, patch: { name } })).slug;
      } catch (error) {
        notice.error(messageOf(error));
        return null;
      }
    },
    async duplicate(slug) {
      try {
        await deps.duplicate(slug);
      } catch (error) {
        notice.error(messageOf(error));
      }
    },
    async reveal(slug) {
      try {
        await deps.reveal(slug);
      } catch (error) {
        notice.error(messageOf(error));
      }
    },
    async copyToken(slug) {
      try {
        await deps.copyText(lutToken(slug));
        notice.info(`Copied ${lutToken(slug)}`);
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
