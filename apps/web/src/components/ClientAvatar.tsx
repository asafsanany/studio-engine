import { clientHue, initials } from '@studio/shared';
import { type CSSProperties, createContext, useContext, useSyncExternalStore } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { type ClientPhotoSources, NO_CLIENT_PHOTOS, photoKey } from '@/data/client-photos';
import { cn } from '@/lib/utils';

/**
 * The Instagram picture of each client that has one, by name (Clients × Instagram): given by
 * `ClientPhotosProvider` while the switch is on. Without a provider, and while the switch is off,
 * it is empty and every avatar shows its initials, as before Instagram.
 */
export const ClientPhotosContext = createContext<ClientPhotoSources>(NO_CLIENT_PHOTOS);

// The pictures that did not load, by address: shared by every avatar of the client, so a picture
// that is gone is asked for once and not again by each row. A new picture has a new address
// (`?v=`), so it is tried afresh.
const failedPhotos = new Set<string>();
const failedListeners = new Set<() => void>();

/** Tells every avatar that this picture did not load: they show the initials from now on. */
export function markPhotoFailed(src: string): void {
  if (failedPhotos.has(src)) return;
  failedPhotos.add(src);
  for (const listener of [...failedListeners]) listener();
}

/** Forgets which pictures failed (tests start from a clean slate). */
export function forgetFailedPhotos(): void {
  failedPhotos.clear();
  for (const listener of [...failedListeners]) listener();
}

function subscribeToFailed(listener: () => void): () => void {
  failedListeners.add(listener);
  return () => {
    failedListeners.delete(listener);
  };
}

/** The address of the client's picture, or `null` when it has none or it did not load. */
function usePhotoSrc(client: string): string | null {
  const src = useContext(ClientPhotosContext).get(photoKey(client)) ?? null;
  const hasFailed = () => src !== null && failedPhotos.has(src);
  // The same answer on a server (tests render there), where nothing is ever subscribed to.
  const failed = useSyncExternalStore(subscribeToFailed, hasFailed, hasFailed);
  return failed ? null : src;
}

/**
 * A client's initials in a circle, tinted with a hue generated from the client name (the same
 * client always gets the same colour): 32 px in a table row, 40 px (`lg`) on the client's page, 24 px
 * (`sm`) on a client's header in the phone jobs list. It is decoration (the name next to it says
 * the same in words), and `dir="auto"` lets Hebrew read right to left.
 *
 * A client with an Instagram picture (and only while Clients × Instagram is on) shows it instead:
 * the picture lies over the initials, so they are what shows until it has loaded, and again when
 * it fails to (the address answers 404, or the engine is away). `photoClassName` is for a page that
 * draws the picture larger than the initials circle (the client page's 56 px): it applies while
 * the client has a picture, so the initials are already that size when the picture loads over them.
 * `photo={false}` keeps the initials whatever the client has (the Clients list does so for a
 * private account, board L1).
 */
export function ClientAvatar({
  client,
  size,
  className,
  photoClassName,
  photo: withPhoto = true,
}: {
  client: string;
  size?: 'sm' | 'default' | 'lg';
  /** Changes the circle's size where a page needs another (the phone client page's 48 px). */
  className?: string;
  /** More classes while the client has a picture (the client page's 56 px). */
  photoClassName?: string;
  /** Shows the client's Instagram picture when it has one (the default); `false`: always the initials. */
  photo?: boolean;
}) {
  const source = usePhotoSrc(client);
  const photo = withPhoto ? source : null;
  return (
    <Avatar
      size={size}
      aria-hidden="true"
      className={cn(className, photo !== null && photoClassName)}
    >
      <AvatarFallback
        dir="auto"
        className={cn(
          'bg-[hsl(var(--client-hue)_55%_50%/0.2)] text-[hsl(var(--client-hue)_60%_30%)] dark:text-[hsl(var(--client-hue)_75%_78%)]',
          size === 'lg' && 'text-sm',
          size === 'sm' && 'text-[11px]',
        )}
        style={{ '--client-hue': clientHue(client) } as CSSProperties}
      >
        {initials(client)}
      </AvatarFallback>
      {photo !== null && (
        <img
          src={photo}
          alt=""
          data-slot="client-photo"
          draggable={false}
          decoding="async"
          onError={() => markPhotoFailed(photo)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </Avatar>
  );
}
