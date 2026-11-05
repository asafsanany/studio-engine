import { describe, expect, it, vi } from 'vitest';
import { createFontImportIntake } from './font-import-intake';

const ttf = (name: string) => new File(['x'], name);

function setup({ offline = false } = {}) {
  const session = { take: vi.fn(), cancel: vi.fn(() => true) };
  const onOpenChange = vi.fn();
  const state = { offline };
  const intake = createFontImportIntake({
    session,
    isOffline: () => state.offline,
    onOpenChange,
  });
  return { intake, session, onOpenChange, state };
}

describe('files dropped on the page while the dialog is closed', () => {
  it('open the dialog, which stages them as soon as the page says it is open', () => {
    const { intake, session, onOpenChange } = setup();
    const files = [ttf('Heebo-Bold.ttf'), ttf('Rubik-Bold.ttf')];
    intake.dropOnPage(files);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(session.take).not.toHaveBeenCalled();
    intake.openChanged(true);
    expect(session.take).toHaveBeenCalledWith(files);
  });

  it('are staged once: opening the dialog again by the button starts at step 1', () => {
    const { intake, session } = setup();
    intake.dropOnPage([ttf('Heebo-Bold.ttf')]);
    intake.openChanged(true);
    intake.openChanged(false);
    intake.openChanged(true);
    expect(session.take).toHaveBeenCalledTimes(1);
  });

  it('are ignored while the engine cannot be reached', () => {
    const { intake, session, onOpenChange } = setup({ offline: true });
    intake.dropOnPage([ttf('Heebo-Bold.ttf')]);
    expect(onOpenChange).not.toHaveBeenCalled();
    intake.openChanged(true);
    expect(session.take).not.toHaveBeenCalled();
  });

  it('are not staged when the engine went away between the drop and the dialog', () => {
    const { intake, session, state } = setup();
    intake.dropOnPage([ttf('Heebo-Bold.ttf')]);
    state.offline = true;
    intake.openChanged(true);
    expect(session.take).not.toHaveBeenCalled();
  });

  it('open the dialog with its notice when the dropped folder had no fonts in it', () => {
    const { intake, session, onOpenChange } = setup();
    intake.dropOnPage([]);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    intake.openChanged(true);
    expect(session.take).toHaveBeenCalledWith([]);
  });
});

describe('files dropped while the dialog is open', () => {
  it('go to the session', () => {
    const { intake, session } = setup();
    const files = [ttf('Heebo-Bold.ttf')];
    intake.dropInDialog(files);
    expect(session.take).toHaveBeenCalledWith(files);
  });

  it('are left alone while the engine cannot be reached', () => {
    const { intake, session } = setup({ offline: true });
    intake.dropInDialog([ttf('Heebo-Bold.ttf')]);
    expect(session.take).not.toHaveBeenCalled();
  });
});

describe('the dialog closing', () => {
  it('throws an unfinished upload away', () => {
    const { intake, session } = setup();
    intake.openChanged(true);
    intake.openChanged(false);
    expect(session.cancel).toHaveBeenCalledTimes(1);
  });

  it('forgets files that were waiting for it', () => {
    const { intake, session } = setup();
    intake.dropOnPage([ttf('Heebo-Bold.ttf')]);
    intake.openChanged(false);
    intake.openChanged(true);
    expect(session.take).not.toHaveBeenCalled();
  });

  it('opening it with the button takes nothing', () => {
    const { intake, session } = setup();
    intake.openChanged(true);
    expect(session.take).not.toHaveBeenCalled();
  });
});
