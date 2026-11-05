import type { MoneySubscription } from './money.ts';

// The services Studio Engine talks to: every API, paid or free, that the engine, its scripts or the
// Claude runs it starts reach over the network (CLAUDE.md › APIs and services). This list is the
// single place that says which ones there are; the Analytics page's Services section is drawn from
// it, and a test (money/services-rule.test.ts) fails when the code reaches a host that is not here.
//
// The rule it carries:
//   - every service, paid or free, is in `SERVICES` and so shows on the Analytics page;
//   - every PAID service says how its money reaches the Money page (`money`): a line in money.json's
//     subscriptions, a per-use charge worked out from what the engine recorded
//     (`deriveServiceCharges`; a job's expense, or a payment with no job), or, when it is not
//     connected yet, a `gap` that says what is missing (the Analytics page then shows it as "not
//     tracked yet").

/** What ElevenLabs charges for a minute of music, in credits (read live 23 Oct). */
export const ELEVENLABS_MUSIC_CREDITS_PER_MINUTE = 900;

/**
 * The credits of the ElevenLabs plan when its line in money.json does not say (`credits`): the
 * Starter plan's 30,000 a month. It sets what one credit is worth: the plan's price over its credits.
 */
export const ELEVENLABS_DEFAULT_PLAN_CREDITS = 30_000;

export const SERVICE_COSTS = ['paid', 'free'] as const;
export type ServiceCost = (typeof SERVICE_COSTS)[number];

/** How a paid service's money reaches the Money page. At least one of the three. */
export interface ServiceMoney {
  /** Its plan is a line of money.json's `subscriptions` (matched by `ServiceDef.subscription`). */
  subscription?: true;
  /**
   * What it costs per use is worked out from what the engine recorded (`deriveServiceCharges`):
   * a job's expense when a video caused it, a payment of the month with no job otherwise (Apify's
   * Instagram scans).
   */
  perUse?: true;
  /**
   * Not connected yet: what is missing, in one plain line. It can stand next to `perUse` for a
   * service that is connected for one use and not yet for another (Apify: scans are, Songs' runs
   * are not). The Analytics page shows it as "Not tracked in Money yet".
   */
  gap?: string;
}

export interface ServiceDef {
  /** Short and stable: names the service in code and in the Analytics answer. */
  id: string;
  name: string;
  cost: ServiceCost;
  /** What the engine uses it for, in one plain line (the Analytics page says it under the name). */
  forWhat: string;
  /**
   * The hosts the code reaches through it. A host also covers its subdomains ("unsplash.com" is
   * "api.unsplash.com" and "images.unsplash.com"). The services rule test reads the code for hosts
   * and fails on one that no service lists.
   */
  hosts: readonly string[];
  /** Lower-case fragments of a money.json subscription's id or name that make it this service's plan. */
  subscription?: readonly string[];
  /** Paid services only. */
  money?: ServiceMoney;
}

