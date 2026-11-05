// The "Instagram…" dialog (Clients × Instagram, board CLStates S1): a client's Instagram account (a
// name or a link) and the day the work together started. It opens from a client's right-click menu,
// from the empty state on the client page (S8), from a scan that cannot run (S3, Edit account), and
// New client has the same field. The same dialog edits the account later and has Remove Instagram.
//
// This is the dialog's logic, with no React: the words, the store the page's host reads
// (`askToEditInstagram` opens it, like Assign to… and Rename…), what the fields say about
// themselves, and the two requests (Save and scan, Remove Instagram). `InstagramDialog.tsx` draws
// it and sends the requests.

import { normalizeInstagramHandle, type SetClientInstagramRequest } from '@studio/shared';
import { createStore, type StoreApi, useStore } from 'zustand';
import { readSinceText, sinceDayText } from './instagram-since';
import { shortDayText, type TextOptions } from './instagram-text';

/** The words of the dialog. */
export const INSTAGRAM_DIALOG_TEXT = {
  description: 'Scanned now, then every Monday. About $0.05 a week.',
  handleLabel: 'Instagram account',
  handlePlaceholder: '@name or instagram.com/name',
  handleHint: 'A name or a link. It must be public (a business or creator account is best).',
  sinceLabel: 'Working together since',
  sincePlaceholder: '1 Aug 2026',
  /** Under the day when the client has no delivery yet. */
  sinceHintNoDelivery:
    'Set the day you started working together, or leave it empty to start from the first delivery.',
  cancel: 'Cancel',
  save: 'Save and scan',
  saving: 'Saving…',
  remove: 'Remove Instagram',
  removeTitle: 'Remove Instagram?',
  removing: 'Removing…',
  /** After a day that has not come yet. */
  sinceInFuture: 'That day has not come yet.',
  /** After text that is no day. */
  sinceNotADay: 'Type a day like 1 Aug 2026, or pick one from the calendar.',
  /** The calendar button's label. */
  pickDay: 'Pick a day',
  failed: 'Couldn’t save that.',
  removeFailed: 'Couldn’t remove that.',
} as const;

/** "Instagram · Falcon FPV": the dialog's title. */
export function instagramDialogTitle(clientName: string): string {
  return clientName === '' ? 'Instagram' : `Instagram · ${clientName}`;
}

/**
 * The line under the day: where the first delivery is (so that an earlier day is easy to see), or
 * what an empty day means when the client has not had a delivery yet.
 */
export function sinceHint(firstDeliveryDay: string | null, options: TextOptions = {}): string {
  if (firstDeliveryDay === null) return INSTAGRAM_DIALOG_TEXT.sinceHintNoDelivery;
  return `The first delivery is ${shortDayText(firstDeliveryDay, options)}. Set an earlier date for work from before Studio Engine.`;
}

/** What "Remove Instagram?" says: the reading stops, and what was read stays. */
export function removeDescription(handle: string, clientName: string): string {
  const who = clientName === '' ? 'this client' : clientName;
  return `Studio Engine stops reading @${handle} for ${who}. The scans and reels it has read so far are kept.`;
}

/** What Save and scan would send, or what is wrong with the fields (one sentence each). */
export type InstagramFields =
  | { ok: true; request: { handle: string; since: string | null } }
  | { ok: false; handleProblem: string | null; sinceProblem: string | null };

/**
 * What is wrong with the day field's text: it is no day ("1 Aug 2026", "2026-08-01" and "1/8/2026"
 * are), or the day has not come. `null` when it is empty (the client's first delivery counts) or fine.
 */
export function sinceProblemOf(since: string, today: string): string | null {
  const reading = readSinceText(since);
  if (reading.kind === 'invalid') return INSTAGRAM_DIALOG_TEXT.sinceNotADay;
  if (reading.kind === 'day' && reading.day > today) return INSTAGRAM_DIALOG_TEXT.sinceInFuture;
  return null;
}

/**
 * The fields as the server will read them. The handle goes through the engine's own rule
 * (`normalizeInstagramHandle`: a name, `@name` or a profile link; its sentence says what is wrong),
 * so the answer comes without a round trip. The day is empty (the client's first delivery counts)
 * or a real calendar day, typed or picked, that is not after `today`; it is sent as YYYY-MM-DD.
 */
