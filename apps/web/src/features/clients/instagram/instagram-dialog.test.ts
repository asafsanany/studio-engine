import { describe, expect, it, vi } from 'vitest';
import {
  confirmRemoveInstagram,
  confirmSaveInstagram,
  createInstagramDialogStore,
  handleProblemOf,
  INSTAGRAM_DIALOG_TEXT,
  instagramDialogTitle,
  instagramFields,
  removeDescription,
  sinceHint,
} from './instagram-dialog';

const TODAY = '2026-10-30';
const FALCON = 'a1b2c3d4e5f6';

/** A dialog that has been asked for and has the client's fields (the engine's answer is in). */
function opened(account: { handle: string; since: string | null } | null = null) {
  const store = createInstagramDialogStore();
  store.getState().ask(FALCON);
  store.getState().hydrate(account);
  return store;
}

describe('the words', () => {
  it('titles the dialog with the client, as the board does', () => {
    expect(instagramDialogTitle('Falcon FPV')).toBe('Instagram · Falcon FPV');
    expect(instagramDialogTitle('')).toBe('Instagram');
  });

  it('says what a scan costs and when it runs', () => {
    expect(INSTAGRAM_DIALOG_TEXT.description).toBe(
      'Scanned now, then every Monday. About $0.05 a week.',
    );
    expect(INSTAGRAM_DIALOG_TEXT.handleHint).toBe(
      'A name or a link. It must be public (a business or creator account is best).',
    );
  });

  it('names the first delivery under the day, and says what empty means without one', () => {
    expect(sinceHint('2026-10-12', { now: Date.parse('2026-10-30T10:00:00Z') })).toBe(
      'The first delivery is 12 Oct. Set an earlier date for work from before Studio Engine.',
    );
    expect(sinceHint(null)).toContain('leave it empty');
  });

  it('says the history is kept when the account is removed', () => {
    expect(removeDescription('falcon.fpv', 'Falcon FPV')).toBe(
      'Studio Engine stops reading @falcon.fpv for Falcon FPV. The scans and reels it has read so far are kept.',
    );
  });
});

describe('instagramFields', () => {
  it('reads a name, an @name and a profile link as the same handle', () => {
    for (const typed of [
      'falcon.fpv',
      '@Falcon.FPV',
      'https://www.instagram.com/falcon.fpv/?igsh=abc',
    ]) {
      expect(instagramFields(typed, '', TODAY)).toEqual({
        ok: true,
        request: { handle: 'falcon.fpv', since: null },
      });
    }
  });

  it('keeps a real day that is not after today', () => {
    expect(instagramFields('falcon.fpv', '2026-08-01', TODAY)).toEqual({
      ok: true,
      request: { handle: 'falcon.fpv', since: '2026-08-01' },
    });
    expect(instagramFields('falcon.fpv', TODAY, TODAY)).toMatchObject({ ok: true });
  });

  it('sends the day as YYYY-MM-DD however it was typed or picked', () => {
    for (const typed of [
      '1 Aug 2026',
      '1 august 2026',
      '1/8/2026',
      '2026-08-01',
      '  1 Aug 2026 ',
    ]) {
      expect(instagramFields('falcon.fpv', typed, TODAY)).toEqual({
        ok: true,
        request: { handle: 'falcon.fpv', since: '2026-08-01' },
      });
    }
    expect(instagramFields('falcon.fpv', '   ', TODAY)).toMatchObject({
      ok: true,
      request: { since: null },
    });
  });

  it('says the engine’s own sentence for a handle that is none', () => {
    expect(instagramFields('', '', TODAY)).toEqual({
      ok: false,
      handleProblem: 'Give the client’s Instagram handle or profile link.',
      sinceProblem: null,
    });
    expect(instagramFields('falcon fpv', '', TODAY)).toMatchObject({
      ok: false,
      handleProblem: 'An Instagram handle has no spaces.',
    });
    expect(instagramFields('instagram.com/p/C9xYz12AbCd/', '', TODAY)).toMatchObject({
      ok: false,
      handleProblem: 'That link is a post, not a profile. Paste the profile’s link or handle.',
    });
    expect(instagramFields('https://example.com/falcon', '', TODAY)).toMatchObject({
      ok: false,
      handleProblem: 'That is not an Instagram profile link.',
    });
    expect(instagramFields('falcon$', '', TODAY)).toMatchObject({
      ok: false,
      handleProblem: 'An Instagram handle has only letters, numbers, dots and underscores.',
    });
    expect(instagramFields('a'.repeat(31), '', TODAY)).toMatchObject({
      ok: false,
      handleProblem: 'An Instagram handle has at most 30 characters.',
    });
  });

  it('refuses a day that has not come, or is no day, and keeps the handle’s answer apart', () => {
    expect(instagramFields('falcon.fpv', '2026-11-01', TODAY)).toEqual({
      ok: false,
      handleProblem: null,
      sinceProblem: 'That day has not come yet.',
    });
    expect(instagramFields('falcon.fpv', '2026-02-30', TODAY)).toMatchObject({
      ok: false,
      sinceProblem: 'Type a day like 1 Aug 2026, or pick one from the calendar.',
    });
    expect(instagramFields('falcon.fpv', 'last summer', TODAY)).toMatchObject({
      ok: false,
      sinceProblem: INSTAGRAM_DIALOG_TEXT.sinceNotADay,
    });
    expect(instagramFields('falcon.fpv', '1 Dec 2026', TODAY)).toMatchObject({
      ok: false,
      sinceProblem: 'That day has not come yet.',
    });
    expect(instagramFields('nope nope', '2026-11-01', TODAY)).toMatchObject({
      ok: false,
      handleProblem: 'An Instagram handle has no spaces.',
      sinceProblem: 'That day has not come yet.',
    });
  });
});

