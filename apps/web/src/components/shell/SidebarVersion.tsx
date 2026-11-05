import { Button } from '@/components/ui/button';
import { whatsNewStore } from '@/components/whats-new/whats-new-store';
import { APP_VERSION, APP_VERSION_LABEL } from '@/lib/version';

/**
 * The version in the sidebar footer (hidden on the icon rail). A ghost button: it opens the
 * "What's new" dialog for the running version.
 */
export function SidebarVersion() {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={`What's new in version ${APP_VERSION}`}
      onClick={() => whatsNewStore.getState().openCurrent()}
      // Canvas: 28 px tall, 12 px muted text that keeps its colour on hover (only the background
      // changes), tabular figures.
      className="h-7 rounded-sm px-2 py-0 text-xs font-normal text-muted-foreground tabular-nums hover:text-muted-foreground dark:hover:bg-accent group-data-[collapsible=icon]:hidden"
    >
      {APP_VERSION_LABEL}
    </Button>
  );
}
