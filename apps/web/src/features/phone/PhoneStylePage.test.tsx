import { type ClientStyleResponse, noClientStyle } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/data/api';
import { clientStyleKey } from '@/data/client-style';
import { CLIENTS_KEY } from '@/data/clients-query';
import { createTestQueryClient } from '@/data/test-utils';
import { makeClientRow } from '@/features/clients/test-clients';
import { renderAt } from '@/lib/test-router';
import { PhoneStylePage, PhoneStyleView } from './PhoneStylePage';

const MARKDOWN = `# Style: RGM
Learned from טורניר בחירות שש בש (21 Oct 2026).
## Look
- Colours: green #16A34A (accent)
- Fonts: Heebo 800 for titles
## Editing
- Format: 1080×1920, about 30 s
`;

function style(overrides: Partial<ClientStyleResponse> = {}): ClientStyleResponse {
  return {
    ...noClientStyle('rgm', 'RGM'),
    state: 'ready',
    version: 3,
    updatedAt: '2026-10-22T10:30:00.000Z',
    markdown: MARKDOWN,
    ...overrides,
  };
}

function page(cached?: ClientStyleResponse) {
  const client = createTestQueryClient();
  client.setQueryData(CLIENTS_KEY, [makeClientRow({ clientId: 'rgm', client: 'RGM' })]);
  if (cached !== undefined) client.setQueryData(clientStyleKey('rgm'), cached);
  return renderAt('/clients/rgm/style', <PhoneStylePage clientId="rgm" />, client);
}

describe('<PhoneStylePage>', () => {
  it('has the back link with the client’s name, 44 px, to the client’s page', async () => {
    const html = await page(style());
    expect(html).toContain('data-slot="phone-style-page"');
    const link = html.match(/<a [^>]*href="\/clients\/rgm"[^>]*>/)?.[0] ?? '';
    expect(link).toContain('h-11');
    expect(link).toContain('has-[&gt;svg]:pl-1');
    expect(link).toContain('has-[&gt;svg]:pr-2.5');
    expect(html).toMatch(/lucide-chevron-left[^>]*>[\s\S]*?<\/svg>(?:<[^>]+>)*RGM/);
  });

  it('says "style.md · updated …" at the right of the back link', async () => {
    const html = await page(style());
    expect(html).toMatch(/style\.md[^<]*·\s*updated/);
  });

  it('renders the style.md as the Mac does: a title, sections and bullets', async () => {
    const html = await page(style());
    expect(html).toContain('data-slot="style-document"');
    expect(html).toMatch(/<h1[^>]*>Style: RGM<\/h1>/);
    expect(html).toMatch(/<h2[^>]*>Look<\/h2>/);
    expect(html).toContain('Colours: green #16A34A (accent)');
    expect(html).toContain('dir="auto"');
  });

  it('is read only: no Add style files button, no drop zone, no file input', async () => {
    const html = await page(style());
    expect(html).not.toContain('Add style files');
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain('Drop');
    expect(html).not.toContain('data-slot="style-drop-zone"');
  });

  it('says there is no style yet when style.md is missing, and where it is made', async () => {
    const html = await page(style({ state: 'none', markdown: null, updatedAt: null }));
    expect(html).toContain('No style yet.');
    expect(html).toContain('on your Mac');
    expect(html).not.toContain('type="file"');
    expect(html).not.toMatch(/style\.md[^<]*·\s*updated/);
  });

  it('keeps the line that says a run is going on, without a Retry button when it failed', async () => {
    const busy = await page(
      style({
        state: 'analysing',
        pass: { kind: 'learn', job: 'ראיון', fileCount: 0 } as ClientStyleResponse['pass'],
      }),
    );
    expect(busy).toContain('data-status="busy"');
    expect(busy).toContain('Learning the style from');

    const failed = await page(style({ state: 'failed', error: 'Out of tokens.' }));
    expect(failed).toContain('data-status="error"');
    expect(failed).toContain('Out of tokens.');
    expect(failed).not.toContain('Retry');
  });

  it('shows the back link by the client list’s name until the style has loaded, then nothing else', async () => {
    const html = await page();
    expect(html).toMatch(/lucide-chevron-left[^>]*>[\s\S]*?<\/svg>(?:<[^>]+>)*RGM/);
    expect(html).not.toContain('style-document');
  });

  it('says "No such client." for a client the engine does not know', async () => {
    const client = createTestQueryClient();
    client.setQueryDefaults(clientStyleKey('gone'), { retryOnMount: false });
    client
      .getQueryCache()
      .build(client, { queryKey: clientStyleKey('gone') })
      .setState({
        status: 'error',
        fetchStatus: 'idle',
        error: new ApiError(404, 'Client gone not found'),
        data: undefined,
      });
    const html = await renderAt('/clients/gone/style', <PhoneStylePage clientId="gone" />, client);
    expect(html).toContain('No such client.');
    expect(html).not.toContain('style-document');
  });
});

describe('<PhoneStyleView>', () => {
  it('shows the document in a column the width of the phone, 16 px from the sides', async () => {
    const html = await renderAt('/clients/rgm/style', <PhoneStyleView style={style()} />);
    expect(html).toContain('px-4');
    expect(html).not.toContain('max-w-[680px]');
    expect(html).toContain('data-slot="style-document"');
  });
});