describe('the day box when it is left (checkSince)', () => {
  it('writes a day it can read in the field’s words and says nothing', () => {
    const store = opened(null);
    for (const typed of ['2026-08-01', '1/8/2026', '1 august 2026']) {
      store.getState().setSince(typed);
      store.getState().checkSince(TODAY);
      expect(store.getState()).toMatchObject({ since: '1 Aug 2026', sinceProblem: null });
    }
  });

  it('leaves an empty box alone, and keeps text that is no day as typed with the sentence', () => {
    const store = opened(null);
    store.getState().checkSince(TODAY);
    expect(store.getState()).toMatchObject({ since: '', sinceProblem: null });
    store.getState().setSince('last summer');
    store.getState().checkSince(TODAY);
    expect(store.getState()).toMatchObject({
      since: 'last summer',
      sinceProblem: INSTAGRAM_DIALOG_TEXT.sinceNotADay,
    });
    // Typing again takes the sentence back.
    store.getState().setSince('last summe');
    expect(store.getState().sinceProblem).toBeNull();
  });

  it('says a day that has not come yet, and keeps what was typed', () => {
    const store = opened(null);
    store.getState().setSince('1 Dec 2026');
    store.getState().checkSince(TODAY);
    expect(store.getState()).toMatchObject({
      since: '1 Dec 2026',
      sinceProblem: 'That day has not come yet.',
    });
  });
});

describe('handleProblemOf', () => {
  it('says nothing about an empty box, and the sentence about a wrong one', () => {
    expect(handleProblemOf('')).toBeNull();
    expect(handleProblemOf('   ')).toBeNull();
    expect(handleProblemOf('falcon.fpv')).toBeNull();
    expect(handleProblemOf('falcon fpv')).toBe('An Instagram handle has no spaces.');
  });
});

