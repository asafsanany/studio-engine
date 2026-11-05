import { Bell } from 'lucide-react';
import { useState } from 'react';
import { useStore } from 'zustand';
import { Clapperboard } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  NOTIFY_CARD_BODY,
  NOTIFY_CARD_TITLE,
  NOTIFY_DENIED_BODY,
  NOTIFY_DENIED_TITLE,
  notifyCardWanted,
} from './notify-card';
import { pushStore } from './push-store';
import { usePushKey, usePushSupport, useTurnOn } from './use-push';

/**
 * The "Turn on notifications" card the Jobs page shows under its header in the Home Screen app
 * (board MTurnOn), until notifications are on or the card is put away. "Turn on" asks iOS right
 * in the tap, subscribes and registers this phone with the engine; when the answer is Don't Allow,
 * the card says once how to allow notifications in iOS Settings. "Not now" is remembered: the
 * card does not come back, and Settings keeps "Turn on".
 */
export function NotifyCard() {
  const support = usePushSupport();
  const [shown, setShown] = useState(() => {
    // Read once, as the page opens: the card never pops in after the page has drawn.
    const { permission, deviceId, cardMemory } = pushStore.getState();
    return notifyCardWanted({
      support,
      permission,
      hasDevice: deviceId !== null,
      memory: cardMemory,
    });
  });
  const [told, setTold] = useState(false);
  const publicKey = usePushKey(shown);
  const { turnOn, working, error } = useTurnOn(publicKey);
  const rememberCard = useStore(pushStore, (state) => state.rememberCard);

  if (!shown) return null;

  if (told) return <NotifyDeniedCardView onDismiss={() => setShown(false)} />;

  return (
    <NotifyCardView
      working={working}
      error={error}
      onDismiss={() => {
        rememberCard('dismissed');
        setShown(false);
      }}
      onTurnOn={() => {
        void turnOn().then((result) => {
          if (result.kind === 'on') setShown(false);
          if (result.kind === 'denied') {
            // Said once: the card is not shown again, whatever happens next.
            rememberCard('told');
            setTold(true);
          }
        });
      }}
    />
  );
}

const CARD = 'mx-4 mt-3 flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground';

/** The icon and the title, as the Add to Home Screen card has them. */
function CardHeading({ id, title }: { id: string; title: string }) {
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className="flex size-11 flex-none items-center justify-center rounded-lg bg-primary text-primary-foreground"
      >
        <Clapperboard className="size-[22px]" />
      </span>
      <h2 id={id} className="text-base leading-snug font-semibold">
        {title}
      </h2>
    </div>
  );
}

/** The card itself (board MTurnOn): the title, what it brings, "Not now" and "Turn on". */
export function NotifyCardView({
  working = false,
  error = null,
  onDismiss,
  onTurnOn,
}: {
  working?: boolean;
  error?: string | null;
  onDismiss: () => void;
  onTurnOn: () => void;
}) {
  return (
    <section data-slot="notify-card" aria-labelledby="notify-card-title" className={CARD}>
      <CardHeading id="notify-card-title" title={NOTIFY_CARD_TITLE} />
      <p className="text-[15px] text-pretty text-zinc-300">{NOTIFY_CARD_BODY}</p>
      {error !== null && (
        <p role="alert" className="text-[13px] text-pretty text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-11 flex-1 text-[15px]"
          onClick={onDismiss}
        >
          Not now
        </Button>
        <Button
          type="button"
          className="h-11 flex-1 text-[15px]"
          disabled={working}
          onClick={onTurnOn}
        >
          <Bell aria-hidden="true" />
          {working ? 'Turning on…' : 'Turn on'}
        </Button>
      </div>
    </section>
  );
}

/** After Don't Allow: how to allow notifications in iOS Settings, and one "Got it". */
export function NotifyDeniedCardView({ onDismiss }: { onDismiss: () => void }) {
  return (
    <section data-slot="notify-card" aria-labelledby="notify-card-title" className={CARD}>
      <CardHeading id="notify-card-title" title={NOTIFY_DENIED_TITLE} />
      <p className="text-[15px] text-pretty text-zinc-300">{NOTIFY_DENIED_BODY}</p>
      <Button type="button" className="h-11 text-[15px]" onClick={onDismiss}>
        Got it
      </Button>
    </section>
  );
}
