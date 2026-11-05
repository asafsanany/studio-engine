import type { ReactNode } from 'react';
import { useClientPhotos } from '@/data';
import { ClientPhotosContext } from './ClientAvatar';

/**
 * Gives every `ClientAvatar` below it the Instagram pictures of the clients that have one (Clients
 * × Instagram): the app mounts it once, inside the query client. While the switch is off it gives
 * none, asks nothing, and every avatar shows its initials.
 */
export function ClientPhotosProvider({ children }: { children: ReactNode }) {
  return (
    <ClientPhotosContext.Provider value={useClientPhotos()}>
      {children}
    </ClientPhotosContext.Provider>
  );
}
