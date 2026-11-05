import { GRAPHIC_MESSAGES } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data/api';
import { makeGraphicDetail, makeGraphicMessage } from '@/data/test-utils';
import {
  createGraphicActions,
  type GraphicActionDeps,
  messageOf,
  newestFailedMessage,
  renameOutcome,
} from './graphic-actions';

const ID = '3f9a1c2b7d4e';

/** Deps whose every mutation succeeds; a test replaces the one it is about. */
function deps(overrides: Partial<GraphicActionDeps> = {}): GraphicActionDeps {
  return {
    open: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    duplicate: vi.fn().mockResolvedValue(undefined),
    reveal: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue({ ok: true, where: '/Users/owner/.Trash/Name' }),
    retryMessage: vi.fn().mockResolvedValue(undefined),
    loadDetail: vi.fn().mockResolvedValue(makeGraphicDetail()),
    notice: { error: vi.fn(), info: vi.fn() },
    ...overrides,
  };
}

const failedDetail = makeGraphicDetail({
  status: 'failed',
  failedVersion: 3,
  messages: [
    makeGraphicMessage({ id: 'm-claude-1' }),
    makeGraphicMessage({ id: 'm-claude-2', version: 3, status: 'failed', error: 'Lint failed.' }),
  ],
});

describe('Open', () => {
  it('goes to the graphic’s page', () => {
    const d = deps();
    createGraphicActions(d).open(ID);
    expect(d.open).toHaveBeenCalledExactlyOnceWith(ID);
  });
});

describe('Rename', () => {
  it('asks the engine for the new name and says it went through', async () => {
    const d = deps();
    await expect(createGraphicActions(d).rename(ID, 'White pill')).resolves.toBe(true);
    expect(d.update).toHaveBeenCalledExactlyOnceWith({ id: ID, patch: { name: 'White pill' } });
    expect(d.notice.error).not.toHaveBeenCalled();
  });

  it('says the engine’s refusal in its own words and answers false', async () => {
    const d = deps({
      update: vi.fn().mockRejectedValue(new ApiError(422, GRAPHIC_MESSAGES.nameTaken)),
    });
    await expect(createGraphicActions(d).rename(ID, 'Taken')).resolves.toBe(false);
    expect(d.notice.error).toHaveBeenCalledExactlyOnceWith(
      'Another graphic already has this name.',
    );
  });
});

describe('Duplicate and Show in Finder', () => {
  it('ask the engine for that graphic', async () => {
    const d = deps();
    const actions = createGraphicActions(d);
    await actions.duplicate(ID);
    await actions.reveal(ID);
    expect(d.duplicate).toHaveBeenCalledExactlyOnceWith(ID);
    expect(d.reveal).toHaveBeenCalledExactlyOnceWith(ID);
    expect(d.notice.error).not.toHaveBeenCalled();
  });

  it('say a refusal instead of failing', async () => {
    const d = deps({
      duplicate: vi.fn().mockRejectedValue(new ApiError(409, GRAPHIC_MESSAGES.nothingToDuplicate)),
      reveal: vi.fn().mockRejectedValue(new ApiError(500, GRAPHIC_MESSAGES.revealFailed)),
    });
    const actions = createGraphicActions(d);
    await expect(actions.duplicate(ID)).resolves.toBeUndefined();
    await expect(actions.reveal(ID)).resolves.toBeUndefined();
    expect(vi.mocked(d.notice.error).mock.calls).toEqual([
      [GRAPHIC_MESSAGES.nothingToDuplicate],
      [GRAPHIC_MESSAGES.revealFailed],
    ]);
  });
});

describe('Turn off / on for edits', () => {
  it('sends the new value of Edits can use it', async () => {
    const d = deps();
    const actions = createGraphicActions(d);
    await actions.setUses(ID, false);
    await actions.setUses(ID, true);
    expect(vi.mocked(d.update).mock.calls).toEqual([
      [{ id: ID, patch: { uses: false } }],
      [{ id: ID, patch: { uses: true } }],
    ]);
  });

  it('says a refusal', async () => {
    const d = deps({
      update: vi.fn().mockRejectedValue(new ApiError(0, 'Cannot reach the Studio Engine server.')),
    });
    await createGraphicActions(d).setUses(ID, false);
    expect(d.notice.error).toHaveBeenCalledExactlyOnceWith(
      'Cannot reach the Studio Engine server.',
    );
  });
});

