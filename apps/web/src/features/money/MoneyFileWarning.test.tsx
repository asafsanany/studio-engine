import type { MoneyFileState } from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  MONEY_FILE_DEFAULTS_TEXT,
  MONEY_FILE_LAST_GOOD_TEXT,
  MoneyFileWarning,
} from './MoneyFileWarning';

const render = (moneyFile: MoneyFileState) =>
  renderToStaticMarkup(<MoneyFileWarning moneyFile={moneyFile} />);

const ISSUE = 'charges[2].date: must be a date written YYYY-MM-DD, like 2026-10-14';

describe('<MoneyFileWarning>', () => {
  it('shows nothing while money.json is fine', () => {
    expect(render({ status: 'ok', issue: null })).toBe('');
  });

  it('says the page shows the last good numbers, and where to look', () => {
    const html = render({ status: 'last-good', issue: ISSUE });
    expect(MONEY_FILE_LAST_GOOD_TEXT).toBe(
      'money.json has a mistake, so this page shows the last good numbers. Run pnpm run doctor to see it.',
    );
    expect(html).toContain(
      '>money.json has a mistake, so this page shows the last good numbers. Run pnpm run doctor to see it.</p>',
    );
    expect(html).toContain('data-money-file="last-good"');
    expect(html).not.toContain('no good version');
  });

  it('says there is no good version, so the numbers are defaults and Mark delivered is off', () => {
    const html = render({ status: 'defaults', issue: ISSUE });
    expect(MONEY_FILE_DEFAULTS_TEXT).toBe(
      'money.json has a mistake and no good version is saved, so prices and expenses are defaults and Mark delivered is off. Run pnpm run doctor.',
    );
    expect(html).toContain(
      '>money.json has a mistake and no good version is saved, so prices and expenses are defaults and Mark delivered is off. Run pnpm run doctor.</p>',
    );
    expect(html).toContain('data-money-file="defaults"');
    expect(html).not.toContain('last good numbers');
  });

  it.each(['last-good', 'defaults'] as const)(
    'puts the first problem under the %s sentence in muted text',
    (status) => {
      const html = render({ status, issue: ISSUE });
      expect(html.indexOf(ISSUE)).toBeGreaterThan(html.indexOf('money.json has a mistake'));
      expect(html).toMatch(
        new RegExp(
          `<p class="[^"]*text-muted-foreground[^"]*">${ISSUE.replace(/[[\].]/g, '\\$&')}</p>`,
        ),
      );
    },
  );

  it('draws the sentence in the warning colour, after a small warning icon, with no box or button', () => {
    const html = render({ status: 'last-good', issue: ISSUE });
    expect(html).toMatch(/<svg[^>]*lucide-triangle-alert[^>]*text-status-held/);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toMatch(/<p class="text-status-held">money\.json has a mistake/);
    expect(html.indexOf('<svg')).toBeLessThan(html.indexOf('money.json has a mistake'));
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<a ');
    expect(html).not.toMatch(/\bborder\b|\bbg-/);
  });

  it('leaves the problem line out when there is none to show', () => {
    const html = render({ status: 'last-good', issue: null });
    expect(html).not.toContain('text-muted-foreground');
    expect(html).toContain('money.json has a mistake');
  });
});
