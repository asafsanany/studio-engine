import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeFontFace } from '@/data/test-utils';
import {
  browserFontEnv,
  createFontFaceRegistry,
  FONT_RETRY_AFTER_MS,
  type FontFaceDescriptorsLike,
  type FontFaceEnv,
  type FontFaceLike,
  faceStack,
  fontFamilyOfFile,
  fontSourceOf,
  hebrewFallbackStack,
  mixedStack,
  weightDescriptorOf,
} from './font-faces';
import { requestFaces, useFontFace, useFontFaces } from './use-font-face';

// The registry that puts a font file in the page once, and the hooks over it. The browser is a
// stand-in that records what it was asked, so the tests need no browser.

interface Made {
  family: string;
  source: string;
  descriptors: FontFaceDescriptorsLike;
  face: FontFaceLike;
  /** Settles the file's load. */
  finish: (ok: boolean) => void;
}

function fakeBrowser() {
  const made: Made[] = [];
  const inPage = new Set<FontFaceLike>();
  const removed: FontFaceLike[] = [];
  const env: FontFaceEnv = {
    create(family, source, descriptors) {
      let finish: Made['finish'] = () => {};
      const loaded = new Promise<void>((resolve, reject) => {
        finish = (ok) => (ok ? resolve() : reject(new Error('no file')));
      });
      const face: FontFaceLike = { load: () => loaded };
      made.push({ family, source, descriptors, face, finish });
      return face;
    },
    add: (face) => {
      inPage.add(face);
    },
    remove: (face) => {
      inPage.delete(face);
      removed.push(face);
    },
  };
  return { env, made, inPage, removed };
}

