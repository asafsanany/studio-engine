import type { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { createEditorQueryClient, createTestQueryClient } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import { HEALTH } from '../series/test-series';
import { assignDialogStore } from './assign/assign-dialog';
import { ClientMoreMenu } from './ClientMoreMenu';
import type { ClientSummary } from './clients';
import { deleteClientDialogStore } from './delete-client-dialog';
import { instagramDialogStore } from './instagram/instagram-dialog';
import { renameClientDialogStore } from './rename-client-dialog';
import { useClientMenuActions } from './use-client-menu-actions';

// The ⋯ beside Style on the client's page (C93, board CLPage): the client's row menu as a menu from
// a button. The menu opens on a click, so these look at the button as the page draws it and at what
// the menu's actions do, which are `useClientMenuActions`'s, the same as the Clients list's.

const FALCON: ClientSummary = {
  clientId: 'da98ff6d1e5a',
  name: 'Falcon FPV',
  initials: 'MF',
  jobCount: 3,
  lastJobAt: '2026-10-18T09:00:00.000Z',
};

const PATH = `/clients/${FALCON.clientId}`;

function world(client: QueryClient, instagram: boolean): QueryClient {
  client.setQueryData(HEALTH_KEY, { ...HEALTH, series: false, instagram });
  return client;
}

describe('<ClientMoreMenu>: the button', () => {
  it('is a ghost icon button named "More for" and the client, with the ⋯ icon', async () => {
    const markup = await renderAt(
      PATH,
      <ClientMoreMenu client={FALCON} />,
      world(createTestQueryClient(), true),
    );
    const button = markup.match(/<button [^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(button).toContain('aria-label="More for Falcon FPV"');
    expect(button).toContain('title="More for Falcon FPV"');
    expect(button).toContain('data-variant="ghost"');
    expect(button).toContain('data-size="icon-sm"');
    expect(button).toContain('aria-haspopup="menu"');
    expect(button).toContain('lucide-ellipsis');
    // Shut: the menu is not drawn until it is opened.
    expect(markup).not.toContain('role="menu"');
  });

  it('names a Hebrew client by its name', async () => {
    const markup = await renderAt(
      PATH,
      <ClientMoreMenu client={{ ...FALCON, name: 'מאפיית הצפון' }} />,
      world(createTestQueryClient(), true),
    );
    expect(markup).toContain('aria-label="More for מאפיית הצפון"');
  });

  it('is there for an editor while Instagram is on (Instagram… is theirs too)', async () => {
    const markup = await renderAt(
      PATH,
      <ClientMoreMenu client={FALCON} />,
      world(createEditorQueryClient(), true),
    );
    expect(markup).toContain('aria-label="More for Falcon FPV"');
  });

  it('is there for the admin with the switch off (Assign to…, Rename…, Delete…)', async () => {
    const markup = await renderAt(
      PATH,
      <ClientMoreMenu client={FALCON} />,
      world(createTestQueryClient(), false),
    );
    expect(markup).toContain('aria-label="More for Falcon FPV"');
  });

  it('is left out for an editor with the switch off: nothing would be in the menu', async () => {
    const markup = await renderAt(
      PATH,
      <ClientMoreMenu client={FALCON} />,
      world(createEditorQueryClient(), false),
    );
    expect(markup).not.toContain('More for');
    expect(markup).not.toContain('<button');
  });
});

describe('the ⋯ menu’s actions (useClientMenuActions)', () => {
  type Actions = ReturnType<typeof useClientMenuActions>;
  let actions: Actions | null = null;

  function Probe() {
    actions = useClientMenuActions(FALCON);
    return null;
  }

  beforeEach(() => {
    actions = null;
    instagramDialogStore.getState().dismiss();
    assignDialogStore.getState().dismiss();
    renameClientDialogStore.getState().dismiss();
    deleteClientDialogStore.getState().dismiss();
  });

  const probe = async (instagram: boolean): Promise<Actions> => {
    await renderAt(PATH, <Probe />, world(createTestQueryClient(), instagram));
    if (actions === null) throw new Error('the probe did not render');
    return actions;
  };

  it('Instagram… opens the Instagram dialog for this client', async () => {
    const { instagram } = await probe(true);
    expect(instagram).toBeDefined();
    expect(instagramDialogStore.getState().clientId).toBeNull();
    instagram?.();
    expect(instagramDialogStore.getState().clientId).toBe(FALCON.clientId);
  });

  it('has no Instagram… while the switch is off', async () => {
    expect((await probe(false)).instagram).toBeUndefined();
  });

  it('Assign to…, Rename… and Delete… ask for their dialogs about this client', async () => {
    const { assign, rename, remove } = await probe(true);
    assign?.();
    rename?.();
    remove?.();
    expect(assignDialogStore.getState().client).toEqual({
      clientId: FALCON.clientId,
      name: 'Falcon FPV',
    });
    expect(renameClientDialogStore.getState().client).toEqual({
      clientId: FALCON.clientId,
      name: 'Falcon FPV',
    });
    expect(deleteClientDialogStore.getState().client).toEqual({
      clientId: FALCON.clientId,
      name: 'Falcon FPV',
      jobCount: 3,
    });
  });
});
