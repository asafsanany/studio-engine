import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { fieldIds } from '../../assets/graphics/check-graphic.mjs';
import {
  FAKE_GRAPHIC_KINDS,
  type FakeGraphicKind,
  GRAPHIC_TESTDATA_DIR,
  GRAPHIC_TESTDATA_ID,
} from './fake-graphic-runner.js';

// CVP-278: the canned graphics (what the fake run and the dev seed write) follow the graphic rule
// that a text field with no words hides its own element. Each one's script runs here against a
// minimal page with the values an edit would give; the real thing, a snapshot with the HyperFrames
// CLI, is what check-graphic.mjs does in a run.

const LIB = `lib-${GRAPHIC_TESTDATA_ID}`;

/** Per field: the ids (after `lib-<id>-`) of the elements that hide when that field is empty. */
const HIDES: Record<FakeGraphicKind, Record<string, string[]>> = {
  'lower-third': { name: ['name'], role: ['role'] },
  callout: { number: ['number'], label: ['label'] },
  title: { title: ['title'] },
  // The logo shows the handle's initials, so it goes with the handle.
  'end-card': { handle: ['handle', 'logo'], button: ['button'] },
};

/** What hides as well once every field of the graphic is empty: a plate that would be left over. */
const HIDES_WHEN_ALL_EMPTY: Partial<Record<FakeGraphicKind, string[]>> = {
  'end-card': ['card'],
};

class FakeElement {
  style: Record<string, string> = {};
  textContent = '';
  className = '';
  children: FakeElement[] = [];
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
}

/** Runs the graphic's script with `vars` and says which elements it hid, by their short ids. */
function hiddenWith(kind: FakeGraphicKind, vars: Record<string, unknown>): string[] {
  const html = readFileSync(
    join(GRAPHIC_TESTDATA_DIR, kind, 'compositions', `${LIB}.html`),
    'utf8',
  );
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (script === undefined) throw new Error(`${kind} has no script`);

  const elements = new Map<string, FakeElement>();
  const document = {
    querySelector(selector: string): FakeElement {
      let element = elements.get(selector);
      if (element === undefined) {
        element = new FakeElement();
        elements.set(selector, element);
      }
      return element;
    },
    createElement: () => new FakeElement(),
  };
  const timeline = {
    fromTo: () => timeline,
    to: () => timeline,
  };
  runInNewContext(script, {
    window: { __hyperframes: { getVariables: () => vars }, __timelines: {} },
    document,
    gsap: { timeline: () => timeline },
  });
  return [...elements]
    .filter(([, element]) => element.style.display === 'none')
    .map(([selector]) => selector.replace(`#${LIB}-`, ''))
    .sort();
}

describe.each(FAKE_GRAPHIC_KINDS)('the canned %s', (kind) => {
  const fields = Object.keys(HIDES[kind] ?? {});

  it('declares the fields this test knows', () => {
    const html = readFileSync(
      join(GRAPHIC_TESTDATA_DIR, kind, 'compositions', `${LIB}.html`),
      'utf8',
    );
    expect(fieldIds(html)).toEqual({ ids: fields });
  });

  it('hides nothing with the defaults, or with words in every field', () => {
    expect(hiddenWith(kind, {})).toEqual([]);
    const words = Object.fromEntries(fields.map((field) => [field, 'שלום 12']));
    expect(hiddenWith(kind, words)).toEqual([]);
  });

  it.each(fields)('hides what holds %s, and only that, when it is empty', (field) => {
    const others = Object.fromEntries(
      fields.filter((other) => other !== field).map((other) => [other, 'words']),
    );
    expect(hiddenWith(kind, { ...others, [field]: '' })).toEqual(
      [...(HIDES[kind]?.[field] ?? [])].sort(),
    );
  });

  it('takes a value of only spaces as empty', () => {
    const blank = Object.fromEntries(fields.map((field) => [field, '  \n ']));
    expect(hiddenWith(kind, blank)).toEqual(
      hiddenWith(kind, Object.fromEntries(fields.map((field) => [field, '']))),
    );
    expect(hiddenWith(kind, blank).length).toBeGreaterThan(0);
  });

  it('leaves nothing where a text was when every field is empty', () => {
    const empty = Object.fromEntries(fields.map((field) => [field, '']));
    const expected = [
      ...fields.flatMap((field) => HIDES[kind]?.[field] ?? []),
      ...(HIDES_WHEN_ALL_EMPTY[kind] ?? []),
    ].sort();
    expect(hiddenWith(kind, empty)).toEqual(expected);
  });
});