export function instagramFields(handle: string, since: string, today: string): InstagramFields {
  const parsed = normalizeInstagramHandle(handle);
  const sinceProblem = sinceProblemOf(since, today);
  if (!parsed.ok || sinceProblem !== null) {
    return {
      ok: false,
      handleProblem: parsed.ok ? null : parsed.error,
      sinceProblem,
    };
  }
  const reading = readSinceText(since);
  return {
    ok: true,
    request: { handle: parsed.handle, since: reading.kind === 'day' ? reading.day : null },
  };
}

/** The sentence under the handle field for what is typed; `null` when it is fine or still empty. */
export function handleProblemOf(handle: string): string | null {
  if (handle.trim() === '') return null;
  const parsed = normalizeInstagramHandle(handle);
  return parsed.ok ? null : parsed.error;
}

/** The account the dialog starts from when the client has one. */
export interface InstagramDialogAccount {
  handle: string;
  /** "Working together since"; `null` when the client's first delivery counts. */
  since: string | null;
}

export type InstagramDialogStep = 'edit' | 'remove';

/**
 * The Instagram dialog, kept at page level like Rename client: a menu or a button only asks
 * (`askToEditInstagram`), the page shows the dialog (`InstagramDialogHost`) and sends the requests.
 *
 * `clientId` is who it is about (`null` while no dialog shows; the fields keep what they had until the
 * next time it is asked for, so the dialog does not empty while it fades out). `hydrated` says the fields hold the
 * client's own account, or that it has none (they start empty); until then the fields wait for the
 * engine's answer. `handle` and `since` are what is typed (`since` as the field shows a day,
 * "1 Aug 2026"; `instagramFields` reads it back). `handleProblem` and `sinceProblem` are
 * what to say under them (only after the person tried to save, or left the handle box). `step` is
 * `remove` while Remove Instagram asks. `error` is the server's reason when a request failed.
 */
export interface InstagramDialogState {
  clientId: string | null;
  /** How many times the dialog has been asked for: a new one starts from the engine's answer again. */
  opening: number;
  hydrated: boolean;
  /** The client has an Instagram account (so the dialog edits it and offers Remove Instagram). */
  hasAccount: boolean;
  /** The handle of that account as it is saved (what Remove Instagram names), whatever is typed. */
  accountHandle: string;
  handle: string;
  since: string;
  handleProblem: string | null;
  sinceProblem: string | null;
  step: InstagramDialogStep;
  pending: boolean;
  error: string | null;
  ask: (clientId: string) => void;
  /** The engine's answer for the client arrived: the account (or none) the fields start from. Once per opening. */
  hydrate: (account: InstagramDialogAccount | null) => void;
  setHandle: (handle: string) => void;
  setSince: (since: string) => void;
  /** The handle box was left: say what is wrong with it. */
  checkHandle: () => void;
  /** The day box was left: write a day it can read in the field's words, or say what is wrong with it. */
  checkSince: (today: string) => void;
  setProblems: (handleProblem: string | null, sinceProblem: string | null) => void;
  askToRemove: () => void;
  keep: () => void;
  setPending: (pending: boolean) => void;
  fail: (error: string) => void;
  dismiss: () => void;
}

const CLOSED = {
  clientId: null,
  opening: 0,
  hydrated: false,
  hasAccount: false,
  accountHandle: '',
  handle: '',
  since: '',
  handleProblem: null,
  sinceProblem: null,
  step: 'edit',
  pending: false,
  error: null,
} as const;

