import { Button } from '@/components/ui/button';

export interface ShowingOldBarProps {
  /** The older version on show. */
  shown: number;
  /** The version edits use. */
  newest: number;
  /** "Use vN again" is refused while a version is being made. */
  useDisabled?: boolean;
  onBackToNewest(): void;
  onUseOld(): void;
}

/**
 * "Showing v1. Edits use v2." with [Back to v2] and [Use v1 again] (board GRStudio). Back to v2 only
 * changes what is on show; Use v1 again makes v1 the version edits use, as a new version.
 */
export function ShowingOldBar({
  shown,
  newest,
  useDisabled = false,
  onBackToNewest,
  onUseOld,
}: ShowingOldBarProps) {
  return (
    <div
      data-slot="showing-old"
      className="flex items-center gap-2 rounded-lg border bg-card py-1.5 pr-1.5 pl-3 text-sm"
    >
      <span className="min-w-0 flex-1 truncate">{`Showing v${shown}. Edits use v${newest}.`}</span>
      <Button type="button" variant="ghost" size="sm" onClick={onBackToNewest}>
        {`Back to v${newest}`}
      </Button>
      <Button type="button" variant="outline" size="sm" disabled={useDisabled} onClick={onUseOld}>
        {`Use v${shown} again`}
      </Button>
    </div>
  );
}