describe('the dialog’s store', () => {
  it('starts closed, and opens for a client with the fields waiting for its account', () => {
    const store = createInstagramDialogStore();
    expect(store.getState().clientId).toBeNull();
    store.getState().ask(FALCON);
    expect(store.getState()).toMatchObject({
      clientId: FALCON,
      hydrated: false,
      hasAccount: false,
      step: 'edit',
      handle: '',
    });
  });

  it('starts the fields from the account once the engine has told it, and only once', () => {
    const store = createInstagramDialogStore();
    store.getState().ask(FALCON);
    store.getState().hydrate({ handle: 'falcon.fpv', since: '2026-08-01' });
    expect(store.getState()).toMatchObject({
      hydrated: true,
      hasAccount: true,
      accountHandle: 'falcon.fpv',
      handle: 'falcon.fpv',
      // The day as the field writes it.
      since: '1 Aug 2026',
    });
    // What is typed is not overwritten when the answer comes again (an event, a reload).
    store.getState().setHandle('falcon.fpv2');
    store.getState().hydrate({ handle: 'falcon.fpv', since: null });
    expect(store.getState().handle).toBe('falcon.fpv2');
    expect(store.getState().accountHandle).toBe('falcon.fpv');
  });

  it('starts empty for a client with no account, with no Remove Instagram', () => {
    const store = opened(null);
    expect(store.getState()).toMatchObject({
      hydrated: true,
      hasAccount: false,
      handle: '',
      since: '',
    });
  });

  it('ignores an answer that arrives while no dialog is open', () => {
    const store = createInstagramDialogStore();
    store.getState().hydrate({ handle: 'falcon.fpv', since: null });
    expect(store.getState().hydrated).toBe(false);
  });

  it('forgets everything when it is asked for again, even by the same client', () => {
    const store = opened({ handle: 'falcon.fpv', since: null });
    store.getState().setHandle('typed');
    store.getState().dismiss();
    store.getState().ask(FALCON);
    expect(store.getState()).toMatchObject({ clientId: FALCON, hydrated: false, handle: '' });
    expect(store.getState().opening).toBe(2);
  });

  it('keeps what was typed while it fades out, so the dialog does not empty', () => {
    const store = opened({ handle: 'falcon.fpv', since: null });
    store.getState().dismiss();
    expect(store.getState()).toMatchObject({
      clientId: null,
      handle: 'falcon.fpv',
      pending: false,
    });
  });

  it('says what is wrong with the handle on leaving the box, and takes it back on typing', () => {
    const store = opened(null);
    store.getState().setHandle('falcon fpv');
    expect(store.getState().handleProblem).toBeNull();
    store.getState().checkHandle();
    expect(store.getState().handleProblem).toBe('An Instagram handle has no spaces.');
    store.getState().setHandle('falcon');
    expect(store.getState().handleProblem).toBeNull();
  });

  it('asks before removing, and Cancel goes back to the fields', () => {
    const store = opened({ handle: 'falcon.fpv', since: null });
    store.getState().askToRemove();
    expect(store.getState().step).toBe('remove');
    store.getState().keep();
    expect(store.getState().step).toBe('edit');
  });
});

