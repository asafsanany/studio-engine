import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createVapidKeyStore,
  ensureVapidKeys,
  pushKeysPath,
  VapidKeysError,
} from './vapid-keys.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-push-keys-'));
  dirs.push(dir);
  return dir;
}

const KEYS = { publicKey: 'public-key', privateKey: 'private-key' };
const NOW = new Date('2026-10-22T10:00:00.000Z');

describe('ensureVapidKeys', () => {
  it('makes the pair once into push.json with mode 0600', () => {
    const dataDir = tempDir();
    const generate = vi.fn(() => KEYS);

    expect(ensureVapidKeys({ dataDir, generate, clock: () => NOW })).toEqual(KEYS);

    const path = pushKeysPath(dataDir);
    expect(path).toBe(join(dataDir, 'push.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      ...KEYS,
      createdAt: '2026-10-22T10:00:00.000Z',
    });
  });

  it('creates the data folder when it is not there yet', () => {
    const dataDir = join(tempDir(), 'not', 'yet');
    ensureVapidKeys({ dataDir, generate: () => KEYS });
    expect(JSON.parse(readFileSync(pushKeysPath(dataDir), 'utf8'))).toMatchObject(KEYS);
  });

  it('reads the pair it made before and never makes another', () => {
    const dataDir = tempDir();
    ensureVapidKeys({ dataDir, generate: () => KEYS });
    const generate = vi.fn(() => ({ publicKey: 'other', privateKey: 'other' }));

    expect(ensureVapidKeys({ dataDir, generate })).toEqual(KEYS);
    expect(generate).not.toHaveBeenCalled();
  });

  it('leaves no temporary file behind', () => {
    const dataDir = tempDir();
    ensureVapidKeys({ dataDir, generate: () => KEYS });
    expect(readdirSync(dataDir)).toEqual(['push.json']);
  });

  it('makes a readable-by-others file private again', () => {
    const dataDir = tempDir();
    ensureVapidKeys({ dataDir, generate: () => KEYS });
    chmodSync(pushKeysPath(dataDir), 0o644);

    ensureVapidKeys({ dataDir, generate: () => KEYS });

    expect(statSync(pushKeysPath(dataDir)).mode & 0o777).toBe(0o600);
  });

  it('refuses a file that is not a pair of keys, and does not write over it', () => {
    for (const text of ['not json', '{}', '{"publicKey":"only-one"}', 'null']) {
      const dataDir = tempDir();
      writeFileSync(pushKeysPath(dataDir), text);
      const generate = vi.fn(() => KEYS);

      expect(() => ensureVapidKeys({ dataDir, generate })).toThrow(VapidKeysError);
      expect(generate).not.toHaveBeenCalled();
      expect(readFileSync(pushKeysPath(dataDir), 'utf8')).toBe(text);
    }
  });

  it('says it when the file cannot be written', () => {
    const dataDir = tempDir();
    // A file where the data folder should be.
    const blocker = join(dataDir, 'blocker');
    writeFileSync(blocker, '');
    expect(() => ensureVapidKeys({ dataDir: blocker, generate: () => KEYS })).toThrow(
      /cannot be written/,
    );
  });
});

describe('createVapidKeyStore', () => {
  it('makes nothing until asked, then keeps the pair', () => {
    const dataDir = tempDir();
    const generate = vi.fn(() => KEYS);
    const store = createVapidKeyStore({ dataDir, generate });
    expect(generate).not.toHaveBeenCalled();

    expect(store.get()).toEqual(KEYS);
    expect(store.get()).toEqual(KEYS);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('tries again after a failure', () => {
    const dataDir = tempDir();
    writeFileSync(pushKeysPath(dataDir), 'broken');
    const store = createVapidKeyStore({ dataDir, generate: () => KEYS });
    expect(() => store.get()).toThrow(VapidKeysError);

    writeFileSync(pushKeysPath(dataDir), JSON.stringify(KEYS));

    expect(store.get()).toEqual(KEYS);
  });
});
