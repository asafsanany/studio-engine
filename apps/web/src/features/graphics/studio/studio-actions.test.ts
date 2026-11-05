import { GRAPHIC_MESSAGES } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data';
import { makeGraphicDetail } from '@/data/test-utils';
import { createStudioActions, errorText, type StudioApi, submitMessage } from './studio-actions';

const png = new File([new Uint8Array(4)], 'pill.png', { type: 'image/png' });

describe('submitMessage', () => {
  function deps() {
    const created = makeGraphicDetail({ id: '111111111111' });
    const changed = makeGraphicDetail({ id: '222222222222' });
    return {
      created,
      changed,
      create: vi.fn(async () => created),
      send: vi.fn(async () => changed),
    };
  }

  it('creates the graphic from the first message of /graphics/new', async () => {
    const d = deps();
    const result = await submitMessage(
      { graphicId: undefined, text: '  A lower third  ', files: [png], effort: 'high' },
      d,
    );
    expect(result).toEqual({ ok: true, detail: d.created, created: true });
    expect(d.send).not.toHaveBeenCalled();
    expect(d.create).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'A lower third', effort: 'high', files: [png] }),
    );
  });

  it('sends a change to the graphic it is about', async () => {
    const d = deps();
    const result = await submitMessage(
      { graphicId: 'abc123abc123', text: 'Make it dark', files: [], effort: 'medium' },
      d,
    );
    expect(result).toEqual({ ok: true, detail: d.changed, created: false });
    expect(d.create).not.toHaveBeenCalled();
    expect(d.send).toHaveBeenCalledWith({
      id: 'abc123abc123',
      send: expect.objectContaining({ text: 'Make it dark', effort: 'medium', files: [] }),
    });
  });

  it('sends no effort for Extra high, the default', async () => {
    const d = deps();
    await submitMessage({ graphicId: undefined, text: 'x', files: [], effort: 'xhigh' }, d);
    expect(d.create).toHaveBeenCalledWith(expect.objectContaining({ effort: null }));
  });

  it('sends a message that is only files, with empty text', async () => {
    const d = deps();
    const result = await submitMessage(
      { graphicId: 'abc123abc123', text: '   ', files: [png], effort: 'xhigh' },
      d,
    );
    expect(result.ok).toBe(true);
    expect(d.send).toHaveBeenCalledWith({
      id: 'abc123abc123',
      send: expect.objectContaining({ text: '', files: [png] }),
    });
  });

  it('passes the upload progress on', async () => {
    const d = deps();
    const onProgress = vi.fn();
    await submitMessage(
      { graphicId: undefined, text: 'x', files: [png], effort: 'xhigh', onProgress },
      d,
    );
    const sent = (d.create.mock.calls[0] as unknown as [{ onProgress?: unknown }])[0];
    expect(sent.onProgress).toBe(onProgress);
  });

  it('answers the server’s sentence when a version is being made, and says nothing was created', async () => {
    const d = deps();
    d.send.mockRejectedValue(
      new ApiError(409, 'Wait until v3 is made, then send your next message.'),
    );
    const result = await submitMessage(
      { graphicId: 'abc123abc123', text: 'Again', files: [], effort: 'xhigh' },
      d,
    );
    expect(result).toEqual({
      ok: false,
      error: 'Wait until v3 is made, then send your next message.',
    });
  });

  it('answers the sentence of a refused file on the first message too', async () => {
    const d = deps();
    d.create.mockRejectedValue(new ApiError(415, GRAPHIC_MESSAGES.badUploadType));
    const result = await submitMessage(
      { graphicId: undefined, text: 'x', files: [png], effort: 'xhigh' },
      d,
    );
    expect(result).toEqual({ ok: false, error: GRAPHIC_MESSAGES.badUploadType });
  });
});

describe('errorText', () => {
  it('is the error’s own words, or the value as text', () => {
    expect(errorText(new Error('Nope'))).toBe('Nope');
    expect(errorText(new Error(''))).toBe('Error');
    expect(errorText('plain')).toBe('plain');
  });
});

