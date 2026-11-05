import { WifiOff } from 'lucide-react';
import { heardAtLabel } from '@/features/graphics/list/graphic-list';

/**
 * The line under the header when the engine can't be reached (board LUStates 10): when the list was
 * last right, if known, and that importing waits. "HH:MM" is the time the engine last answered, on
 * the Mac's clock (the same watch the phone's "Can't reach your Mac" screen and the Graphics banner
 * use).
 */
export function lutsOfflineText(heardAt: number | null): string {
  const asItWas =
    heardAt === null ? '' : ` This is the list as it was at ${heardAtLabel(heardAt)}.`;
  return `Can’t reach the engine on your Mac.${asItWas} Importing waits until it’s back.`;
}

/** The banner itself: full width under the 56 px header, a hairline under it, like the board. */
export function LutsOfflineBanner({ heardAt }: { heardAt: number | null }) {
  return (
    <div
      role="status"
      data-slot="luts-offline-banner"
      className="flex flex-none items-center gap-2.5 border-b bg-card px-6 py-2.5 text-[13px] text-card-foreground"
    >
      <WifiOff aria-hidden="true" className="size-4 flex-none text-status-held" />
      {lutsOfflineText(heardAt)}
    </div>
  );
}
