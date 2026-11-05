import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ME_KEY } from '@/data/me-query';
import { createEditorQueryClient, createTestQueryClient } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import { APP_VERSION } from '@/lib/version';
import { PhoneSettingsPage } from './PhoneSettingsPage';

const render = () => renderAt('/settings', <PhoneSettingsPage address="mac.tail1234.ts.net" />);

/** Visible text: tags removed, the entities React emits decoded. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&#x27;', "'")
    .replace(/\s+/g, ' ')
    .trim();

describe('<PhoneSettingsPage>', () => {
  it('has the title and a back link to the jobs list, at least 44 px tall', async () => {
    const html = await render();
    expect(html).toMatch(/<h1[^>]*>Settings<\/h1>/);
    const back = html.match(/<a\b[^>]*href="\/jobs"[^>]*>/)?.[0] ?? '';
    expect(back).toContain('h-11');
    // 4 px inside on the left: the button's own padding for an icon (px-3) would win over pl-1
    // unless the same variant carries it (found in PH20's QA).
    expect(back).toContain('has-[&gt;svg]:pl-1');
    expect(back).toContain('has-[&gt;svg]:pr-2.5');
    expect(html.indexOf('href="/jobs"')).toBeLessThan(html.indexOf('>Settings<'));
    expect(text(html)).toContain('Jobs');
  });

  it('says it is connected to the Mac over Tailscale, with the green dot and the address', async () => {
    const html = await render();
    expect(text(html)).toContain('This phone');
    expect(text(html)).toContain('Connected to your Mac');
    expect(text(html)).toContain('Over Tailscale, only your devices');
    expect(html).toMatch(/<span[^>]*aria-label="Connected"[^>]*bg-emerald-400/);
    expect(text(html)).toContain('Address mac.tail1234.ts.net');
  });

  it('has About with a What’s new row (a button) and the version', async () => {
    const html = await render();
    expect(text(html)).toContain('About');
    const row = html.match(/<button\b[^>]*>(?:(?!<\/button>).)*What’s new/s)?.[0] ?? '';
    expect(row).toContain('type="button"');
    expect(row).toContain('min-h-12');
    expect(text(html)).toContain(`Version ${APP_VERSION}`);
  });

  it('orders the sections: notifications slot, This phone, About', async () => {
    const html = await render();
    const order = ['data-slot="phone-settings-notifications"', '>This phone<', '>About<'].map(
      (needle) => html.indexOf(needle),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(-1);
  });

  it('leaves the notifications slot empty outside the Home Screen app, so it takes no room', async () => {
    const html = await render();
    expect(html).toMatch(
      /<div[^>]*data-slot="phone-settings-notifications"[^>]*empty:hidden[^>]*><\/div>/,
    );
  });

  it('has no sideways overflow: long addresses wrap', async () => {
    expect(await render()).toContain('[overflow-wrap:anywhere]');
  });
});

describe('<PhoneSettingsPage>: who is signed in', () => {
  const renderFor = (client: QueryClient) =>
    renderAt('/settings', <PhoneSettingsPage address="mac.tail1234.ts.net" />, client);

  it('says "Signed in as Yael · Editor" in This phone for an editor', async () => {
    const html = await renderFor(createEditorQueryClient());
    expect(text(html)).toContain('Signed in as Yael · Editor');
    expect(html.indexOf('phone-settings-signed-in')).toBeGreaterThan(html.indexOf('>This phone<'));
    expect(html.indexOf('phone-settings-signed-in')).toBeLessThan(
      html.indexOf('Connected to your Mac'),
    );
  });

  it('says it for the admin too', async () => {
    expect(text(await renderFor(createTestQueryClient()))).toContain(
      'Signed in as The owner · Admin',
    );
  });

  it('says nothing until the engine has said who is asking', async () => {
    const client = createTestQueryClient();
    client.removeQueries({ queryKey: ME_KEY });
    expect(text(await renderFor(client))).not.toContain('Signed in as');
  });
});
