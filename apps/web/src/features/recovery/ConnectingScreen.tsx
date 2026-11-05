import { LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { reloadPage } from './ErrorScreen';

/** How long the page waits in silence before it says "Connecting…": an answer that is quick needs no words. */
export const CONNECTING_LABEL_MS = 500;
/** How long before "Connecting…" gets a Reload button (the same 6 s as the watchdog in index.html). */
export const CONNECTING_SLOW_MS = 6_000;

export type ConnectingStage = 'quiet' | 'label' | 'slow';

/** What the connecting screen shows after `elapsedMs`. */
export function connectingStage(elapsedMs: number): ConnectingStage {
  if (elapsedMs >= CONNECTING_SLOW_MS) return 'slow';
  if (elapsedMs >= CONNECTING_LABEL_MS) return 'label';
  return 'quiet';
}

/**
 * What App draws while a narrow window does not yet know which layout to be in (the engine has not
 * answered and nothing was remembered): the dark page, then "Connecting…" after half a second, then
 * a Reload button after 6 s, so a Mac that never answers is not an empty screen.
 */
export function ConnectingScreen() {
  const [stage, setStage] = useState<ConnectingStage>('quiet');
  useEffect(() => {
    const label = setTimeout(() => setStage('label'), CONNECTING_LABEL_MS);
    const slow = setTimeout(() => setStage('slow'), CONNECTING_SLOW_MS);
    return () => {
      clearTimeout(label);
      clearTimeout(slow);
    };
  }, []);
  return <ConnectingView stage={stage} onReload={reloadPage} />;
}

/** The screen itself. Pure: the stage and the reload come in as props. */
export function ConnectingView({
  stage,
  onReload,
}: {
  stage: ConnectingStage;
  onReload: () => void;
}) {
  return (
    <div
      data-slot="layout-pending"
      className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground"
    >
      {stage !== 'quiet' && (
        <>
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Connecting…
          </p>
          {stage === 'slow' && (
            <>
              <p className="max-w-xs text-sm text-muted-foreground">
                This is taking longer than usual. Check that the Mac is awake and that Tailscale is
                on.
              </p>
              <Button type="button" variant="outline" onClick={onReload} className="h-11 px-5">
                Reload
              </Button>
            </>
          )}
        </>
      )}
    </div>
  );
}