describe('confirmSaveInstagram', () => {
  const deps = (save = vi.fn().mockResolvedValue(undefined)) => ({
    save,
    onSaved: vi.fn(),
    today: () => TODAY,
  });

  it('sends the handle as the engine keeps it and the day, closes, and tells the page', async () => {
    const store = opened(null);
    store.getState().setHandle('@Falcon.FPV');
    store.getState().setSince('2026-08-01');
    const d = deps();
    expect(await confirmSaveInstagram(d, store)).toBe('falcon.fpv');
    expect(d.save).toHaveBeenCalledExactlyOnceWith(FALCON, {
      handle: 'falcon.fpv',
      since: '2026-08-01',
    });
    expect(d.onSaved).toHaveBeenCalledExactlyOnceWith(FALCON, 'falcon.fpv');
    expect(store.getState().clientId).toBeNull();
  });

  it('sends no day when the day is empty (the first delivery counts)', async () => {
    const store = opened(null);
    store.getState().setHandle('https://www.instagram.com/falcon.fpv/');
    const d = deps();
    await confirmSaveInstagram(d, store);
    expect(d.save).toHaveBeenCalledExactlyOnceWith(FALCON, { handle: 'falcon.fpv', since: null });
  });

  it('sends nothing for a wrong handle and says why under the box', async () => {
    const store = opened(null);
    store.getState().setHandle('instagram.com/reel/C9xYz12AbCd/');
    const d = deps();
    expect(await confirmSaveInstagram(d, store)).toBeNull();
    expect(d.save).not.toHaveBeenCalled();
    expect(store.getState().handleProblem).toBe(
      'That link is a post, not a profile. Paste the profile’s link or handle.',
    );
    expect(store.getState().clientId).toBe(FALCON);
  });

  it('sends nothing for an empty box and asks for the handle', async () => {
    const store = opened(null);
    const d = deps();
    expect(await confirmSaveInstagram(d, store)).toBeNull();
    expect(d.save).not.toHaveBeenCalled();
    expect(store.getState().handleProblem).toBe(
      'Give the client’s Instagram handle or profile link.',
    );
  });

  it('sends nothing for a day that has not come', async () => {
    const store = opened(null);
    store.getState().setHandle('falcon.fpv');
    store.getState().setSince('2026-12-01');
    const d = deps();
    expect(await confirmSaveInstagram(d, store)).toBeNull();
    expect(store.getState().sinceProblem).toBe('That day has not come yet.');
  });

  it('keeps the dialog open and says what the server said when it refuses', async () => {
    const store = opened(null);
    store.getState().setHandle('falcon.fpv');
    const d = deps(
      vi.fn().mockRejectedValue(new Error('That part of Clients × Instagram is not built yet.')),
    );
    expect(await confirmSaveInstagram(d, store)).toBeNull();
    expect(store.getState()).toMatchObject({
      clientId: FALCON,
      pending: false,
      error: 'That part of Clients × Instagram is not built yet.',
    });
    expect(d.onSaved).not.toHaveBeenCalled();
    // Typing again takes the sentence back.
    store.getState().setHandle('falcon.fpv2');
    expect(store.getState().error).toBeNull();
  });

  it('is locked while the request is on its way', async () => {
    const store = opened(null);
    store.getState().setHandle('falcon.fpv');
    let release: () => void = () => undefined;
    const d = deps(
      vi.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      ),
    );
    const first = confirmSaveInstagram(d, store);
    expect(store.getState().pending).toBe(true);
    expect(await confirmSaveInstagram(d, store)).toBeNull();
    expect(d.save).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('does nothing before the client’s account is in, or while it asks about removing', async () => {
    const waiting = createInstagramDialogStore();
    waiting.getState().ask(FALCON);
    waiting.getState().setHandle('falcon.fpv');
    const d = deps();
    expect(await confirmSaveInstagram(d, waiting)).toBeNull();
    const removing = opened({ handle: 'falcon.fpv', since: null });
    removing.getState().askToRemove();
    expect(await confirmSaveInstagram(d, removing)).toBeNull();
    expect(d.save).not.toHaveBeenCalled();
  });

  it('does nothing when no dialog is open', async () => {
    const d = deps();
    expect(await confirmSaveInstagram(d, createInstagramDialogStore())).toBeNull();
    expect(d.save).not.toHaveBeenCalled();
  });
});

describe('confirmRemoveInstagram', () => {
  const deps = (remove = vi.fn().mockResolvedValue(undefined)) => ({ remove, onRemoved: vi.fn() });

  it('removes the saved account, closes, and tells the page which handle went', async () => {
    const store = opened({ handle: 'falcon.fpv', since: null });
    store.getState().setHandle('typed.but.not.saved');
    store.getState().askToRemove();
    const d = deps();
    expect(await confirmRemoveInstagram(d, store)).toBe(true);
    expect(d.remove).toHaveBeenCalledExactlyOnceWith(FALCON);
    expect(d.onRemoved).toHaveBeenCalledExactlyOnceWith(FALCON, 'falcon.fpv');
    expect(store.getState().clientId).toBeNull();
  });

  it('asks first: nothing is removed until the question has been shown', async () => {
    const store = opened({ handle: 'falcon.fpv', since: null });
    const d = deps();
    expect(await confirmRemoveInstagram(d, store)).toBe(false);
    expect(d.remove).not.toHaveBeenCalled();
  });

  it('has nothing to remove for a client with no account', async () => {
    const store = opened(null);
    store.getState().askToRemove();
    const d = deps();
    expect(await confirmRemoveInstagram(d, store)).toBe(false);
    expect(d.remove).not.toHaveBeenCalled();
  });

  it('stays on its question and says what the server said when it refuses', async () => {
    const store = opened({ handle: 'falcon.fpv', since: null });
    store.getState().askToRemove();
    const d = deps(vi.fn().mockRejectedValue(new Error('Cannot reach the Studio Engine server.')));
    expect(await confirmRemoveInstagram(d, store)).toBe(false);
    expect(store.getState()).toMatchObject({
      clientId: FALCON,
      step: 'remove',
      pending: false,
      error: 'Cannot reach the Studio Engine server.',
    });
    expect(d.onRemoved).not.toHaveBeenCalled();
  });
});
