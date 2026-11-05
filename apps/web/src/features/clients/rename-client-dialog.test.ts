import type { ClientRow } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  confirmRenameClient,
  createRenameClientDialogStore,
  type RenameClientDeps,
  renameClientReadiness,
} from './rename-client-dialog';

const TARGET = { clientId: 'c1', name: 'Kova Coffee' };

const RENAMED: ClientRow = {
  clientId: 'c2',
  client: 'Kova Roasters',
  jobs: 3,
  lastJobAt: null,
  style: { state: 'none', updatedAt: null },
};

function asking(name = 'Kova Roasters') {
  const store = createRenameClientDialogStore();
  store.getState().ask(TARGET);
  store.getState().setName(name);
  return store;
}

function deps(overrides: Partial<RenameClientDeps> = {}): RenameClientDeps {
  return {
    rename: vi.fn(() => Promise.resolve(RENAMED)),
    onRenamed: vi.fn(),
    notify: vi.fn(),
    ...overrides,
  };
}

describe('the rename client dialog’s store', () => {
  it('opens on the client with its current name in the box', () => {
    const store = createRenameClientDialogStore();

    store.getState().ask(TARGET);

    expect(store.getState()).toMatchObject({
      client: TARGET,
      name: 'Kova Coffee',
      pending: false,
      error: null,
    });
  });

  it('forgets the server’s refusal once the name is typed again', () => {
    const store = asking();
    store.getState().fail('There is already a client called “Kova Roasters”.');

    store.getState().setName('Kova Beans');

    expect(store.getState().error).toBeNull();
  });
});

describe('renameClientReadiness', () => {
  it('is ready for a new name a client can have', () => {
    expect(renameClientReadiness(TARGET, 'Kova Roasters')).toEqual({ problem: null, ready: true });
  });

  it('is not ready for its own name, whatever the spaces around it', () => {
    expect(renameClientReadiness(TARGET, '  Kova Coffee ')).toEqual({
      problem: null,
      ready: false,
    });
  });

  it('says what is wrong with a name New client would refuse, and is quiet for an empty box', () => {
    expect(renameClientReadiness(TARGET, 'Kova/Coffee').problem).toBe(
      'A client name can’t contain / or :.',
    );
    expect(renameClientReadiness(TARGET, '_Kova').ready).toBe(false);
    expect(renameClientReadiness(TARGET, '   ')).toEqual({ problem: null, ready: false });
  });
});

describe('confirmRenameClient', () => {
  it('sends the name, closes the dialog, tells the page and says it is done', async () => {
    const store = asking();
    const d = deps();

    await expect(confirmRenameClient(d, store)).resolves.toEqual(RENAMED);

    expect(d.rename).toHaveBeenCalledExactlyOnceWith('c1', 'Kova Roasters');
    expect(d.onRenamed).toHaveBeenCalledExactlyOnceWith(TARGET, RENAMED);
    expect(d.notify).toHaveBeenCalledExactlyOnceWith('Renamed to “Kova Roasters”');
    expect(store.getState().client).toBeNull();
  });

  it('keeps the dialog open with the server’s reason when it refuses', async () => {
    const store = asking();
    const d = deps({
      rename: vi.fn(() =>
        Promise.reject(new Error('Wait until “Ad 6” is edited to rename this client.')),
      ),
    });

    await expect(confirmRenameClient(d, store)).resolves.toBeNull();

    expect(store.getState()).toMatchObject({
      client: TARGET,
      pending: false,
      error: 'Wait until “Ad 6” is edited to rename this client.',
    });
    expect(d.onRenamed).not.toHaveBeenCalled();
  });

  it('sends nothing while the name is not ready', async () => {
    const d = deps();

    await expect(confirmRenameClient(d, asking('Kova Coffee'))).resolves.toBeNull();

    expect(d.rename).not.toHaveBeenCalled();
  });
});
