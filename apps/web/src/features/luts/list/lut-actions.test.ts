import { describe, expect, it, vi } from 'vitest';
import { makeLutDetail } from '@/data/test-utils';
import {
  createLutActions,
  type LutActionDeps,
  lutToken,
  messageOf,
  renameOutcome,
  runDelete,
} from './lut-actions';

function deps(overrides: Partial<LutActionDeps> = {}): LutActionDeps {
  return {
    update: vi.fn().mockResolvedValue(makeLutDetail({ slug: 'golden-hour' })),
    duplicate: vi.fn().mockResolvedValue(makeLutDetail()),
    reveal: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue({ ok: true, where: '/Users/owner/.Trash' }),
    copyText: vi.fn().mockResolvedValue(undefined),
    notice: { error: vi.fn(), info: vi.fn() },
    ...overrides,
  };
}

describe('renameOutcome', () => {
  it('saves a new name as typed', () => {
    expect(renameOutcome('Golden Hour Warm', 'Golden Hour')).toEqual({
      kind: 'save',
      name: 'Golden Hour',
    });
  });

  it('cancels an empty name, a blank one and the name it already has', () => {
    expect(renameOutcome('Golden', '')).toEqual({ kind: 'cancel' });
    expect(renameOutcome('Golden', '   ')).toEqual({ kind: 'cancel' });
    expect(renameOutcome('Golden', ' Golden ')).toEqual({ kind: 'cancel' });
  });

  it('judges a name the way the engine cleans it', () => {
    expect(renameOutcome('Golden', '...')).toEqual({ kind: 'cancel' });
    expect(renameOutcome('Golden', 'A/B')).toEqual({ kind: 'save', name: 'A/B' });
  });
});

describe('the actions', () => {
  it('rename sends the name and answers the new slug', async () => {
    const d = deps();
    const slug = await createLutActions(d).rename('golden-hour-warm', 'Golden Hour');
    expect(d.update).toHaveBeenCalledWith({
      slug: 'golden-hour-warm',
      patch: { name: 'Golden Hour' },
    });
    expect(slug).toBe('golden-hour');
  });

  it('says the engine’s sentence when a rename is refused, and answers null', async () => {
    const d = deps({
      update: vi.fn().mockRejectedValue(new Error('Another LUT already has this name.')),
    });
    expect(await createLutActions(d).rename('a', 'B')).toBeNull();
    expect(d.notice.error).toHaveBeenCalledWith('Another LUT already has this name.');
  });

  it('duplicate and Show in Finder call the engine and say a refusal', async () => {
    const d = deps({
      reveal: vi.fn().mockRejectedValue(new Error('Finder could not show the file.')),
    });
    const actions = createLutActions(d);
    await actions.duplicate('a');
    expect(d.duplicate).toHaveBeenCalledWith('a');
    await actions.reveal('a');
    expect(d.reveal).toHaveBeenCalledWith('a');
    expect(d.notice.error).toHaveBeenCalledWith('Finder could not show the file.');
  });

  it('copies @luts/<slug> and says so', async () => {
    const d = deps();
    await createLutActions(d).copyToken('golden-hour-warm');
    expect(d.copyText).toHaveBeenCalledWith('@luts/golden-hour-warm');
    expect(d.notice.info).toHaveBeenCalledWith('Copied @luts/golden-hour-warm');
  });

  it('says so when the clipboard refuses', async () => {
    const d = deps({ copyText: vi.fn().mockRejectedValue(new Error('denied')) });
    await createLutActions(d).copyToken('a');
    expect(d.notice.error).toHaveBeenCalledWith('The clipboard did not take it.');
    expect(d.notice.info).not.toHaveBeenCalled();
  });

  it('delete answers true quietly when the file went to the Trash', async () => {
    const d = deps();
    expect(await createLutActions(d).remove('a', 'A')).toBe(true);
    expect(d.remove).toHaveBeenCalledWith('a');
    expect(d.notice.info).not.toHaveBeenCalled();
  });

  it('delete says where the file is when macOS would not take it to the Trash', async () => {
    const d = deps({
      remove: vi.fn().mockResolvedValue({ ok: true, where: '/data/deleted-luts' }),
    });
    expect(await createLutActions(d).remove('a', 'Warm')).toBe(true);
    expect(d.notice.info).toHaveBeenCalledWith(
      '“Warm” is deleted, but not in the Trash',
      'macOS would not take it there, so it is in /data/deleted-luts.',
    );
  });

  it('delete answers false and says why when the engine refuses', async () => {
    const d = deps({
      remove: vi.fn().mockRejectedValue(new Error('A built-in LUT cannot be changed.')),
    });
    expect(await createLutActions(d).remove('film-contrast', 'Film contrast')).toBe(false);
    expect(d.notice.error).toHaveBeenCalledWith('A built-in LUT cannot be changed.');
  });
});

describe('the small pieces', () => {
  it('writes the token', () => {
    expect(lutToken('film-contrast')).toBe('@luts/film-contrast');
  });

  it('turns anything into a sentence', () => {
    expect(messageOf(new Error('Nope.'))).toBe('Nope.');
    expect(messageOf(new Error(''))).toBe('Something went wrong.');
    expect(messageOf('x')).toBe('Something went wrong.');
  });
});

describe('runDelete', () => {
  it('waits while the engine works, then closes whatever the answer was', async () => {
    const events: string[] = [];
    const ui = {
      setPending: (pending: boolean) => events.push(`pending:${pending}`),
      close: () => events.push('close'),
    };
    const remove = vi.fn(async () => {
      events.push('remove');
      return true;
    });
    expect(await runDelete({ slug: 'a', name: 'A' }, remove, ui)).toBe(true);
    expect(remove).toHaveBeenCalledWith('a', 'A');
    expect(events).toEqual(['pending:true', 'remove', 'pending:false', 'close']);
  });

  it('closes the dialog on a refusal too', async () => {
    const ui = { setPending: vi.fn(), close: vi.fn() };
    expect(await runDelete({ slug: 'a', name: 'A' }, async () => false, ui)).toBe(false);
    expect(ui.close).toHaveBeenCalledTimes(1);
  });
});
