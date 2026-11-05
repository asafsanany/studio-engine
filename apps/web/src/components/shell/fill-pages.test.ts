import { describe, expect, it } from 'vitest';
import { fillsWindow } from './fill-pages';

describe('fillsWindow', () => {
  it.each(['/luts', '/fonts', '/graphics', '/graphics/new', '/graphics/g-1'])(
    '%s fills the window',
    (path) => {
      expect(fillsWindow(path)).toBe(true);
    },
  );

  it.each([
    '/',
    '/jobs',
    '/clients',
    '/clients/acme',
    '/clients/acme/style',
    '/money',
    '/analytics',
    '/settings/team',
    '/lutsy',
    '/graphicsx',
  ])('%s does not', (path) => {
    expect(fillsWindow(path)).toBe(false);
  });
});
