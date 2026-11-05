import { type Effort, effortLabel, type Job } from '@studio/shared';
import { gaugeIcon } from '@/components/effort-gauge';
import { useQuickFixesEnabled } from '@/data';
import { shownEffort } from '../effort-options';
import { HoverMarker } from './HoverMarker';

/**
 * The mark that says a job has an effort level (a job on Default has none): a muted 14 px gauge
 * right after the job's name, its needle at the level's place. Hovering or focusing it shows
 * "Effort: Max" (or the level's own name).
 */
export function EffortMarker({ effort }: { effort: Effort }) {
  const text = `Effort: ${effortLabel(effort)}`;
  return (
    <HoverMarker icon={gaugeIcon(effort)} label={text}>
      {text}
    </HoverMarker>
  );
}

/**
 * A job's effort mark: the level of its edit, or, for a job in Review while Quick fixes are on,
 * the level of its review rounds, which Auto leaves unmarked (Auto is the default, like Default).
 * Nothing when the job has no level to show.
 */
export function JobEffortMarker({ job }: { job: Job }) {
  const effort = shownEffort(job, useQuickFixesEnabled());
  return effort === null ? null : <EffortMarker effort={effort} />;
}
