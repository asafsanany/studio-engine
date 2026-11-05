import { computeAnalyticsServices, moneyFileSchema, SERVICES } from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeAnalyticsResponse } from '@/data/test-utils';
import { AnalyticsBody } from './AnalyticsBody';
import { ServicesCard } from './ServicesCard';

const money = moneyFileSchema.parse({
  subscriptions: [
    {
      id: 'elevenlabs',
      name: 'ElevenLabs (Starter)',
      amount: 6,
      currency: 'USD',
      every: 'month',
      day: 20,
      since: '2026-10-01',
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      amount: 69.9,
      currency: 'ILS',
      every: 'month',
      day: 1,
      since: '2026-10-01',
    },
  ],
});

const services = computeAnalyticsServices({
  now: Date.parse('2026-10-22T09:00:00+03:00'),
  period: 'month',
  timeZone: 'Asia/Jerusalem',
  money,
  serviceCharges: [
    {
      date: '2026-10-21',
      item: 'Higgsfield',
      what: 'Pictures and clips',
      amount: 3,
      currency: 'USD',
      job: 'Pinewood/97 Window Ad',
    },
  ],
  usage: [],
});

describe('<ServicesCard>', () => {
  const markup = renderToStaticMarkup(<ServicesCard services={services} period="month" />);

  it("says Apify is also for each client's weekly Instagram scan", () => {
    expect(markup).toContain('and each client&#x27;s weekly Instagram scan');
  });

  it('lists every service of the registry, paid or free', () => {
    for (const service of SERVICES) {
      expect(markup).toContain(`data-service="${service.id}"`);
      expect(markup).toContain(service.name);
    }
  });

  it('shows Higgsfield and ElevenLabs with their use, plan and cost', () => {
    expect(markup).toContain('ElevenLabs (Starter) · $6.00 a month');
    expect(markup).toContain('1 video · $3.00 of shots');
    expect(markup).toContain('No plan in money.json yet');
  });

  it('marks the free ones Free and says what a paid one is not connected to Money', () => {
    expect(markup).toContain('>Free<');
    expect(markup).toContain('Not tracked in Money yet: Songs&#x27; runs (reading a song) cost');
  });

  it("lists the subscriptions that are no service's plan and the total", () => {
    expect(markup).toContain('ChatGPT · ₪69.90 a month');
    expect(markup).toContain('Paid in the period: ₪');
  });

  it('says the period in the subtitle', () => {
    const week = renderToStaticMarkup(<ServicesCard services={services} period="week" />);
    expect(markup).toContain('Last 30 days');
    expect(week).toContain('Last 7 days');
  });
});

describe('the Services section of the page', () => {
  it('shows when the answer has services and not when it has none', () => {
    const withServices = renderToStaticMarkup(
      <AnalyticsBody data={makeAnalyticsResponse({ services })} skeleton={false} />,
    );
    const without = renderToStaticMarkup(
      <AnalyticsBody data={makeAnalyticsResponse()} skeleton={false} />,
    );
    expect(withServices).toContain('APIs and subscriptions');
    expect(without).not.toContain('APIs and subscriptions');
  });
});
