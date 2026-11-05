import { describe, expect, it } from 'vitest';
import { firstLintError, lintResultOf } from './lint-preview.js';

// What `npx hyperframes lint --json edit/preview` printed in hyperframes 0.8.197 for a composition
// whose root had no data-width: the report, then notices that are not JSON.
const REPORT = `{
  "ok": false,
  "errorCount": 1,
  "warningCount": 1,
  "infoCount": 0,
  "findings": [
    { "code": "caption_overlap", "severity": "warning", "message": "Two captions overlap." },
    {
      "code": "root_missing_dimensions",
      "severity": "error",
      "message": "Root composition is missing \`data-width\` or \`data-height\`.",
      "file": "/Users/owner/Studio Inbox/Acme/Teaser/edit/preview/index.html",
      "line": 35
    }
  ],
  "filesScanned": 3,
  "_meta": { "version": "0.8.197", "latestVersion": "0.8.193", "updateAvailable": false }
}

  4 HyperFrames skills out of date or missing.
  Run: npx hyperframes skills update
`;

describe('firstLintError', () => {
  it('is the message of the first error, never a warning, and never the path', () => {
    expect(firstLintError(REPORT)).toBe(
      'Root composition is missing `data-width` or `data-height`.',
    );
  });

  it('falls back to the code when an error has no message', () => {
    const report = JSON.stringify({ findings: [{ severity: 'error', code: 'bad_root' }] });
    expect(firstLintError(report)).toBe('bad_root');
  });

  it('is null for a report with no error, and for output that is not a report', () => {
    expect(
      firstLintError(JSON.stringify({ findings: [{ severity: 'warning', message: 'x' }] })),
    ).toBeNull();
    expect(firstLintError('')).toBeNull();
    expect(firstLintError('not json at all')).toBeNull();
    expect(firstLintError('{ broken')).toBeNull();
  });
});

describe('lintResultOf', () => {
  it('passes on exit 0', () => {
    expect(lintResultOf(0, '')).toEqual({ ok: true });
  });

  it('fails on exit 1 with the first error', () => {
    expect(lintResultOf(1, REPORT)).toEqual({
      ok: false,
      why: 'lint: Root composition is missing `data-width` or `data-height`.',
    });
    expect(lintResultOf(1, 'unreadable')).toEqual({
      ok: false,
      why: 'the composition does not pass the lint',
    });
  });

  it.each([
    ['npx not found', 'ENOENT'],
    ['a signal or a timeout', null],
    ['another exit code', 2],
    ['no code at all', undefined],
  ])('says the check could not run for %s', (_name, exit) => {
    expect(lintResultOf(exit, REPORT)).toEqual({
      ok: false,
      why: 'the check of the composition could not run',
    });
  });
});
