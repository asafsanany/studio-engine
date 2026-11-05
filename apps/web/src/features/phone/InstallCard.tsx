import { Share } from 'lucide-react';
import { useState } from 'react';
import { Clapperboard } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { installCardWanted, rememberInstallCardDismissed } from './install-card';

/**
 * The "Add to Home Screen" card that a first visit in the phone browser shows under the Jobs title
 * (board MFirstOpen). The phone jobs page mounts it; it decides for itself when to show (only in an
 * iPhone's browser, not once the app is on the Home Screen, and not within 30 days of the last "Not
 * now", see install-card.ts) and renders nothing otherwise.
 */
export function InstallCard() {
  const [shown, setShown] = useState(
    // Read once, as the page opens: the card never pops in after the page has drawn.
    () => typeof window !== 'undefined' && installCardWanted(window, Date.now()),
  );
  if (!shown) return null;

  return (
    <InstallCardView
      onDismiss={() => {
        rememberInstallCardDismissed(window, Date.now());
        setShown(false);
      }}
    />
  );
}

const STEP_NUMBER =
  'flex size-6 flex-none items-center justify-center rounded-full bg-secondary text-xs font-semibold';

/** The card itself. Both buttons put it away; the steps are the three of the board. */
export function InstallCardView({ onDismiss }: { onDismiss: () => void }) {
  return (
    <section
      data-slot="install-card"
      aria-labelledby="install-card-title"
      className="mx-4 mt-3 flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground"
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-11 flex-none items-center justify-center rounded-lg bg-primary text-primary-foreground"
        >
          <Clapperboard className="size-[22px]" />
        </span>
        <h2 id="install-card-title" className="text-base leading-snug font-semibold">
          Put Studio Engine on your Home Screen
        </h2>
      </div>
      <p className="text-[15px] text-pretty text-zinc-300">
        It opens like an app, without Safari around it, and it can send you notifications when a job
        needs you.
      </p>
      <ol className="flex flex-col gap-2 text-[15px]">
        <li className="flex items-center gap-2.5">
          <span aria-hidden="true" className={STEP_NUMBER}>
            1
          </span>
          <span>Tap Share</span>
          <Share
            role="img"
            aria-label="the Share icon"
            className="size-[18px] text-muted-foreground"
          />
          <span>in Safari</span>
        </li>
        <li className="flex items-center gap-2.5">
          <span aria-hidden="true" className={STEP_NUMBER}>
            2
          </span>
          <span>Tap Add to Home Screen</span>
        </li>
        <li className="flex items-center gap-2.5">
          <span aria-hidden="true" className={STEP_NUMBER}>
            3
          </span>
          <span>Open Studio Engine from its icon</span>
        </li>
      </ol>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-11 flex-1 text-[15px]"
          onClick={onDismiss}
        >
          Not now
        </Button>
        <Button type="button" className="h-11 flex-1 text-[15px]" onClick={onDismiss}>
          Got it
        </Button>
      </div>
    </section>
  );
}
