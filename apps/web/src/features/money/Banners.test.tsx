import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { render as renderWithTooltips } from '@/components/jobs/test-helpers';
import { makeJobDelivery, makeMoneyResponse } from '@/data/test-utils';
import { JobStatusIcon } from '../jobs/JobStatusIcon';
import { Banners } from './Banners';

const markup = (unpaid: { value: number; count: number }) => {
  const money = makeMoneyResponse();
  return renderToStaticMarkup(
    <Banners
      data={{
        month: money.month,
        ledger: money.ledger,
        banners: { ...money.banners, income: { ...money.banners.income, unpaid } },
      }}
    />,
  );
};

/** The `<svg …>` tags inside the "not paid yet" line. */
const unpaidSvgs = (html: string) =>
  (html.match(/data-unpaid=""[\s\S]*?<\/div>/)?.[0] ?? '').match(/<svg[^>]*>/g) ?? [];

describe('<Banners>: the Income card’s "not paid yet" line', () => {
  it('says the amount and the count of videos', () => {
    const html = markup({ value: 120, count: 3 });
    expect(html).toContain('data-unpaid=""');
    expect(html).toContain('₪120');
    expect(html).toContain('not paid yet · 3 videos');
  });

  it('is not there when everything is paid', () => {
    expect(markup({ value: 0, count: 0 })).not.toContain('data-unpaid');
  });

  it('draws the Jobs list’s Delivered icon at 14 px: the same drawing and colour class', () => {
    const [glyph] = unpaidSvgs(markup({ value: 120, count: 3 }));
    expect(glyph).toContain('width="14"');
    expect(glyph).toContain('height="14"');
    expect(glyph).toContain('viewBox="0 0 16 16"');
    expect(glyph).toContain('text-status-delivered');
    // It is decoration: the line says the same in words.
    expect(glyph).toContain('aria-hidden="true"');
    expect(glyph).not.toContain('role="img"');

    const jobsIcon = renderWithTooltips(
      <JobStatusIcon
        job={{ state: 'ready', step: null, delivery: makeJobDelivery({ paidOn: null }) }}
      />,
    );
    expect(jobsIcon).toContain('text-status-delivered');
    // Same arrow, so the two cannot drift apart.
    const arrow = 'd="M4.8 8h6.1M8.4 5.4 11 8l-2.6 2.6"';
    expect(markup({ value: 120, count: 3 })).toContain(arrow);
    expect(jobsIcon).toContain(arrow);
  });
});
