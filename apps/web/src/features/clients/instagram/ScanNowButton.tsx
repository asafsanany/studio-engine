import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * "Scan now": a ghost button with the refresh icon, in the Instagram section's head. While a scan
 * is on (the one this click started, or one that was already queued or running) it says "Scanning…",
 * the icon turns and the button cannot be pressed again; the section's numbers fill in when the
 * scan is done.
 */
export function ScanNowButton({ busy, onScan }: { busy: boolean; onScan: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onScan} disabled={busy} aria-busy={busy}>
      <RefreshCw
        aria-hidden="true"
        className={cn(busy && 'animate-spin duration-1000 motion-reduce:animate-none')}
      />
      {busy ? 'Scanning…' : 'Scan now'}
    </Button>
  );
}
