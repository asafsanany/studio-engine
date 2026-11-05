import { DEFAULT_PUSH_EVENTS } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createTestQueryClient } from '@/data/test-utils';
import { NotifyCard, NotifyCardView, NotifyDeniedCardView } from './NotifyCard';
import { DENIED_TEXT, notificationsSection, TURN_ON_TEXT } from './notifications-view';
import { NOTIFY_CARD_BODY, NOTIFY_DENIED_BODY } from './notify-card';
import { NotificationsSectionView, PhoneNotificationsSection } from './PhoneNotificationsSection';

/** Visible text: tags removed, the entities React emits decoded. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&#x27;', "'")
    .replace(/\s+/g, ' ')
    .trim();

const noop = () => undefined;

describe('<NotifyCardView> (board MTurnOn)', () => {
  it('has the title, what it brings and two 44 px buttons, Not now and Turn on', () => {
    const html = renderToStaticMarkup(<NotifyCardView onDismiss={noop} onTurnOn={noop} />);
    expect(html).toContain('data-slot="notify-card"');
    expect(html).toMatch(/<h2[^>]*>Turn on notifications<\/h2>/);
    expect(text(html)).toContain(NOTIFY_CARD_BODY);
    const buttons = [...html.matchAll(/<button\b[^>]*>(?:(?!<\/button>).)*<\/button>/gs)].map(
      ([button]) => button,
    );
    expect(buttons.map(text)).toEqual(['Not now', 'Turn on']);
    for (const button of buttons) expect(button).toContain('h-11');
    expect(html).not.toContain('role="alert"');
  });

  it('reads “Turning on…” and holds still while it works, and shows a failure', () => {
    const html = renderToStaticMarkup(
      <NotifyCardView
        working
        error="Couldn’t turn notifications on. No."
        onDismiss={noop}
        onTurnOn={noop}
      />,
    );
    expect(text(html)).toContain('Turning on…');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Turning on…/s);
    expect(html).toMatch(/role="alert"[^>]*>Couldn’t turn notifications on. No.</);
  });

  it('after a refusal, says how to allow notifications in iOS Settings, with one Got it', () => {
    const html = renderToStaticMarkup(<NotifyDeniedCardView onDismiss={noop} />);
    expect(text(html)).toContain('Notifications are off');
    expect(text(html)).toContain(NOTIFY_DENIED_BODY);
    expect([...html.matchAll(/<button\b/g)]).toHaveLength(1);
    expect(text(html)).toContain('Got it');
  });

  it('is not drawn outside the Home Screen app', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={createTestQueryClient()}>
        <NotifyCard />
      </QueryClientProvider>,
    );
    expect(html).toBe('');
  });
});

describe('<NotificationsSectionView> (board MSettings)', () => {
  const on = notificationsSection({
    support: 'supported',
    permission: 'granted',
    deviceId: 'd1',
    device: {
      id: 'd1',
      label: 'iPhone',
      events: { ...DEFAULT_PUSH_EVENTS },
      createdAt: '2026-10-22T10:00:00.000Z',
      lastOkAt: null,
    },
  });
  const render = (section = on) =>
    renderToStaticMarkup(
      <NotificationsSectionView section={section} onTurnOn={noop} onFlip={noop} onTest={noop} />,
    );

  it('is titled “Notifications on this phone”, with On beside it', () => {
    const html = render();
    expect(html).toMatch(/<h2[^>]*>Notifications on this phone<\/h2>/);
    expect(text(html)).toMatch(/Notifications on this phone On/);
    expect(html).toContain('bg-emerald-400');
  });

  it('has a switch per event, with its subtitle, set as the engine has it, as rows of 56 px', () => {
    const html = render();
    const switches = [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map(([s]) => s);
    expect(switches).toHaveLength(5);
    expect(switches.map((s) => s.match(/aria-checked="(\w+)"/)?.[1])).toEqual([
      'true',
      'true',
      'true',
      'false',
      'true',
    ]);
    expect(text(html)).toContain('Failed A job stopped with an error, a Claude usage limit too');
    expect(text(html)).toContain('Count on the app icon Jobs in Review or needing attention');
    expect([...html.matchAll(/<label[^>]*min-h-14/g)]).toHaveLength(5);
  });

  it('ends with “Send a test”, a full-width 44 px button', () => {
    const html = render();
    const test = html.match(/<button\b[^>]*>(?:(?!<\/button>).)*Send a test/s)?.[0] ?? '';
    expect(test).toContain('h-11');
    expect(test).toContain('w-full');
  });

  it('offers Turn on, with Off, before notifications are on', () => {
    const html = render(
      notificationsSection({
        support: 'supported',
        permission: 'default',
        deviceId: null,
        device: undefined,
      }),
    );
    expect(text(html)).toMatch(/Notifications on this phone Off/);
    expect(text(html)).toContain(TURN_ON_TEXT);
    expect(text(html)).toContain('Turn on');
    expect(html).not.toContain('role="switch"');
  });

  it('says how to allow notifications after a refusal, with no button', () => {
    const html = render(
      notificationsSection({
        support: 'supported',
        permission: 'denied',
        deviceId: null,
        device: undefined,
      }),
    );
    expect(text(html)).toContain(DENIED_TEXT);
    expect(html).not.toContain('<button');
  });

  it('draws nothing in a browser tab: the slot stays empty (board MSettingsBasic)', () => {
    expect(render({ kind: 'hidden' })).toBe('');
    const html = renderToStaticMarkup(
      <QueryClientProvider client={createTestQueryClient()}>
        <PhoneNotificationsSection />
      </QueryClientProvider>,
    );
    expect(html).toBe('');
  });
});