describe('the page’s buttons', () => {
  function setup(
    overrides: Partial<StudioApi> = {},
    goToListImpl: () => Promise<unknown> = async () => undefined,
  ) {
    const copy = makeGraphicDetail({ id: '999999999999' });
    const api: StudioApi = {
      stop: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
      restore: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      duplicate: vi.fn(async () => copy),
      reveal: vi.fn(async () => undefined),
      remove: vi.fn(async () => ({
        ok: true as const,
        where: '/Users/owner/.Trash/Name on a white pill',
      })),
      ...overrides,
    };
    const error = vi.fn();
    const info = vi.fn();
    const notify = { error, info };
    const openGraphic = vi.fn();
    const goToList = vi.fn(goToListImpl);
    const actions = createStudioActions({ id: 'abc123abc123', api, notify, openGraphic, goToList });
    return { api, notify: error, info, openGraphic, goToList, actions };
  }

  it('Stop and Retry act on one of the graphic’s chat rows', async () => {
    const { api, actions, notify } = setup();
    expect(await actions.stop('m1')).toBe(true);
    expect(await actions.retry('m2')).toBe(true);
    expect(api.stop).toHaveBeenCalledWith({ id: 'abc123abc123', messageId: 'm1' });
    expect(api.retry).toHaveBeenCalledWith({ id: 'abc123abc123', messageId: 'm2' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('Retry says why in a toast when the engine refuses', async () => {
    const { actions, notify } = setup({
      retry: vi.fn(async () => {
        throw new ApiError(409, 'Wait until v3 is made, then try again.');
      }),
    });
    expect(await actions.retry('m2')).toBe(false);
    expect(notify).toHaveBeenCalledWith('Wait until v3 is made, then try again.');
  });

  it('"Use v1 again" restores that version', async () => {
    const { api, actions } = setup();
    expect(await actions.restore(1)).toBe(true);
    expect(api.restore).toHaveBeenCalledWith({ id: 'abc123abc123', version: 1 });
  });

  it('"Use v1 again" answers false, with the reason, when edits use it already', async () => {
    const { actions, notify } = setup({
      restore: vi.fn(async () => {
        throw new ApiError(409, GRAPHIC_MESSAGES.nothingToRestore);
      }),
    });
    expect(await actions.restore(2)).toBe(false);
    expect(notify).toHaveBeenCalledWith('Edits use this version already.');
  });

  it('renames with the new name, and says when it is taken', async () => {
    const { api, actions, notify } = setup();
    expect(await actions.rename('Dark pill')).toBe(true);
    expect(api.update).toHaveBeenCalledWith({ id: 'abc123abc123', patch: { name: 'Dark pill' } });

    const taken = setup({
      update: vi.fn(async () => {
        throw new ApiError(422, GRAPHIC_MESSAGES.nameTaken);
      }),
    });
    expect(await taken.actions.rename('Dark pill')).toBe(false);
    expect(taken.notify).toHaveBeenCalledWith('Another graphic already has this name.');
    expect(notify).not.toHaveBeenCalled();
  });

  it('the Edits can use it switch sends uses', async () => {
    const { api, actions } = setup();
    await actions.setUses(false);
    await actions.setUses(true);
    expect(api.update).toHaveBeenNthCalledWith(1, { id: 'abc123abc123', patch: { uses: false } });
    expect(api.update).toHaveBeenNthCalledWith(2, { id: 'abc123abc123', patch: { uses: true } });
  });

  it('the When line is saved trimmed, and only when it changed', async () => {
    const { api, actions } = setup();
    expect(await actions.saveWhen('  At the start.  ', 'The first time a person is named.')).toBe(
      true,
    );
    expect(api.update).toHaveBeenCalledWith({
      id: 'abc123abc123',
      patch: { when: 'At the start.' },
    });

    api.update = vi.fn(async () => undefined);
    expect(await actions.saveWhen('Same line.', 'Same line.')).toBe(true);
    expect(api.update).not.toHaveBeenCalled();
  });

  it('a When line that could not be saved answers false, so the box keeps what was typed', async () => {
    const { actions, notify } = setup({
      update: vi.fn(async () => {
        throw new ApiError(400, GRAPHIC_MESSAGES.whenTooLong);
      }),
    });
    expect(await actions.saveWhen('x', 'y')).toBe(false);
    expect(notify).toHaveBeenCalledWith(GRAPHIC_MESSAGES.whenTooLong);
  });

  it('Show in Finder asks the engine to reveal the folder', async () => {
    const { api, actions } = setup();
    expect(await actions.reveal()).toBe(true);
    expect(api.reveal).toHaveBeenCalledWith('abc123abc123');
  });

  it('Duplicate opens the copy', async () => {
    const { actions, openGraphic } = setup();
    expect(await actions.duplicate()).toBe(true);
    expect(openGraphic).toHaveBeenCalledWith('999999999999');
  });

  it('Duplicate says why when there is nothing to copy yet', async () => {
    const { actions, notify, openGraphic } = setup({
      duplicate: vi.fn(async () => {
        throw new ApiError(409, GRAPHIC_MESSAGES.nothingToDuplicate);
      }),
    });
    expect(await actions.duplicate()).toBe(false);
    expect(openGraphic).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(GRAPHIC_MESSAGES.nothingToDuplicate);
  });

  it('Delete goes back to the library once the engine has moved the folder to the Trash, saying nothing more', async () => {
    const { api, actions, goToList, info, notify } = setup();
    expect(await actions.remove('Name on a white pill')).toBe(true);
    expect(api.remove).toHaveBeenCalledWith('abc123abc123');
    expect(goToList).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('Delete says where the folder is when macOS would not take it to the Trash, after the library is open', async () => {
    const order: string[] = [];
    const { actions, info, goToList } = setup(
      {
        remove: vi.fn(async () => ({
          ok: true as const,
          where: '/data/deleted-graphics/Name on a white pill',
        })),
      },
      async () => {
        order.push('list');
      },
    );
    info.mockImplementation(() => {
      order.push('info');
    });
    expect(await actions.remove('Name on a white pill')).toBe(true);
    expect(goToList).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      '“Name on a white pill” is deleted, but not in the Trash',
      'macOS would not take it there, so it is in /data/deleted-graphics/Name on a white pill.',
    );
    expect(order).toEqual(['list', 'info']);
  });

  it('Delete stays on the page, with the reason, when the folder could not be moved', async () => {
    const { actions, goToList, notify, info } = setup({
      remove: vi.fn(async () => {
        throw new ApiError(500, GRAPHIC_MESSAGES.deleteFailed);
      }),
    });
    expect(await actions.remove('Name on a white pill')).toBe(false);
    expect(goToList).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(GRAPHIC_MESSAGES.deleteFailed);
  });
});