describe('Retry', () => {
  it('reads the graphic and tries its newest failed row again', async () => {
    const d = deps({ loadDetail: vi.fn().mockResolvedValue(failedDetail) });
    await createGraphicActions(d).retry(ID);
    expect(d.loadDetail).toHaveBeenCalledExactlyOnceWith(ID);
    expect(d.retryMessage).toHaveBeenCalledExactlyOnceWith({ id: ID, messageId: 'm-claude-2' });
    expect(d.notice.error).not.toHaveBeenCalled();
  });

  it('says so when nothing is waiting for a retry any more', async () => {
    const d = deps();
    await createGraphicActions(d).retry(ID);
    expect(d.retryMessage).not.toHaveBeenCalled();
    expect(d.notice.error).toHaveBeenCalledExactlyOnceWith(GRAPHIC_MESSAGES.notRetryable);
  });

  it('says the engine’s refusal when it will not make it again', async () => {
    const d = deps({
      loadDetail: vi.fn().mockResolvedValue(failedDetail),
      retryMessage: vi
        .fn()
        .mockRejectedValue(new ApiError(409, 'Wait until v3 is made, then try again.')),
    });
    await createGraphicActions(d).retry(ID);
    expect(d.notice.error).toHaveBeenCalledExactlyOnceWith(
      'Wait until v3 is made, then try again.',
    );
  });
});

describe('newestFailedMessage', () => {
  it('is Claude’s newest failed row, and undefined when none failed', () => {
    expect(newestFailedMessage(failedDetail)?.id).toBe('m-claude-2');
    expect(newestFailedMessage(makeGraphicDetail())).toBeUndefined();
  });

  it('ignores the owner’s own rows', () => {
    const detail = makeGraphicDetail({
      messages: [makeGraphicMessage({ id: 'm-you', role: 'you', status: 'failed' })],
    });
    expect(newestFailedMessage(detail)).toBeUndefined();
  });
});

describe('Delete', () => {
  it('deletes, and says nothing when the folder went to the Trash', async () => {
    const d = deps();
    await expect(createGraphicActions(d).remove(ID, 'Name')).resolves.toBe(true);
    expect(d.remove).toHaveBeenCalledExactlyOnceWith(ID);
    expect(d.notice.info).not.toHaveBeenCalled();
    expect(d.notice.error).not.toHaveBeenCalled();
  });

  it('says where the folder went when the engine used its fallback place', async () => {
    const where = '/Users/owner/.studio-engine/deleted-graphics/Name';
    const d = deps({ remove: vi.fn().mockResolvedValue({ ok: true, where }) });
    await expect(createGraphicActions(d).remove(ID, 'Name')).resolves.toBe(true);
    expect(d.notice.info).toHaveBeenCalledExactlyOnceWith(
      '“Name” is deleted, but not in the Trash',
      `macOS would not take it there, so it is in ${where}.`,
    );
  });

  it('says a refusal and answers false, so the graphic stays', async () => {
    const d = deps({
      remove: vi.fn().mockRejectedValue(new ApiError(500, GRAPHIC_MESSAGES.deleteFailed)),
    });
    await expect(createGraphicActions(d).remove(ID, 'Name')).resolves.toBe(false);
    expect(d.notice.error).toHaveBeenCalledExactlyOnceWith(GRAPHIC_MESSAGES.deleteFailed);
  });
});

describe('renameOutcome', () => {
  it('saves a new name as it was typed (the engine cleans it)', () => {
    expect(renameOutcome('Pill', ' White pill ')).toEqual({ kind: 'save', name: ' White pill ' });
  });

  it('puts the old name back for an empty name or the same one', () => {
    expect(renameOutcome('Pill', '')).toEqual({ kind: 'cancel' });
    expect(renameOutcome('Pill', '   ')).toEqual({ kind: 'cancel' });
    expect(renameOutcome('Pill', 'Pill')).toEqual({ kind: 'cancel' });
    expect(renameOutcome('Pill', '  Pill ')).toEqual({ kind: 'cancel' });
  });

  it('compares the name the way the engine cleans it', () => {
    expect(renameOutcome('A–B', 'A/B')).toEqual({ kind: 'cancel' });
    expect(renameOutcome('Pill', '...')).toEqual({ kind: 'cancel' });
  });
});

describe('messageOf', () => {
  it('is an error’s own sentence, or a plain one for anything else', () => {
    expect(messageOf(new ApiError(409, 'Wait.'))).toBe('Wait.');
    expect(messageOf('boom')).toBe('Something went wrong.');
    expect(messageOf(new Error(''))).toBe('Something went wrong.');
  });
});
