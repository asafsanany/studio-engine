import {
  cleanGraphicName,
  type DeleteGraphicResponse,
  GRAPHIC_MESSAGES,
  type GraphicDetail,
  type GraphicMessage,
  type UpdateGraphicRequest,
} from '@studio/shared';
import { wentToTrash } from './graphic-list';

// What a row of the Graphics list can do (open, rename, duplicate, show in Finder, turn off / on
// for edits, retry, delete). The page hands each one the engine's mutations (GR0's hooks) and a way
// to say things; everything that decides lives here, so a test can drive it with plain functions.
// The engine decides what is allowed (409 while a version is being made, 422 for a name), so every
// refusal is shown in the engine's own words and nothing is guessed on this side.

/** How the list says something. The page uses toasts. */
export interface GraphicNotice {
  /** A refusal or a failure: the engine's sentence. */
  error(message: string): void;
  /** A plain note, with a line of detail under it. */
  info(title: string, detail: string): void;
}

/** What the actions need: the engine's mutations, a fresh read of one graphic, the router. */
export interface GraphicActionDeps {
  /** Goes to the graphic's page. */
  open(id: string): void;
  update(variables: { id: string; patch: UpdateGraphicRequest }): Promise<unknown>;
  duplicate(id: string): Promise<unknown>;
  reveal(id: string): Promise<unknown>;
  remove(id: string): Promise<DeleteGraphicResponse>;
  retryMessage(variables: { id: string; messageId: string }): Promise<unknown>;
  /** The graphic with its chat, as the engine has it now (a failed row's Retry needs the message). */
  loadDetail(id: string): Promise<GraphicDetail>;
  notice: GraphicNotice;
}

/** The actions of a row. Each resolves when it has finished; none rejects (refusals are said). */
export interface GraphicActions {
  open(id: string): void;
  /** Resolves `true` when the engine took the name. */
  rename(id: string, name: string): Promise<boolean>;
  duplicate(id: string): Promise<void>;
  reveal(id: string): Promise<void>;
  setUses(id: string, uses: boolean): Promise<void>;
  /** Makes the failed version again. */
  retry(id: string): Promise<void>;
  /** Resolves `true` when the graphic is gone. */
  remove(id: string, name: string): Promise<boolean>;
}

/** What went wrong, in words: an `ApiError`'s sentence, or a plain one for anything else. */
export function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'Something went wrong.';
}

/** What typing a new name into a row comes to. */
export type RenameOutcome =
  | { kind: 'save'; name: string }
  /** Nothing to save: it is empty, or it is the name the graphic has. */
  | { kind: 'cancel' };

/**
 * A rename is saved when the typed name, cleaned the way the engine cleans it, is not empty and
 * is not what the graphic is called already. Anything else puts the old name back without asking.
 */
export function renameOutcome(current: string, typed: string): RenameOutcome {
  const cleaned = cleanGraphicName(typed);
  if (cleaned === '' || cleaned === current) return { kind: 'cancel' };
  return { kind: 'save', name: typed };
}

/** Claude's newest row that failed (the one Retry makes again), or `undefined`. */
export function newestFailedMessage(
  detail: Pick<GraphicDetail, 'messages'>,
): GraphicMessage | undefined {
  const failed = detail.messages.filter(
    (message) => message.role === 'claude' && message.status === 'failed',
  );
  return failed.at(-1);
}

/** The graphics' fallback place (the Trash would not take the folder), said once, with the path. */
function announceFallback(name: string, where: string, notice: GraphicNotice): void {
  notice.info(
    `“${name}” is deleted, but not in the Trash`,
    `macOS would not take it there, so it is in ${where}.`,
  );
}

export function createGraphicActions(deps: GraphicActionDeps): GraphicActions {
  const { notice } = deps;

  /** Runs `request`; a refusal is said and answers `false`. */
  async function attempt(request: () => Promise<unknown>): Promise<boolean> {
    try {
      await request();
      return true;
    } catch (error) {
      notice.error(messageOf(error));
      return false;
    }
  }

  return {
    open: (id) => deps.open(id),
    rename: (id, name) => attempt(() => deps.update({ id, patch: { name } })),
    async duplicate(id) {
      await attempt(() => deps.duplicate(id));
    },
    async reveal(id) {
      await attempt(() => deps.reveal(id));
    },
    async setUses(id, uses) {
      await attempt(() => deps.update({ id, patch: { uses } }));
    },
    async retry(id) {
      await attempt(async () => {
        // The summary doesn't carry the failed row's id; the graphic's page does.
        const detail = await deps.loadDetail(id);
        const failed = newestFailedMessage(detail);
        if (failed === undefined) throw new Error(GRAPHIC_MESSAGES.notRetryable);
        await deps.retryMessage({ id, messageId: failed.id });
      });
    },
    async remove(id, name) {
      try {
        const answer = await deps.remove(id);
        if (!wentToTrash(answer.where)) announceFallback(name, answer.where, notice);
        return true;
      } catch (error) {
        notice.error(messageOf(error));
        return false;
      }
    },
  };
}