/** Lets the promises that were settled run. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const heeboBold = makeFontFace({ fileId: 'aaa111', weight: 700, version: '1761350400000' });
const heeboRegular = makeFontFace({
  name: 'Heebo',
  fileId: 'bbb222',
  weight: 400,
  version: '1761350400001',
});

describe('names and addresses', () => {
  it('gives every file a family name of its own, fe-<fileId>', () => {
    expect(fontFamilyOfFile('aaa111')).toBe('fe-aaa111');
    expect(fontFamilyOfFile('a"b\\c')).toBe('fe-abc');
    expect(faceStack(heeboBold)).toBe('"fe-aaa111", sans-serif');
  });

  it('points the rule at the served file, with its version and format', () => {
    expect(fontSourceOf(heeboBold)).toBe(
      'url("/api/fonts/file/aaa111?v=1761350400000") format("truetype")',
    );
    expect(fontSourceOf({ fileId: 'x', version: undefined, format: 'woff2' })).toBe(
      'url("/api/fonts/file/x") format("woff2")',
    );
    expect(fontSourceOf({ fileId: 'x', version: '5', format: 'otf' })).toContain(
      'format("opentype")',
    );
  });

  it('gives a file its one weight, or the range of the instances that share it', () => {
    expect(weightDescriptorOf(heeboBold)).toBe('700');
    const thin = makeFontFace({ fileId: 'var', weight: 100 });
    const black = makeFontFace({ fileId: 'var', weight: 900 });
    const other = makeFontFace({ fileId: 'other', weight: 400 });
    expect(weightDescriptorOf(thin, [thin, other, black])).toBe('100 900');
    expect(weightDescriptorOf(black, [thin, other, black])).toBe('100 900');
    expect(weightDescriptorOf(other, [thin, other, black])).toBe('400');
  });

  it('sets Hebrew in the library Heebo, else in a Heebo the Mac has, else the shipped Hebrew font', () => {
    expect(hebrewFallbackStack({ fileId: 'hb1' })).toBe(
      '"fe-hb1", "Heebo", "Noto Sans Hebrew", sans-serif',
    );
    expect(hebrewFallbackStack(null)).toBe('"Heebo", "Noto Sans Hebrew", sans-serif');
    expect(mixedStack({ fileId: 'p1' }, { fileId: 'hb1' })).toBe(
      '"fe-p1", "fe-hb1", "Heebo", "Noto Sans Hebrew", sans-serif',
    );
    expect(mixedStack({ fileId: 'p1' }, null)).toBe(
      '"fe-p1", "Heebo", "Noto Sans Hebrew", sans-serif',
    );
  });
});

describe('the registry', () => {
  it('adds one rule per file, with swap, and only once however often it is asked', () => {
    const { env, made, inPage } = fakeBrowser();
    const registry = createFontFaceRegistry(env);

    expect(registry.request(heeboBold)).toBe('loading');
    expect(registry.request(heeboBold)).toBe('loading');
    expect(registry.request({ ...heeboBold })).toBe('loading');
    registry.request(heeboRegular);

    expect(made).toHaveLength(2);
    expect(inPage.size).toBe(2);
    expect(made[0]).toMatchObject({
      family: 'fe-aaa111',
      source: 'url("/api/fonts/file/aaa111?v=1761350400000") format("truetype")',
      descriptors: { weight: '700', style: 'normal', display: 'swap' },
    });
    expect(made[1]?.family).toBe('fe-bbb222');
  });

  it('adds a variable file once, with the weight range of the faces that share it', () => {
    const { env, made } = fakeBrowser();
    const registry = createFontFaceRegistry(env);
    const family = [100, 400, 900].map((weight) => makeFontFace({ fileId: 'inter-var', weight }));

    for (const face of family) registry.request(face, family);

    expect(made).toHaveLength(1);
    expect(made[0]?.descriptors.weight).toBe('100 900');
  });

  it('tells an italic face to the browser', () => {
    const { env, made } = fakeBrowser();
    createFontFaceRegistry(env).request(makeFontFace({ fileId: 'it', italic: true }));
    expect(made[0]?.descriptors.style).toBe('italic');
  });

  it('answers when a file is loaded, and tells the listeners', async () => {
    const { env, made } = fakeBrowser();
    const registry = createFontFaceRegistry(env);
    let told = 0;
    registry.subscribe(() => {
      told += 1;
    });
    const before = registry.getVersion();

    expect(registry.stateOf('aaa111')).toBeUndefined();
    registry.request(heeboBold);
    expect(registry.stateOf('aaa111')).toBe('loading');
    made[0]?.finish(true);
    await settled();

    expect(registry.stateOf('aaa111')).toBe('loaded');
    expect(told).toBe(1);
    expect(registry.getVersion()).toBeGreaterThan(before);
    // Asking after it is loaded neither adds nor tells anything.
    expect(registry.request(heeboBold)).toBe('loaded');
    expect(made).toHaveLength(1);
    expect(told).toBe(1);
  });

  it('says failed when the file cannot be had, and stops telling after unsubscribe', async () => {
    const { env, made } = fakeBrowser();
    const registry = createFontFaceRegistry(env);
    let told = 0;
    const stop = registry.subscribe(() => {
      told += 1;
    });
    registry.request(heeboBold);
    made[0]?.finish(false);
    await settled();
    expect(registry.stateOf('aaa111')).toBe('failed');
    expect(told).toBe(1);

    stop();
    registry.request(heeboRegular);
    made[1]?.finish(true);
    await settled();
    expect(registry.stateOf('bbb222')).toBe('loaded');
    expect(told).toBe(1);
  });

  it('tries a failed file again only after a wait', async () => {
    let clock = 1_000_000;
    const { env, made } = fakeBrowser();
    const registry = createFontFaceRegistry(env, () => clock);
    registry.request(heeboBold);
    made[0]?.finish(false);
    await settled();

    clock += FONT_RETRY_AFTER_MS - 1;
    expect(registry.request(heeboBold)).toBe('failed');
    expect(made).toHaveLength(1);

    clock += 1;
    expect(registry.request(heeboBold)).toBe('loading');
    expect(made).toHaveLength(2);
    made[1]?.finish(true);
    await settled();
    expect(registry.stateOf('aaa111')).toBe('loaded');
  });

  it('replaces the rule when the file changed (a new version)', async () => {
    const { env, made, inPage, removed } = fakeBrowser();
    const registry = createFontFaceRegistry(env);
    registry.request(heeboBold);
    made[0]?.finish(true);
    await settled();

    expect(registry.request({ ...heeboBold, version: '1761999999999' })).toBe('loading');

    expect(made).toHaveLength(2);
    expect(removed).toEqual([made[0]?.face]);
    expect(inPage.has(made[0]?.face as FontFaceLike)).toBe(false);
    expect(inPage.has(made[1]?.face as FontFaceLike)).toBe(true);
    expect(made[1]?.source).toContain('?v=1761999999999');
    // The old file settling late does not touch the new one.
    made[1]?.finish(false);
    await settled();
    expect(registry.stateOf('aaa111')).toBe('failed');
  });

  it('says failed, and keeps quiet afterwards, where the browser has no FontFace', () => {
    const registry = createFontFaceRegistry(null);
    let told = 0;
    registry.subscribe(() => {
      told += 1;
    });
    expect(registry.request(heeboBold)).toBe('failed');
    expect(registry.request(heeboBold)).toBe('failed');
    expect(registry.stateOf('aaa111')).toBe('failed');
    expect(told).toBe(1);
  });

  it('says failed when the browser refuses the rule', () => {
    const { env } = fakeBrowser();
    const registry = createFontFaceRegistry({
      ...env,
      create() {
        throw new SyntaxError('bad source');
      },
    });
    expect(registry.request(heeboBold)).toBe('failed');
  });

  it('has no browser in a server render or a test', () => {
    expect(browserFontEnv()).toBeNull();
  });
});

describe('the hooks', () => {
  it('ask for every face once through requestFaces, and again change nothing', () => {
    const { env, made } = fakeBrowser();
    const registry = createFontFaceRegistry(env);
    const faces = [heeboBold, heeboRegular];

    requestFaces(registry, faces);
    requestFaces(registry, faces);

    expect(made.map((one) => one.family)).toEqual(['fe-aaa111', 'fe-bbb222']);
  });

  it('answer each face’s state, in order, from the registry', async () => {
    const { env, made } = fakeBrowser();
    const registry = createFontFaceRegistry(env);
    requestFaces(registry, [heeboBold, heeboRegular]);
    made[1]?.finish(true);
    await settled();

    let states: string[] = [];
    let single = '';
    let none = '';
    function Probe() {
      states = useFontFaces([heeboBold, heeboRegular], undefined, registry);
      single = useFontFace(heeboRegular, undefined, registry);
      none = useFontFace(null, undefined, registry);
      return null;
    }
    renderToStaticMarkup(<Probe />);

    expect(states).toEqual(['loading', 'loaded']);
    expect(single).toBe('loaded');
    expect(none).toBe('loading');
  });

  it('say loading for a face nothing has asked for yet', () => {
    const registry = createFontFaceRegistry(fakeBrowser().env);
    let state = '';
    function Probe() {
      state = useFontFace(heeboBold, undefined, registry);
      return null;
    }
    renderToStaticMarkup(<Probe />);
    expect(state).toBe('loading');
  });
});
