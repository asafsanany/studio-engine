import { useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { LoaderCircle, WifiOff } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { reloadJobs } from '@/data/jobs-query';
import { lastConnectedLabel, offlineTitle } from './offline-labels';
import { useEngineLastHeard, useEngineOffline } from './use-engine-offline';

/** How long "Try again" says "Trying…" before it can be pressed again. */
const TRYING_MS = 1_600;

/**
 * The offline screen (board MOffline): what the phone shows when the engine has been out of reach
 * for more than 5 s (the Mac asleep, off the tailnet), in place of a list that has stopped being
 * live. PhoneShell wraps its page area in it. It goes away by itself the moment the events stream
 * (or a fetch of the list) gets an answer, so nothing here decides when the engine is back.
 *
 * "Try again" asks for the list now instead of at the next retry (the query retries every 2 s on
 * its own); an answer is what ends the screen, so the button only shows that it tried.
 *
 * The page stays mounted underneath, hidden, so what was on it (a search, a scroll position, an
 * open sheet's state) is there when the engine is back.
 */
export function PhoneOffline({ children }: { children: ReactNode }) {
  const offline = useEngineOffline();
  const lastHeardAt = useEngineLastHeard();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const queryClient = useQueryClient();
  const [trying, setTrying] = useState(false);

  useEffect(() => {
    if (!trying) return;
    const timer = setTimeout(() => setTrying(false), TRYING_MS);
    return () => clearTimeout(timer);
  }, [trying]);

  return (
    <PhoneOfflineView
      offline={offline}
      title={offlineTitle(pathname)}
      lastConnected={lastHeardAt === null ? null : lastConnectedLabel(lastHeardAt, Date.now())}
      trying={trying}
      onRetry={() => {
        if (trying) return;
        setTrying(true);
        void reloadJobs(queryClient);
      }}
    >
      {children}
    </PhoneOfflineView>
  );
}

/** The page, or the message instead of it. Pure: the state comes in as props. */
export function PhoneOfflineView({
  offline,
  title,
  lastConnected,
  trying,
  onRetry,
  children,
}: {
  offline: boolean;
  title: string;
  /** "Last connected today at 14:02", or null when the engine never answered. */
  lastConnected: string | null;
  trying: boolean;
  onRetry: () => void;
  children: ReactNode;
}) {
  return (
    <>
      {/* `contents` takes this box out of the layout, so the page's header and main are the shell's
          flex items as before; `hidden` keeps the page (and its state) while the message shows. */}
      <div data-slot="phone-page" className={offline ? 'hidden' : 'contents'}>
        {children}
      </div>
      {offline && (
        <section
          data-slot="phone-offline"
          aria-labelledby="phone-offline-title"
          aria-live="polite"
          className="flex flex-1 flex-col"
        >
          <header className="flex h-13 flex-none items-center px-4">
            <h1 className="text-2xl leading-tight font-semibold tracking-[-0.02em]">{title}</h1>
          </header>
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 pb-10 text-center">
            <span
              aria-hidden="true"
              className="flex size-12 items-center justify-center rounded-xl bg-muted"
            >
              <WifiOff className="size-6" />
            </span>
            <h2 id="phone-offline-title" className="mt-1 text-lg font-semibold">
              Can’t reach your Mac
            </h2>
            <p className="text-[15px] text-pretty text-muted-foreground">
              Studio Engine runs on your Mac. Check that the Mac is awake and that Tailscale is on,
              on the Mac and on this phone.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={onRetry}
              aria-disabled={trying}
              className="mt-2 h-11 min-w-40 cursor-pointer px-5 text-[15px] ease-in-out"
            >
              {trying && <LoaderCircle className="animate-spin" aria-hidden="true" />}
              {trying ? 'Trying…' : 'Try again'}
            </Button>
            {lastConnected !== null && (
              <span className="text-[13px] text-zinc-500">{lastConnected}</span>
            )}
          </div>
        </section>
      )}
    </>
  );
}