export function createInstagramDialogStore(
  // A server render reads a store's initial state, so tests build one already in the state to see.
  initial: Partial<
    Pick<
      InstagramDialogState,
      | 'clientId'
      | 'opening'
      | 'hydrated'
      | 'hasAccount'
      | 'accountHandle'
      | 'handle'
      | 'since'
      | 'handleProblem'
      | 'sinceProblem'
      | 'step'
      | 'pending'
      | 'error'
    >
  > = {},
): StoreApi<InstagramDialogState> {
  return createStore<InstagramDialogState>()((set) => ({
    ...CLOSED,
    ...initial,
    ask: (clientId) => set((state) => ({ ...CLOSED, clientId, opening: state.opening + 1 })),
    hydrate: (account) =>
      set((state) =>
        state.clientId === null || state.hydrated
          ? state
          : {
              hydrated: true,
              hasAccount: account !== null,
              accountHandle: account?.handle ?? '',
              handle: account?.handle ?? '',
              since: account?.since == null ? '' : sinceDayText(account.since),
            },
      ),
    // Typing again clears what was said about the field, and the server's last answer.
    setHandle: (handle) => set({ handle, handleProblem: null, error: null }),
    setSince: (since) => set({ since, sinceProblem: null, error: null }),
    checkHandle: () => set((state) => ({ handleProblem: handleProblemOf(state.handle) })),
    checkSince: (today) =>
      set((state) => {
        const reading = readSinceText(state.since);
        return {
          // "2026-08-01" or "1/8/2026" becomes "1 Aug 2026"; text that is no day stays as typed.
          since: reading.kind === 'day' ? sinceDayText(reading.day) : state.since,
          sinceProblem: sinceProblemOf(state.since, today),
        };
      }),
    setProblems: (handleProblem, sinceProblem) => set({ handleProblem, sinceProblem }),
    askToRemove: () => set({ step: 'remove', error: null }),
    keep: () => set({ step: 'edit', error: null }),
    setPending: (pending) => set({ pending, error: null }),
    fail: (error) => set({ pending: false, error }),
    dismiss: () => set({ clientId: null, pending: false }),
  }));
}

export const instagramDialogStore = createInstagramDialogStore();

/** Asks the page for the Instagram dialog of a client (it reads the client's account itself). */
export function askToEditInstagram(clientId: string): void {
  instagramDialogStore.getState().ask(clientId);
}

export function useInstagramDialog(store: StoreApi<InstagramDialogState> = instagramDialogStore) {
  return useStore(store);
}

/** What `confirmSaveInstagram` needs from the page. */
export interface SaveInstagramDeps {
  /** `PUT /api/clients/:clientId/instagram`: the account is saved and the first scan queued. */
  save: (clientId: string, account: SetClientInstagramRequest) => Promise<unknown>;
  /** The account is saved: tells the person. */
  onSaved: (clientId: string, handle: string) => void;
  /** Today's calendar day (YYYY-MM-DD), the latest day the work can have started. */
  today: () => string;
}

/**
 * Save and scan was pressed (or Enter): checks the fields, sends them and waits for the answer. What
 * is wrong with a field is said under it; a refusal from the server (or an engine that did not
 * answer) is said in the dialog. When it is saved the dialog closes and the page is told. Does
 * nothing while the fields are not the client's yet or a request is on its way. Resolves with the
 * handle that was saved, or `null` when nothing was.
 */
export async function confirmSaveInstagram(
  deps: SaveInstagramDeps,
  store: StoreApi<InstagramDialogState> = instagramDialogStore,
): Promise<string | null> {
  const { clientId, hydrated, handle, since, pending, step } = store.getState();
  if (clientId === null || !hydrated || pending || step !== 'edit') return null;
  const fields = instagramFields(handle, since, deps.today());
  if (!fields.ok) {
    store.getState().setProblems(fields.handleProblem, fields.sinceProblem);
    return null;
  }
  store.getState().setPending(true);
  try {
    await deps.save(clientId, fields.request);
  } catch (err) {
    store.getState().fail(err instanceof Error ? err.message : INSTAGRAM_DIALOG_TEXT.failed);
    return null;
  }
  store.getState().dismiss();
  deps.onSaved(clientId, fields.request.handle);
  return fields.request.handle;
}

/** What `confirmRemoveInstagram` needs from the page. */
export interface RemoveInstagramDeps {
  /** `DELETE /api/clients/:clientId/instagram`. */
  remove: (clientId: string) => Promise<unknown>;
  /** The account is removed: tells the person. */
  onRemoved: (clientId: string, handle: string) => void;
}

/**
 * Remove Instagram was confirmed: sends it and waits. A refusal is said in the dialog, which stays
 * on its question. When it is done the dialog closes and the page is told. Resolves with whether
 * the account was removed.
 */
export async function confirmRemoveInstagram(
  deps: RemoveInstagramDeps,
  store: StoreApi<InstagramDialogState> = instagramDialogStore,
): Promise<boolean> {
  const { clientId, hasAccount, accountHandle, pending, step } = store.getState();
  if (clientId === null || !hasAccount || pending || step !== 'remove') return false;
  store.getState().setPending(true);
  try {
    await deps.remove(clientId);
  } catch (err) {
    store.getState().fail(err instanceof Error ? err.message : INSTAGRAM_DIALOG_TEXT.removeFailed);
    return false;
  }
  store.getState().dismiss();
  deps.onRemoved(clientId, accountHandle);
  return true;
}
