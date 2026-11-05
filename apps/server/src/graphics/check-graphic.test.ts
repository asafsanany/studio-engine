import { describe, expect, it } from 'vitest';
import {
  AFTER_END_SEC,
  CHECK_SIZES,
  checkHostHtml,
  emptyFieldMoments,
  fieldIds,
  lintReport,
  parseArgs,
  seconds,
} from '../../assets/graphics/check-graphic.mjs';

// The check script a graphic run calls (assets/graphics/check-graphic.mjs): its arguments, the host
// it writes for each size and how it reads lint. The snapshots themselves need a browser; GR2's
// acceptance ran them for real.

const ID = 'a1b2c3d4e5f6';

describe('the arguments', () => {
  it('takes the id and the length, and adds the frame after the end', () => {
    expect(parseArgs([ID, '3'])).toEqual({ id: ID, lengthSec: 3, at: [1.5, 2.85, 3.3], vars: {} });
    expect(parseArgs([ID, '2.5', '--at', '2,0.4', '--vars', '{"name":"דנה"}'])).toEqual({
      id: ID,
      lengthSec: 2.5,
      at: [0.4, 2, 2.5 + AFTER_END_SEC],
      vars: { name: 'דנה' },
    });
  });

  it('says what is wrong with a call it cannot use', () => {
    for (const argv of [
      [],
      [ID],
      ['not-an-id', '3'],
      [ID, '0.1'],
      [ID, '31'],
      [ID, '3', '--at'],
      [ID, '3', '--at', 'soon'],
      [ID, '3', '--vars', '[1]'],
      [ID, '3', '--vars', 'nope'],
      [ID, '3', 'extra'],
    ]) {
      expect(parseArgs(argv)).toHaveProperty('error');
    }
  });
});

describe('the host of one size', () => {
  it('mounts the graphic for the whole root over a checkerboard, at that size', () => {
    const html = checkHostHtml({
      id: ID,
      lengthSec: 3,
      width: 1920,
      height: 1080,
      vars: { name: 'A "B"' },
    });
    expect(html).toContain('data-width="1920" data-height="1080" data-duration="3.8"');
    expect(html).toContain(
      `<div id="graphic" data-composition-id="lib-${ID}" data-composition-src="compositions/lib-${ID}.html" data-start="0" data-duration="3.8"`,
    );
    expect(html).toContain(
      'data-variable-values="{&quot;name&quot;:&quot;A \\&quot;B\\&quot;&quot;}"',
    );
    expect(html).toContain('#graphic { position: absolute; inset: 0; }');
    expect(html).toContain('<script src="vendor/gsap.min.js"></script>');
    expect(html).toContain('window.__timelines["main"] = gsap.timeline({ paused: true });');
  });

  it('checks the three sizes of the preview', () => {
    expect(CHECK_SIZES.map((size) => [size.name, size.width, size.height])).toEqual([
      ['9x16', 1080, 1920],
      ['16x9', 1920, 1080],
      ['1x1', 1080, 1080],
    ]);
    expect(seconds(2.5 + 0.8)).toBe('3.3');
  });
});

// CVP-278: one more snapshot, at 9:16, with every text field the graphic declares set to "".
describe('the empty-fields snapshot', () => {
  const declared = (value: string) =>
    `<!doctype html>\n<html lang="he" data-composition-variables='${value}'>\n<head></head>`;

  it('reads the ids of the declared text fields, in order', () => {
    const list =
      '[{"id":"name","type":"string","label":"Name","default":"דנה"},{"id":"role","type":"string","label":"Role","default":"x"}]';
    expect(fieldIds(declared(list))).toEqual({ ids: ['name', 'role'] });
    // A double-quoted attribute holds the same list with &quot;.
    expect(
      fieldIds(`<html data-composition-variables="${list.replaceAll('"', '&quot;')}">`),
    ).toEqual({ ids: ['name', 'role'] });
    expect(fieldIds(declared('[]'))).toEqual({ ids: [] });
  });

  it('takes no attribute as no fields, and tells a broken one apart', () => {
    expect(fieldIds('<html lang="he"><body></body></html>')).toEqual({ ids: [] });
    expect(fieldIds(declared('[{"id":"a"'))).toHaveProperty('error');
    expect(fieldIds(declared('{"id":"a"}'))).toHaveProperty('error');
  });

  it('skips entries without an id and repeated ids', () => {
    expect(fieldIds(declared('[{"id":"a"},{"label":"b"},null,{"id":"a"},{"id":3}]'))).toEqual({
      ids: ['a'],
    });
  });

  it('is taken at the moments asked for, not at the frame after the end', () => {
    // Length 3: the check added 3.3 by itself.
    expect(emptyFieldMoments([1.5, 2.85, 3.3], 3)).toEqual([1.5, 2.85]);
    expect(emptyFieldMoments([0.4, 2, 2.8], 2.5)).toEqual([0.4, 2]);
    // Only the frame after the end was asked for: that one is the moment.
    expect(emptyFieldMoments([3.3], 3)).toEqual([3.3]);
  });

  it('mounts the graphic with every field set to an empty string', () => {
    const html = checkHostHtml({
      id: ID,
      lengthSec: 3,
      width: 1080,
      height: 1920,
      vars: { name: '', role: '' },
    });
    expect(html).toContain(
      'data-variable-values="{&quot;name&quot;:&quot;&quot;,&quot;role&quot;:&quot;&quot;}"',
    );
  });
});

describe('the lint report', () => {
  it('lists the findings and marks the engine’s own warning as expected', () => {
    const output = `noise before\n${JSON.stringify({
      ok: false,
      errorCount: 1,
      warningCount: 1,
      findings: [
        {
          code: 'subcomposition_blanks_before_host',
          severity: 'warning',
          message: 'blank for ~0.8s',
          fixHint: 'Set it to 3.8',
          file: '/x/work/index.html',
          line: 18,
        },
        {
          code: 'gsap_css_transform_conflict',
          severity: 'error',
          message: 'transform fights the tween',
          fixHint: 'Use fromTo',
          file: `/x/work/compositions/lib-${ID}.html`,
          line: 40,
        },
      ],
    })}`;
    const report = lintReport(output);
    expect(report.errors).toBe(1);
    expect(report.lines).toEqual([
      'Lint: 1 error, 1 warning.',
      '  warning subcomposition_blanks_before_host (work/index.html:18): blank for ~0.8s [expected: the engine’s index.html; leave it]',
      `  error gsap_css_transform_conflict (compositions/lib-${ID}.html:40): transform fights the tween`,
      '    Fix: Use fromTo',
    ]);
  });

  it('counts lint it cannot read as an error', () => {
    expect(lintReport('npx: command not found').errors).toBe(1);
  });
});
