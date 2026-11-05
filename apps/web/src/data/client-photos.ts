// Where each client's Instagram picture is (Clients × Instagram, IG12): the client list says when a
// picture was saved (`instagram.photoAt`), and the engine serves it at
// `/api/clients/:clientId/photo?v=<that time>`. Avatars only know a client by name, so the lookup is
// by the name's NFC spelling, the way the engine tells two spellings of one folder apart.

import type { ClientRow } from '@studio/shared';
import { clientPhotoSrc } from './instagram-api';

/** Client name (NFC) to the address of its picture. */
export type ClientPhotoSources = ReadonlyMap<string, string>;

/** No client has a picture: while the switch is off, and until the client list is in. */
export const NO_CLIENT_PHOTOS: ClientPhotoSources = new Map();

/** The name as the lookup spells it. */
export function photoKey(client: string): string {
  return client.normalize('NFC');
}

/**
 * The address of the picture of every client that has one: a client with an account whose picture a
 * scan has saved. Clients without an account, and accounts not scanned yet, are left out and show
 * their initials. An empty map when the list is not in (or was sent without Instagram).
 */
export function clientPhotoSources(rows: readonly ClientRow[] | undefined): ClientPhotoSources {
  const sources = new Map<string, string>();
  for (const row of rows ?? []) {
    const photoAt = row.instagram?.photoAt;
    if (photoAt != null) sources.set(photoKey(row.client), clientPhotoSrc(row.clientId, photoAt));
  }
  return sources;
}
