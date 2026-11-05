import { describe, expect, it } from 'vitest';
import { clientMenuEntries } from './client-menu';

describe('clientMenuEntries for an editor', () => {
  const actions = { open: () => undefined, viewStyle: () => undefined, reveal: () => undefined };
  const shape = (admin?: boolean) =>
    clientMenuEntries(actions, admin).map((entry) =>
      entry.type === 'separator' ? '---' : entry.label,
    );

  it('keeps Show in Finder for the admin', () => {
    expect(shape()).toEqual(['Open', 'View style', '---', 'Show in Finder']);
    expect(shape(true)).toEqual(['Open', 'View style', '---', 'Show in Finder']);
  });

  it('ends at View style for an editor, with no line after it', () => {
    expect(shape(false)).toEqual(['Open', 'View style']);
  });
});
