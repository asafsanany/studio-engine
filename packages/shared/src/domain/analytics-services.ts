import { homeCurrencySymbol } from '../home-currency.ts';
import type {
  AnalyticsPeriod,
  AnalyticsServicePlan,
  AnalyticsServiceRow,
  AnalyticsServices,
} from './analytics.ts';
import { addDays, localDayOf, windowDaysOf } from './analytics-time.ts';
import type { MoneyCurrency, MoneyFile, MoneyServiceCharge, MoneySubscription } from './money.ts';
import { subscriptionCharges, toIls } from './money.ts';
import { SERVICES, type ServiceDef, subscriptionsOfService } from './services.ts';
import type { UsageEntry } from './usage.ts';

// The Services section of the Analytics page (CLAUDE.md › APIs and services): every API the engine
// talks to, paid or free, from the registry (services.ts), with the plan the owner pays for it in
// money.json, what it cost in the period and what it was used for. A paid service that is not
// connected to the Money page yet says so (`gap`), and a paid service whose plan is not in
// money.json says that (`planMissing`).

export interface ComputeAnalyticsServicesInput {
  now: number;
  period: AnalyticsPeriod;
  timeZone: string;
  money: Pick<MoneyFile, 'usdToIls' | 'subscriptions'>;
  /** What the services cost the jobs (service-charges.ts). */
  serviceCharges: readonly MoneyServiceCharge[];
  /** The usage log: Claude's runs and the voice notes are counted from it. */
  usage: readonly UsageEntry[];
}

const SYMBOLS: Record<MoneyCurrency, string> = {
  get ILS() {
    return homeCurrencySymbol();
  },
  USD: '$',
};

const priceFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function planOf(subscription: MoneySubscription): AnalyticsServicePlan {
  const every = subscription.every === 'year' ? 'a year' : 'a month';
  return {
    name: subscription.name,
    price: `${SYMBOLS[subscription.currency]}${priceFormat.format(subscription.amount)} ${every}`,
  };
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

const dollars = (usd: number): string => `$${priceFormat.format(usd)}`;

export function computeAnalyticsServices(input: ComputeAnalyticsServicesInput): AnalyticsServices {
  const { now, period, timeZone, money, serviceCharges, usage } = input;
  const today = localDayOf(now, timeZone);
  const from = addDays(today, -(windowDaysOf(period) - 1));
  const inWindow = (day: string): boolean => day >= from && day <= today;
  const dayOfIso = (iso: string): string => localDayOf(Date.parse(iso), timeZone);

  const renewals = subscriptionCharges(money, from, today);
  const renewalsOf = (subscriptions: readonly MoneySubscription[]): number =>
    renewals
      .filter((line) => subscriptions.some((s) => s.id === line.subscriptionId))
      .reduce((total, line) => total + line.ils, 0);

  const chargesIn = serviceCharges.filter((charge) => inWindow(charge.date));
  const chargesOf = (service: ServiceDef) =>
    chargesIn.filter((charge) => charge.item.toLowerCase() === service.name.toLowerCase());
  const usageIn = usage.filter((entry) => inWindow(dayOfIso(entry.at)));

  const usesOf = (service: ServiceDef): string | null => {
    switch (service.id) {
      case 'anthropic': {
        const runs = usageIn.filter(
          (entry) => entry.source === 'app' && Object.keys(entry.usage).length > 0,
        ).length;
        return runs > 0 ? plural(runs, 'run') : null;
      }
      case 'elevenlabs': {
        const credits = chargesOf(service).reduce((total, c) => total + (c.credits ?? 0), 0);
        const notes = usageIn.filter((entry) => entry.tag === 'transcribe').length;
        const parts = [
          credits > 0 ? `${credits.toLocaleString('en-US')} credits on videos` : null,
          notes > 0 ? plural(notes, 'voice note') : null,
        ].filter((part): part is string => part !== null);
        return parts.length > 0 ? parts.join(' · ') : null;
      }
      case 'higgsfield': {
        const charges = chargesOf(service);
        if (charges.length === 0) return null;
        const videos = new Set(charges.map((charge) => charge.job)).size;
        const usd = charges
          .filter((charge) => charge.currency === 'USD')
          .reduce((total, charge) => total + charge.amount, 0);
        return `${plural(videos, 'video')} · ${dollars(usd)} of shots`;
      }
      default:
        return null;
    }
  };

  const rows = SERVICES.map((service): AnalyticsServiceRow => {
    const def: ServiceDef = service;
    const plans = subscriptionsOfService(def, money.subscriptions);
    const paid = def.cost === 'paid';
    const used = chargesOf(def)
      .filter((charge) => charge.includedIn === undefined)
      .reduce((total, charge) => total + toIls(charge.amount, charge.currency, money), 0);
    return {
      id: def.id,
      name: def.name,
      forWhat: def.forWhat,
      cost: def.cost,
      plans: plans.map(planOf),
      planMissing: paid && def.money?.subscription === true && plans.length === 0,
      ils: paid ? Math.round((renewalsOf(plans) + used) * 100) / 100 : null,
      uses: usesOf(def),
      gap: paid ? (def.money?.gap ?? null) : null,
    };
  });
  // Paid first, then the free ones; each keeps the registry's order.
  const ordered = [
    ...rows.filter((r) => r.cost === 'paid'),
    ...rows.filter((r) => r.cost === 'free'),
  ];

  const taken = new Set(
    SERVICES.flatMap((service) =>
      subscriptionsOfService(service as ServiceDef, money.subscriptions).map((s) => s.id),
    ),
  );
  const otherPlans = money.subscriptions
    .filter((subscription) => !taken.has(subscription.id))
    .map((subscription) => ({
      ...planOf(subscription),
      ils: Math.round(renewalsOf([subscription]) * 100) / 100,
    }));

  const totalIls =
    Math.round(
      (ordered.reduce((total, row) => total + (row.ils ?? 0), 0) +
        otherPlans.reduce((total, plan) => total + plan.ils, 0)) *
        100,
    ) / 100;
  return { rows: ordered, otherPlans, totalIls };
}
