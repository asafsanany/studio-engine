import { DEFAULT_EFFORT, type Effort, type ReviewEffortChoice } from '@studio/shared';
import { createLucideIcon, type LucideIcon, Sparkles } from 'lucide-react';

// The gauge of an effort level (design canvas, page "Effort"): Lucide's gauge, an arc from the
// lower left over the top to the lower right (a 240° sweep around the hub at 12, 14), with the
// needle drawn from the hub at the level's place on the arc: Medium on the left, High straight up,
// Extra high on the right. Default runs at `DEFAULT_EFFORT`, so it shows that level's needle. Same
// size, stroke and class name as `lucide-react`'s Gauge.

const ARC = 'M3.34 19a10 10 0 1 1 17.32 0';

function gauge(needle: string): LucideIcon {
  return createLucideIcon('gauge', [
    ['path', { d: ARC, key: 'arc' }],
    ['path', { d: needle, key: 'needle' }],
  ]);
}

/** One gauge icon per level. */
const GAUGES: Readonly<Record<Effort, LucideIcon>> = {
  medium: gauge('M12 14 6.6 12.3'),
  high: gauge('M12 14V8.3'),
  xhigh: gauge('M12 14 17.4 12.3'),
};

/** The gauge icon of a level (`null` is Default, which runs at the default level). */
export function gaugeIcon(level: Effort | null): LucideIcon {
  return GAUGES[level ?? DEFAULT_EFFORT];
}

/**
 * The icon of an effort in Review (Quick fixes, design canvas page "Quick fixes", board "Effort
 * with Auto"; the owner picked sparkles on 25 Oct): Lucide's Sparkles for Auto, with the same size and
 * stroke as the gauges, and the level's gauge for a level. `null` is Default, as in `gaugeIcon`
 * (the edit's effort), not Auto: the review level's `null` is `'auto'` (`Job.reviewEffort ?? 'auto'`).
 */
export function effortIcon(choice: ReviewEffortChoice | null): LucideIcon {
  return choice === 'auto' ? Sparkles : gaugeIcon(choice);
}
