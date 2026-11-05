import { describe, expect, it } from 'vitest';
import { createDeleteClientDialogStore, deleteClientWarning } from './delete-client-dialog';

describe('deleteClientWarning', () => {
  it('says the folders go to the Trash', () => {
    expect(deleteClientWarning(0)).toBe(
      'Its folder in Studio Inbox and its exports go to the Trash.',
    );
  });

  it('says the videos and their payments go too, when it has some', () => {
    expect(deleteClientWarning(1)).toBe(
      'Its folder in Studio Inbox and its exports go to the Trash. Its video is removed from the app, and its payment from Money.',
    );
    expect(deleteClientWarning(3)).toBe(
      'Its folder in Studio Inbox and its exports go to the Trash. Its 3 videos are removed from the app, and their payments from Money.',
    );
  });
});

describe('the Delete client dialog store', () => {
  const pinewood = { clientId: '4d337086919d', name: 'Pinewood', jobCount: 2 };

  it('asks about a client, and forgets the last error', () => {
    const store = createDeleteClientDialogStore({ error: 'busy' });
    store.getState().ask(pinewood);
    expect(store.getState()).toMatchObject({ client: pinewood, pending: false, error: null });
  });

  it('keeps the client while a refusal is shown, and closes on dismiss', () => {
    const store = createDeleteClientDialogStore();
    store.getState().ask(pinewood);
    store.getState().setPending(true);
    store.getState().fail('Wait until “Ad 6” is edited to delete this client.');
    expect(store.getState()).toMatchObject({
      client: pinewood,
      pending: false,
      error: 'Wait until “Ad 6” is edited to delete this client.',
    });
    store.getState().dismiss();
    expect(store.getState()).toMatchObject({ client: null, pending: false, error: null });
  });
});