export const SERVICES = [
  {
    id: 'anthropic',
    name: 'Claude',
    cost: 'paid',
    forWhat: 'Edits, revisions, briefs, style reading and every other Claude run',
    hosts: ['anthropic.com', 'claude.ai'],
    subscription: ['claude', 'anthropic'],
    money: { subscription: true },
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    cost: 'paid',
    forWhat: 'Music for a video, the voice of a generated video, and turning voice notes into text',
    hosts: ['elevenlabs.io'],
    subscription: ['elevenlabs'],
    money: { subscription: true, perUse: true },
  },
  {
    id: 'higgsfield',
    name: 'Higgsfield',
    cost: 'paid',
    forWhat:
      'The pictures and clips of a video with no footage (Generated videos), made on the plan’s credits through the Claude connector',
    // mcp.higgsfield.ai is the connector the Claude runs reach; the plan's credits pay for it.
    hosts: ['higgsfield.ai', 'mcp.higgsfield.ai'],
    subscription: ['higgsfield'],
    money: { subscription: true, perUse: true },
  },
  {
    id: 'apify',
    name: 'Apify',
    cost: 'paid',
    forWhat:
      "Reading the song of an Instagram or TikTok link, the trending sounds, and each client's weekly Instagram scan",
    // The profile picture of a scan comes from the link Apify gives: on cdninstagram.com or fbcdn.net.
    hosts: [
      'apify.com',
      'instagram.com',
      'tiktok.com',
      'tiktokcdn.com',
      'cdninstagram.com',
      'fbcdn.net',
    ],
    subscription: ['apify'],
    // The Starter plan since 30 Oct 2026 ($19 a month, its usage prepaid and capped at that), a
    // money.json line matched by `subscription`. Each client Instagram scan records what it cost, a
    // per-use charge with no job (`deriveServiceCharges`, "Instagram scan · <client>"), `includedIn`
    // the plan from its first day on. Songs' runs are not recorded yet, so the `gap` stays for them:
    // the type holds both, and the Analytics page shows the gap next to the scans' cost.
    money: {
      perUse: true,
      gap: "Songs' runs (reading a song) cost about $0.003 to $0.008 each and are not recorded yet",
    },
  },
  {
    id: 'instagram',
    name: 'Instagram',
    cost: 'free',
    forWhat:
      'Reading what is sent to the studio account in a DM (the DMs page) and downloading its reels, photos and sounds',
    // Its API is graph.facebook.com for a Unified login key and graph.instagram.com for an
    // Instagram login key; the files of a DM come from Meta's CDNs.
    hosts: ['graph.facebook.com', 'graph.instagram.com', 'fbsbx.com', 'fbcdn.net'],
  },
  {
    id: 'openverse',
    name: 'Openverse',
    cost: 'free',
    forWhat: 'Free sound effects and photos for the stock library',
    hosts: ['openverse.org', 'freesound.org', 'creativecommons.org'],
  },
  {
    id: 'unsplash',
    name: 'Unsplash',
    cost: 'free',
    forWhat: 'Free photos for the stock library',
    hosts: ['unsplash.com'],
  },
  {
    id: 'itunes',
    name: 'Apple Music search',
    cost: 'free',
    forWhat: 'Finding a song by its name or by an Apple Music link',
    hosts: ['itunes.apple.com', 'music.apple.com'],
  },
  {
    id: 'youtube',
    name: 'YouTube',
    cost: 'free',
    forWhat: 'Finding and downloading a song with yt-dlp',
    hosts: ['youtube.com', 'youtu.be'],
  },
  {
    id: 'spotify',
    name: 'Spotify',
    cost: 'free',
    forWhat: "Reading a Spotify link's song name",
    hosts: ['spotify.com', 'spotify.link'],
  },
  {
    id: 'web-push',
    name: 'Push notifications',
    cost: 'free',
    forWhat: "Telling the phone a job is ready (Apple's, Google's and Mozilla's push services)",
    hosts: ['push.apple.com', 'googleapis.com', 'push.services.mozilla.com'],
  },
] as const satisfies readonly ServiceDef[];

export type ServiceId = (typeof SERVICES)[number]['id'];

/** A service by its id. */
export function serviceById(id: ServiceId): ServiceDef {
  const found = SERVICES.find((service) => service.id === id);
  if (found === undefined) throw new RangeError(`No service ${JSON.stringify(id)}`);
  return found;
}

/** Whether `host` is `listed` or one of its subdomains. */
export function hostIsCovered(host: string, listed: string): boolean {
  const wanted = host.toLowerCase();
  const entry = listed.toLowerCase();
  return wanted === entry || wanted.endsWith(`.${entry}`);
}

/** The service that lists `host` (or its parent domain), or `undefined`. */
export function serviceOfHost(host: string): ServiceDef | undefined {
  return SERVICES.find((service) => service.hosts.some((listed) => hostIsCovered(host, listed)));
}

/** The subscriptions of money.json that are `service`'s plan, in the order of the file. */
export function subscriptionsOfService<T extends Pick<MoneySubscription, 'id' | 'name'>>(
  service: Pick<ServiceDef, 'subscription'>,
  subscriptions: readonly T[],
): T[] {
  const fragments = service.subscription ?? [];
  if (fragments.length === 0) return [];
  return subscriptions.filter((subscription) => {
    const text = `${subscription.id} ${subscription.name}`.toLowerCase();
    return fragments.some((fragment) => text.includes(fragment));
  });
}

/** The ways a paid service is wrong: no Money connection at all, or a free service that claims one. */
export function serviceRuleProblems(services: readonly ServiceDef[] = SERVICES): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const service of services) {
    if (seen.has(service.id)) problems.push(`${service.id} is listed twice`);
    seen.add(service.id);
    if (service.cost === 'free' && service.money !== undefined) {
      problems.push(`${service.id} is free but has a money connection`);
    }
    if (service.cost === 'paid') {
      const money = service.money;
      if (money === undefined || (!money.subscription && !money.perUse && !money.gap)) {
        problems.push(
          `${service.id} is paid but says nothing about how it reaches the Money page (money: subscription, perUse or gap)`,
        );
      }
      if (money?.subscription && (service.subscription ?? []).length === 0) {
        problems.push(`${service.id} has a subscription connection but no fragments to match it`);
      }
    }
  }
  return problems;
}
