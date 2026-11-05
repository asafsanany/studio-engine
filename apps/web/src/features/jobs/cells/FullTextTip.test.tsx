import { describe, expect, it } from 'vitest';
import { FullTextTip, isCutOff } from './FullTextTip';
import { renderCell } from './test-helpers';

describe('isCutOff', () => {
  it('is true only when the text is wider than its box (the ellipsis is showing)', () => {
    expect(isCutOff({ scrollWidth: 233, clientWidth: 146 })).toBe(true);
    expect(isCutOff({ scrollWidth: 146, clientWidth: 146 })).toBe(false);
    expect(isCutOff({ scrollWidth: 90, clientWidth: 146 })).toBe(false);
  });

  it('is false when there is no element to measure', () => {
    expect(isCutOff(null)).toBe(false);
  });
});

describe('<FullTextTip>', () => {
  it('renders its child as it is, in a shrinkable wrapper, with the tooltip closed', () => {
    const markup = renderCell(
      <FullTextTip text="סרטון גיוס – Hiring video">
        <span className="bidi">סרטון גיוס – Hiring video</span>
      </FullTextTip>,
    );
    expect(markup).toBe(
      '<div class="min-w-0" data-state="closed" data-slot="tooltip-trigger"><span class="bidi">סרטון גיוס – Hiring video</span></div>',
    );
  });
});
