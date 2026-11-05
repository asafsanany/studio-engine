import { useNavigate } from '@tanstack/react-router';
import { useInstagramEnabled } from '@/data';
import { askToAssign } from './assign/assign-dialog';
import { type ClientMenuActions, clientMenuActions } from './client-menu';
import type { ClientSummary } from './clients';
import { askToDeleteClient } from './delete-client-dialog';
import { askToEditInstagram } from './instagram/instagram-dialog';
import { askToRenameClient } from './rename-client-dialog';
import { revealClient } from './reveal-client';

/**
 * What a client's menu does in the app, for the right-click menu of a row of the Clients list and
 * the ⋯ menu of the client's page: the pages and Finder, and the dialogs of Instagram…, Assign to…,
 * Rename… and Delete…, whose hosts the page mounts. Instagram… is there only while Clients ×
 * Instagram is on.
 */
export function useClientMenuActions(client: ClientSummary): ClientMenuActions {
  const navigate = useNavigate();
  const instagramOn = useInstagramEnabled();
  return clientMenuActions(client.clientId, {
    navigate: (location) => void navigate(location),
    reveal: (clientId) => void revealClient(clientId),
    instagram: instagramOn ? (clientId) => askToEditInstagram(clientId) : undefined,
    assign: () => askToAssign({ clientId: client.clientId, name: client.name }),
    rename: () => askToRenameClient({ clientId: client.clientId, name: client.name }),
    remove: () =>
      askToDeleteClient({
        clientId: client.clientId,
        name: client.name,
        jobCount: client.jobCount,
      }),
  });
}
