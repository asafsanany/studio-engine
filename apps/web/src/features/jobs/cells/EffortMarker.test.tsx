import type { HealthResponse, Job } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient, makeJob } from '@/data/test-utils';
import { renderCell } from './test-helpers';

// As in NoteMarker.test: the tooltip's content only exists while it is open, in a portal, so the
// tooltip pieces are swapped for plain elements that always show their content.
vi.mock('@/components/ui/tooltip', async () => {
  const { createElement: h, Fragment } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    TooltipProvider: ({ children }: Props) => h(Fragment, null, children),
    Tooltip: ({ children }: Props) => h(Fragment, null, children),
    TooltipTrigger: ({ children }: Props) => h(Fragment, null, children),
    TooltipContent: ({ children, className, dir }: Props) =>
      h('div', { role: 'tooltip', class: className, dir }, children),
  };
});

const { EffortMarker, JobEffortMarker } = await import('./EffortMarker');

describe('<EffortMarker>', () => {
  it('is a muted 14 px gauge', () => {
    const markup = renderCell(<EffortMarker effort="high" />);
    expect(markup).toContain('lucide-gauge');
    expect(markup).toMatch(/<svg[^>]*width="14"[^>]*height="14"/);
    expect(markup).toContain('text-muted-foreground');
    expect(markup).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it('has its needle at the level’s place', () => {
    expect(renderCell(<EffortMarker effort="medium" />)).toContain('d="M12 14 6.6 12.3"');
    expect(renderCell(<EffortMarker effort="high" />)).toContain('d="M12 14V8.3"');
    expect(renderCell(<EffortMarker effort="xhigh" />)).toContain('d="M12 14 17.4 12.3"');
  });

  it.each([
    ['medium', 'Effort: Medium'],
    ['high', 'Effort: High'],
    ['xhigh', 'Effort: Extra high'],
  ] as const)('is named "%s" → "%s", and says so in its tooltip', (effort, text) => {
    const markup = renderCell(<EffortMarker effort={effort} />);
    expect(markup).toContain(`aria-label="${text}"`);
    expect(markup).toMatch(new RegExp(`<div[^>]*role="tooltip"[^>]*>${text}</div>`));
  });

  it('is reachable with the keyboard, never shrinks and shows no blue ring', () => {
    const markup = renderCell(<EffortMarker effort="xhigh" />);
    expect(markup).toMatch(/<span[^>]*tabindex="0"/);
    expect(markup).toMatch(/<span[^>]*class="[^"]*\bshrink-0\b/);
    expect(markup).toContain('focus-visible:ring-ring/35');
    expect(markup).not.toMatch(/blue|focus:ring/);
  });
});

describe('<JobEffortMarker>', () => {
  const health = (quickFixes: boolean): HealthResponse => ({
    ok: true,
    version: '0.42.7',
    settleMs: 60_000,
    series: false,
    jobSheet: false,
    analytics: false,
    phone: false,
    graphics: false,
    graphicsInEdits: false,
    music: false,
    luts: false,
    lutsInEdits: false,
    fonts: false,
    fontsInNotes: false,
    quickFixes,
  });

  /** The marker of `job` with the Quick fixes switch at `quickFixes` (`null`: not heard yet). */
  const markerOf = (job: Job, quickFixes: boolean | null) => {
    const queryClient = createTestQueryClient();
    if (quickFixes !== null) queryClient.setQueryData(HEALTH_KEY, health(quickFixes));
    return renderCell(<JobEffortMarker job={job} />, queryClient);
  };

  const inReview = (overrides: Partial<Job>) =>
    makeJob({ state: 'review', placeInLine: null, ...overrides });

  it('shows nothing for a job in Review on Auto, whatever its edit’s effort, with Quick fixes on', () => {
    expect(markerOf(inReview({ effort: 'high', reviewEffort: null }), true)).toBe('');
    expect(markerOf(inReview({ effort: null, reviewEffort: null }), true)).toBe('');
  });

  it('names the level of a job in Review on a manual level, not the edit’s', () => {
    const markup = markerOf(inReview({ effort: 'xhigh', reviewEffort: 'medium' }), true);
    expect(markup).toContain('aria-label="Effort: Medium"');
    expect(markup).toContain('d="M12 14 6.6 12.3"');
    expect(markup).not.toContain('Extra high');
  });

  it('shows the edit’s level for a job in Review with Quick fixes off or not heard yet', () => {
    for (const quickFixes of [false, null]) {
      const markup = markerOf(inReview({ effort: 'high', reviewEffort: 'medium' }), quickFixes);
      expect(markup, String(quickFixes)).toContain('aria-label="Effort: High"');
    }
    expect(markerOf(inReview({ effort: null, reviewEffort: 'high' }), false)).toBe('');
  });

  it('shows the edit’s level for a job in any other state, with Quick fixes on', () => {
    const queued = makeJob({ state: 'queued', effort: 'high', reviewEffort: 'medium' });
    expect(markerOf(queued, true)).toContain('aria-label="Effort: High"');
    expect(markerOf({ ...queued, effort: null }, true)).toBe('');
  });
});
