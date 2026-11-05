import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClientStyleRepository } from '../db/index.js';
import { memoryDb } from '../db/test-utils.js';
import { clientIdFor } from '../inbox/scan.js';
import {
  type AddStyleFilesDeps,
  AddStyleFilesError,
  type AddStyleFilesRequest,
  addStyleFiles,
  CLIENT_FOLDER_MISSING,
  STYLE_BEING_ANALYSED,
  type StyleFileSource,
} from './add-style-files.js';
import type { StyleRunner } from './style-run.js';
import { StyleWorker } from './style-worker.js';

// The one path into a client's _Style folder, on the real repository (in memory), a temp inbox and
// a real style worker that is never started, so a queued pass stays queued and can be looked at.

const CLIENT = 'Kova Coffee';
const CLIENT_ID = clientIdFor(CLIENT);

let root: string;
let inboxPath: string;
let clientStyles: ClientStyleRepository;
let worker: StyleWorker;
let announced: { client: string; name: string; size: number; existedThen: boolean }[];
let deps: AddStyleFilesDeps;

const neverRuns: StyleRunner = {
  run: async () => {
    throw new Error('the worker is not started in these tests');
  },
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-add-style-files-'));
  inboxPath = join(root, 'inbox');
  clientStyles = new ClientStyleRepository(memoryDb());
  worker = new StyleWorker({
    clientStyles,
    inboxPath,
    dataDir: join(root, 'data'),
    runner: neverRuns,
  });
  announced = [];
  deps = {
    inboxPath,
    clientStyles,
    worker,
    uploads: {
      expectUpload: (client, name, stat) => {
        announced.push({
          client,
          name,
          size: stat.size,
          existedThen: existsSync(join(styleDir(), name)),
        });
      },
    },
  };
  mkdirSync(join(inboxPath, CLIENT), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const styleDir = () => join(inboxPath, CLIENT, '_Style');

const text = (name: string, content: string): StyleFileSource => ({
  name,
  write: async (path) => writeFileSync(path, content),
});

function request(overrides: Partial<AddStyleFilesRequest> = {}): AddStyleFilesRequest {
  return {
    clientId: CLIENT_ID,
    client: CLIENT,
    files: [text('notes.md', 'Keep the logo up.')],
    mode: 'add',
    whileAnalysing: 'queue',
    ...overrides,
  };
}

describe('adding files', () => {
  it('makes _Style, puts the files in under their names and queues exactly one pass for them', async () => {
    const { fileNames, style } = await addStyleFiles(
      deps,
      request({ files: [text('a.md', 'aaa'), text('b.md', 'bbbb')] }),
    );

    expect(fileNames).toEqual(['a.md', 'b.md']);
    expect(readdirSync(styleDir()).sort()).toEqual(['a.md', 'b.md']);
    expect(readFileSync(join(styleDir(), 'b.md'), 'utf8')).toBe('bbbb');
    expect(style).toMatchObject({ clientId: CLIENT_ID, client: CLIENT, state: 'analysing' });
    // No style.md yet: the add pass is create. One pass, both files.
    expect(clientStyles.get(CLIENT_ID)?.lastPass).toEqual({
      kind: 'read',
      mode: 'create',
      files: [
        { name: 'a.md', size: 3 },
        { name: 'b.md', size: 4 },
      ],
    });
  });

  it('gives a taken name " (1)", then " (2)", and never an engine file’s name', async () => {
    mkdirSync(styleDir(), { recursive: true });
    writeFileSync(join(styleDir(), 'notes.md'), 'mine');
    writeFileSync(join(styleDir(), 'notes (1).md'), 'mine too');

    const { fileNames } = await addStyleFiles(
      deps,
      request({
        files: [
          text('notes.md', 'new'),
          text('notes.md', 'newer'),
          text('style.md', 'not the style'),
        ],
      }),
    );

    expect(fileNames).toEqual(['notes (2).md', 'notes (3).md', 'style (1).md']);
    expect(readFileSync(join(styleDir(), 'notes.md'), 'utf8')).toBe('mine');
    expect(readFileSync(join(styleDir(), 'notes (3).md'), 'utf8')).toBe('newer');
    expect(existsSync(join(styleDir(), 'style.md'))).toBe(false);
  });

  it('tells the Finder drops about each file before it is there, with the size it has', async () => {
    await addStyleFiles(deps, request({ files: [text('a.md', 'aaa'), text('b.md', 'bbbb')] }));

    expect(announced).toEqual([
      { client: CLIENT, name: 'a.md', size: 3, existedThen: false },
      { client: CLIENT, name: 'b.md', size: 4, existedThen: false },
    ]);
  });

  it('leaves no staging folder behind', async () => {
    await addStyleFiles(deps, request());

    expect(readdirSync(styleDir())).toEqual(['notes.md']);
  });

  it('queues no pass and leaves no staging folder when a file can’t be written', async () => {
    const broken: StyleFileSource = {
      name: 'broken.md',
      write: async () => {
        throw new Error('disk full');
      },
    };

    await expect(addStyleFiles(deps, request({ files: [broken] }))).rejects.toThrow('disk full');

    expect(readdirSync(styleDir())).toEqual([]);
    expect(clientStyles.get(CLIENT_ID)).toBeNull();
  });

  it('needs at least one file', async () => {
    await expect(addStyleFiles(deps, request({ files: [] }))).rejects.toThrow(RangeError);
    expect(clientStyles.get(CLIENT_ID)).toBeNull();
  });

  it('works without the Finder drops (nobody to tell)', async () => {
    const { uploads: _, ...withoutDrops } = deps;

    const { fileNames } = await addStyleFiles(withoutDrops, request());

    expect(fileNames).toEqual(['notes.md']);
    expect(announced).toEqual([]);
  });

  it('never makes a client folder that is gone: 404, nothing written', async () => {
    rmSync(join(inboxPath, CLIENT), { recursive: true });

    const error = await addStyleFiles(deps, request()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AddStyleFilesError);
    expect(error).toMatchObject({ status: 404, message: CLIENT_FOLDER_MISSING });
    expect(existsSync(join(inboxPath, CLIENT))).toBe(false);
    expect(clientStyles.get(CLIENT_ID)).toBeNull();
  });
});

describe('a client that is analysing', () => {
  beforeEach(async () => {
    mkdirSync(styleDir(), { recursive: true });
    writeFileSync(join(styleDir(), 'brand.txt'), 'Use green.');
    await worker.enqueue(CLIENT, {
      kind: 'read',
      mode: 'add',
      files: [{ name: 'brand.txt', size: 10 }],
    });
    expect(clientStyles.get(CLIENT_ID)?.state).toBe('analysing');
  });

  it('refuses with 409 and writes nothing when the caller won’t wait', async () => {
    const error = await addStyleFiles(deps, request({ whileAnalysing: 'refuse' })).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(AddStyleFilesError);
    expect(error).toMatchObject({ status: 409, message: STYLE_BEING_ANALYSED });
    expect(readdirSync(styleDir())).toEqual(['brand.txt']);
    expect(announced).toEqual([]);
    expect(clientStyles.get(CLIENT_ID)?.lastPass).toMatchObject({ files: [{ name: 'brand.txt' }] });
  });

  it('queues the pass behind it when the caller will wait: no 409, no file left out', async () => {
    const { fileNames, style } = await addStyleFiles(deps, request({ whileAnalysing: 'queue' }));

    expect(fileNames).toEqual(['notes.md']);
    expect(style.state).toBe('analysing');
    expect(readdirSync(styleDir()).sort()).toEqual(['brand.txt', 'notes.md']);
    // It joins the pass that is waiting: both files are what the client still has to run.
    expect(clientStyles.get(CLIENT_ID)?.lastPass).toMatchObject({
      kind: 'read',
      files: [{ name: 'brand.txt' }, { name: 'notes.md' }],
    });
  });

  it('refuses only when asked to: a client that is not analysing takes either', async () => {
    const other = 'Arc Fitness';
    mkdirSync(join(inboxPath, other), { recursive: true });
    const result = await addStyleFiles(
      deps,
      request({ clientId: clientIdFor(other), client: other, whileAnalysing: 'refuse' }),
    );

    expect(result.fileNames).toEqual(['notes.md']);
    expect(statSync(join(inboxPath, other, '_Style', 'notes.md')).isFile()).toBe(true);
  });
});
