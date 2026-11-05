import { describe, expect, it, vi } from 'vitest';
import { makeJob } from '@/data/test-utils';
import {
  confirmRename,
  createRenameDialogStore,
  type RenameDeps,
  renameReadiness,
} from './rename-job-dialog';

const TARGET = { id: 'j1', client: 'Kova Coffee', name: 'Spring menu' };

function asking(name = 'Summer menu') {
  const store = createRenameDialogStore();
  store.getState().ask(TARGET);
  store.getState().setName(name);
  return store;
}

function deps(overrides: Partial<RenameDeps> = {}): RenameDeps {
  return {
    rename: vi.fn(() =>
      Promise.resolve(makeJob({ id: 'j2', client: 'Kova Coffee', name: 'Summer menu' })),
    ),
    onRenamed: vi.fn(),
    notify: vi.fn(),
    ...overrides,
  };
}

describe('the rename dialog’s store', () => {
  it('opens on the job with its current name in the box', () => {
    const store = createRenameDialogStore();

    store.getState().ask(TARGET);

    expect(store.getState()).toMatchObject({
      job: TARGET,
      name: 'Spring menu',
      pending: false,
      error: null,
    });
  });

  it('forgets the server’s last answer when the name is typed again', () => {
    const store = asking();
    store.getState().fail('There is already a video called “Summer menu” for this client.');

    store.getState().setName('Summer menu 2');

    expect(store.getState().error).toBeNull();
  });

  it('closes and forgets everything', () => {
    const store = asking();

    store.getState().dismiss();

    expect(store.getState()).toMatchObject({ job: null, name: '', pending: false, error: null });
  });
});

describe('renameReadiness', () => {
  it('is ready for a new name a folder can have', () => {
    expect(renameReadiness(TARGET, 'Summer menu')).toEqual({ problem: null, ready: true });
    expect(renameReadiness(TARGET, '  Summer menu  ').ready).toBe(true);
    expect(renameReadiness(TARGET, 'מיתוס או אמת 7').ready).toBe(true);
  });

  it('is not ready for the job’s own name, and says nothing about it', () => {
    expect(renameReadiness(TARGET, 'Spring menu')).toEqual({ problem: null, ready: false });
    expect(renameReadiness(TARGET, ' Spring menu ').ready).toBe(false);
  });

  it('lets a change of letters through: it is a new name', () => {
    expect(renameReadiness(TARGET, 'SPRING MENU').ready).toBe(true);
  });

  it('is not ready for an empty box, and does not scold for it', () => {
    expect(renameReadiness(TARGET, '')).toEqual({ problem: null, ready: false });
    expect(renameReadiness(TARGET, '   ')).toEqual({ problem: null, ready: false });
  });

  it('says why a name cannot be a folder’s', () => {
    for (const name of ['a/b', 'a:b', '.hidden', 'x'.repeat(121)]) {
      const { problem, ready } = renameReadiness(TARGET, name);
      expect(ready, name).toBe(false);
      expect(problem, name).toEqual(expect.any(String));
    }
  });

  it('is not ready with no job', () => {
    expect(renameReadiness(null, 'Summer menu').ready).toBe(false);
  });
});

describe('confirmRename', () => {
  it('renames the job, closes the dialog, tells the page and the person', async () => {
    const store = asking();
    const d = deps();

    const renamed = await confirmRename(d, store);

    expect(d.rename).toHaveBeenCalledWith('j1', 'Summer menu');
    expect(renamed?.id).toBe('j2');
    expect(store.getState().job).toBeNull();
    expect(d.onRenamed).toHaveBeenCalledWith(TARGET, renamed);
    expect(d.notify).toHaveBeenCalledWith('Renamed to “Summer menu”', 'Kova Coffee');
  });

  it('is pending while the server works, and cannot be sent twice', async () => {
    const store = asking();
    let answer: (value: ReturnType<typeof makeJob>) => void = () => {};
    const d = deps({
      rename: vi.fn(() => new Promise<ReturnType<typeof makeJob>>((resolve) => (answer = resolve))),
    });

    const first = confirmRename(d, store);
    expect(store.getState().pending).toBe(true);
    expect(await confirmRename(d, store)).toBeNull();
    answer(makeJob({ id: 'j2', client: 'Kova Coffee', name: 'Summer menu' }));
    await first;

    expect(d.rename).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open with the server’s reason when it refuses', async () => {
    const store = asking();
    const d = deps({
      rename: vi.fn(() =>
        Promise.reject(new Error('There is already a video called “Summer menu” for this client.')),
      ),
    });

    const renamed = await confirmRename(d, store);

    expect(renamed).toBeNull();
    expect(store.getState()).toMatchObject({
      job: TARGET,
      name: 'Summer menu',
      pending: false,
      error: 'There is already a video called “Summer menu” for this client.',
    });
    expect(d.onRenamed).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('sends nothing for a name that is not ready', async () => {
    for (const name of ['', 'Spring menu', 'a/b']) {
      const store = asking(name);
      const d = deps();

      expect(await confirmRename(d, store), name).toBeNull();

      expect(d.rename).not.toHaveBeenCalled();
      expect(store.getState().job).toEqual(TARGET);
    }
  });

  it('sends nothing while no dialog is open', async () => {
    const d = deps();

    expect(await confirmRename(d, createRenameDialogStore())).toBeNull();

    expect(d.rename).not.toHaveBeenCalled();
  });
});
