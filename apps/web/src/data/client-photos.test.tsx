import type { ClientRow, HealthResponse } from '@studio/shared';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { clientPhotoSources, NO_CLIENT_PHOTOS, photoKey } from './client-photos';
import { CLIENTS_KEY } from './clients-query';
import { HEALTH_KEY } from './health-query';
import { useClientHasInstagram, useClientPhotos } from './hooks';
import { clientPhotoSrc } from './instagram-api';
import { createTestQueryClient } from './test-utils';

// Where each client's Instagram picture is, and who has an account a reel can be linked from.

const PHOTO_AT = '2026-10-30T10:05:00.000Z';

const row = (overrides: Partial<ClientRow> = {}): ClientRow => ({
  clientId: 'a00000000001',
  client: 'Falcon FPV',
  jobs: 1,
  lastJobAt: '2026-10-20T11:02:10.000Z',
  style: { state: 'none', updatedAt: null },
  instagram: {
    handle: 'falcon.fpv',
    followers: 12_480,
    weekChange: 312,
    oursVsTheirs: 3.6,
    photoAt: PHOTO_AT,
  },
  ...overrides,
});

describe('photoKey', () => {
  it('spells a name the way the engine does: NFC, so two spellings of one folder are one client', () => {
    const composed = 'Café Noa';
    const decomposed = 'Café Noa';
    expect(composed).not.toBe(decomposed);
    expect(photoKey(decomposed)).toBe(composed);
    expect(photoKey(composed)).toBe(composed);
  });
});

describe('clientPhotoSources', () => {
  it('has the address of the picture of each client that has one, by name', () => {
    const sources = clientPhotoSources([row()]);
    expect(sources.get('Falcon FPV')).toBe(clientPhotoSrc('a00000000001', PHOTO_AT));
    expect(sources.get('Falcon FPV')).toBe(
      `/api/clients/a00000000001/photo?v=${Date.parse(PHOTO_AT)}`,
    );
  });

  it('leaves out a client with no account, an account with no picture saved yet, and a list sent without Instagram', () => {
    const sources = clientPhotoSources([
      row({ clientId: 'a00000000002', client: 'No Account', instagram: null }),
      row({
        clientId: 'a00000000003',
        client: 'Not Scanned',
        instagram: {
          handle: 'not.scanned',
          followers: null,
          weekChange: null,
          oursVsTheirs: null,
          photoAt: null,
        },
      }),
      (({ instagram: _dropped, ...rest }) => rest)(
        row({ clientId: 'a00000000004', client: 'Old List' }),
      ),
    ]);
    expect(sources.size).toBe(0);
  });

  it('finds a Hebrew name the way it is looked up', () => {
    const sources = clientPhotoSources([row({ client: 'מאפיית הצפון' })]);
    expect(sources.get(photoKey('מאפיית הצפון'))).toBeDefined();
  });

  it('is empty before the list is in', () => {
    expect(clientPhotoSources(undefined).size).toBe(0);
    expect(NO_CLIENT_PHOTOS.size).toBe(0);
  });
});

// --- the hooks ----------------------------------------------------------------------------------

const health: HealthResponse = {
  ok: true,
  version: '0.65.2',
  settleMs: 60_000,
  series: false,
  jobSheet: false,
  analytics: false,
  phone: false,
  graphics: false,
  graphicsInEdits: false,
  music: false,
  luts: false,
  lutsInEdits: false,
  fonts: false,
  fontsInNotes: false,
  quickFixes: false,
};

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

function Photos() {
  const photos = useClientPhotos();
  return <p>{JSON.stringify([...photos.entries()])}</p>;
}

function HasInstagram({ clientId, enabled }: { clientId: string; enabled?: boolean }) {
  return <p>{String(useClientHasInstagram(clientId, { enabled }))}</p>;
}

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);

describe('useClientPhotos', () => {
  it('has the pictures of the list while the switch is on', () => {
    queryClient.setQueryData(HEALTH_KEY, { ...health, instagram: true });
    queryClient.setQueryData(CLIENTS_KEY, [row()]);
    expect(render(<Photos />)).toBe(
      `<p>${JSON.stringify([['Falcon FPV', clientPhotoSrc('a00000000001', PHOTO_AT)]]).replace(/"/g, '&quot;')}</p>`,
    );
  });

  it('has none while the switch is off, though the list is cached with its pictures', () => {
    queryClient.setQueryData(HEALTH_KEY, { ...health, instagram: false });
    queryClient.setQueryData(CLIENTS_KEY, [row()]);
    expect(render(<Photos />)).toBe('<p>[]</p>');
  });

  it('has none before the health answer is in', () => {
    queryClient.setQueryData(CLIENTS_KEY, [row()]);
    expect(render(<Photos />)).toBe('<p>[]</p>');
  });

  it('has none until the list is in', () => {
    queryClient.setQueryData(HEALTH_KEY, { ...health, instagram: true });
    expect(render(<Photos />)).toBe('<p>[]</p>');
  });
});

describe('useClientHasInstagram', () => {
  const on = () => queryClient.setQueryData(HEALTH_KEY, { ...health, instagram: true });

  it('is true for a client with an account a scan can read', () => {
    on();
    queryClient.setQueryData(CLIENTS_KEY, [row()]);
    expect(render(<HasInstagram clientId="a00000000001" />)).toBe('<p>true</p>');
  });

  it('is false for a client with no account, a private one, or an id the list does not have', () => {
    on();
    queryClient.setQueryData(CLIENTS_KEY, [
      row({ clientId: 'a00000000002', instagram: null }),
      row({
        clientId: 'a00000000003',
        instagram: {
          handle: 'quiet.studio',
          followers: null,
          weekChange: null,
          oursVsTheirs: null,
          photoAt: null,
          private: true,
        },
      }),
    ]);
    expect(render(<HasInstagram clientId="a00000000002" />)).toBe('<p>false</p>');
    expect(render(<HasInstagram clientId="a00000000003" />)).toBe('<p>false</p>');
    expect(render(<HasInstagram clientId="zzzzzzzzzzzz" />)).toBe('<p>false</p>');
  });

  it('is false while the switch is off, and until the list is in', () => {
    queryClient.setQueryData(CLIENTS_KEY, [row()]);
    expect(render(<HasInstagram clientId="a00000000001" />)).toBe('<p>false</p>');
    on();
    queryClient.removeQueries({ queryKey: CLIENTS_KEY });
    expect(render(<HasInstagram clientId="a00000000001" />)).toBe('<p>false</p>');
  });
});
