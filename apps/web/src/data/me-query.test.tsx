import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useIsAdmin, useViewerRole } from './hooks';
import {
  isAdmin,
  ME_KEY,
  ROLE_KEY,
  readRememberedRole,
  rememberRole,
  roleLabel,
  signedInAs,
} from './me-query';
import { createEditorQueryClient, createTestQueryClient, makeMe } from './test-utils';

// Who is asking (TM4): unknown is not admin, and the role this browser remembers only paints the
// first frame for the admin.

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

describe('isAdmin', () => {
  it('is true for the admin only; nobody is admin until the engine has said', () => {
    expect(isAdmin(undefined)).toBe(false);
    expect(isAdmin(makeMe({ role: 'editor' }))).toBe(false);
    expect(isAdmin(makeMe({ role: 'admin' }))).toBe(true);
  });
});

describe('signedInAs', () => {
  it('says the name and the role', () => {
    expect(signedInAs(makeMe({ name: 'Yael', role: 'editor' }))).toBe('Yael · Editor');
    expect(signedInAs(makeMe({ name: 'The owner', role: 'admin' }))).toBe('The owner · Admin');
  });

  it('falls back to the login for a person with no name', () => {
    expect(signedInAs(makeMe({ name: ' ', email: 'amit@example.com', role: 'editor' }))).toBe(
      'amit@example.com · Editor',
    );
  });

  it('labels the roles', () => {
    expect([roleLabel('admin'), roleLabel('editor')]).toEqual(['Admin', 'Editor']);
  });
});

describe('the remembered role', () => {
  it('is null when nothing is kept or the value is odd, and what was kept otherwise', () => {
    expect(readRememberedRole(memoryStorage())).toBeNull();
    expect(readRememberedRole(memoryStorage({ [ROLE_KEY]: 'owner' }))).toBeNull();
    const storage = memoryStorage();
    rememberRole('editor', storage);
    expect(readRememberedRole(storage)).toBe('editor');
    rememberRole('admin', storage);
    expect(readRememberedRole(storage)).toBe('admin');
  });

  it('never throws when the browser blocks storage', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readRememberedRole(blocked)).toBeNull();
    expect(() => rememberRole('admin', blocked)).not.toThrow();
    expect(readRememberedRole(null)).toBeNull();
  });
});

function Probe() {
  return (
    <p>
      {String(useViewerRole())}/{String(useIsAdmin())}
    </p>
  );
}

function render(client = createTestQueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
}

describe('useIsAdmin', () => {
  it('is true for the admin and false for an editor', () => {
    expect(render()).toBe('<p>admin/true</p>');
    expect(render(createEditorQueryClient())).toBe('<p>editor/false</p>');
  });

  it('follows the engine’s answer when it changes', () => {
    const client = createEditorQueryClient();
    client.setQueryData(ME_KEY, makeMe({ role: 'admin' }));
    expect(render(client)).toBe('<p>admin/true</p>');
  });
});
