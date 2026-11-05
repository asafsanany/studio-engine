import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { jobsUnreachable, useSettings } from '@/data';
import { SKELETON_DELAY_MS, useDelayedFlag } from '@/features/jobs/delayed-flag';
import { FeatureSwitches } from '@/features/settings/FeatureSwitches';
import { SETTINGS_TEXT } from '@/features/settings/settings-text';

function FeaturesSkeleton() {
  const show = useDelayedFlag(true, SKELETON_DELAY_MS);
  if (!show) return null;
  return (
    <div data-slot="settings-skeleton" className="flex flex-col gap-3">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-[168px] w-full rounded-lg" />
      <Skeleton className="mt-3 h-4 w-14" />
      <Skeleton className="h-14 w-full rounded-lg" />
    </div>
  );
}

/**
 * The Settings page (admin only; Mac only): the switches. A title with a line under it, the three
 * feature switches (Graphics, Fonts, LUTs) and the Claude one (Claude plan only); a change is saved
 * at once and counts after the engine restarts.
 */
export function SettingsPage() {
  const { data: settings, isError, failureCount, refetch } = useSettings();
  const failed = jobsUnreachable({ data: settings, isError, failureCount });
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl leading-tight font-semibold tracking-[-0.02em]">
          {SETTINGS_TEXT.title}
        </h1>
        <p className="text-muted-foreground">{SETTINGS_TEXT.intro}</p>
      </div>
      {settings ? (
        <FeatureSwitches settings={settings} />
      ) : failed ? (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>{SETTINGS_TEXT.unreachable}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="cursor-pointer"
            onClick={() => void refetch()}
          >
            {SETTINGS_TEXT.retry}
          </Button>
        </div>
      ) : (
        <FeaturesSkeleton />
      )}
    </div>
  );
}
