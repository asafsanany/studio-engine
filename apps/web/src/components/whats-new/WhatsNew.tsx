import { WhatsNewDialog, type WhatsNewVariant } from './WhatsNewDialog';
import { useWhatsNewStore } from './whats-new-store';

/**
 * Shows the "What's new" dialog for the releases the user has not seen yet (nothing when there
 * are none). Mounted once, in the app shell; the sidebar version button reopens the current notes.
 * The phone shell mounts it with `variant="sheet"`, so the same notes slide up from the bottom
 * (the Settings page's "What's new" row reopens them there).
 */
export function WhatsNew({ variant = 'dialog' }: { variant?: WhatsNewVariant }) {
  const releases = useWhatsNewStore((state) => state.releases);
  const open = useWhatsNewStore((state) => state.open);
  const close = useWhatsNewStore((state) => state.close);

  return <WhatsNewDialog releases={releases} open={open} onClose={close} variant={variant} />;
}
