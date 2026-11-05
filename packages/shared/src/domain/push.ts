import { z } from 'zod';
import { isoTimestampSchema } from './job.ts';

// Web push to the phone (Mobile plan §6, PH11): a device is one Home Screen app that turned
// notifications on; the engine pushes to it when a job needs the owner. The phone side (PH12) reads
// these types and calls the routes of `PUSH_ROUTES`.

/**
 * The events a device can switch on and off, in the order of the Settings section (board
 * MSettings): `review` Ready to review, `failed` Failed (a Claude usage limit too), `approved`
 * Approved · ready to send (the render after Approve is done), `queueEmpty` Queue is empty, and
 * `badge`, which is not an event: it puts the count of Review + Needs attention on the app icon.
 */
export const PUSH_EVENT_KEYS = ['review', 'failed', 'approved', 'queueEmpty', 'badge'] as const;
export type PushEventKey = (typeof PUSH_EVENT_KEYS)[number];

/** The pushes that tell about a change of a job or the queue: every key but `badge`. */
export const PUSH_NOTIFY_KEYS = ['review', 'failed', 'approved', 'queueEmpty'] as const;
export type PushNotifyKey = (typeof PUSH_NOTIFY_KEYS)[number];

/** One switch per key. All five are always present. */
export const pushEventsSchema = z.strictObject({
  review: z.boolean(),
  failed: z.boolean(),
  approved: z.boolean(),
  queueEmpty: z.boolean(),
  badge: z.boolean(),
});
export type PushEvents = z.infer<typeof pushEventsSchema>;

/** What a device starts with: everything on but Queue is empty. */
export const DEFAULT_PUSH_EVENTS: Readonly<PushEvents> = Object.freeze({
  review: true,
  failed: true,
  approved: true,
  queueEmpty: false,
  badge: true,
});

/** Some of the switches; the ones left out stay as they are. */
export const pushEventsPatchSchema = pushEventsSchema.partial();
export type PushEventsPatch = z.infer<typeof pushEventsPatchSchema>;

/**
 * A device as the routes send it. The subscription's endpoint and keys are secrets of the push
 * service and never come back.
 */
export const pushDeviceSchema = z.object({
  id: z.string().min(1),
  /** A short name from the user agent that registered it: "iPhone", "Mac · Chrome". */
  label: z.string().min(1),
  events: pushEventsSchema,
  createdAt: isoTimestampSchema,
  /** When a push to it last went through; `null` before the first. */
  lastOkAt: isoTimestampSchema.nullable(),
});
export type PushDevice = z.infer<typeof pushDeviceSchema>;

/** `GET /api/push/key`: the VAPID public key, base64url, for `pushManager.subscribe`. */
export const pushKeyResponseSchema = z.object({ publicKey: z.string().min(1) });
export type PushKeyResponse = z.infer<typeof pushKeyResponseSchema>;

/** A base64url string (padding allowed) whose decoded size `fits`. */
function base64Url(name: string, fits: (decodedBytes: number) => boolean) {
  return z
    .string()
    .regex(/^[A-Za-z0-9_-]+={0,2}$/, `${name} is not base64url.`)
    .refine((value) => fits(Math.floor((value.replace(/=+$/, '').length * 3) / 4)), {
      message: `${name} is the wrong length.`,
    });
}

/**
 * The body of `POST /api/push/devices`: the browser's `PushSubscription.toJSON()`. Other fields it
 * carries (`expirationTime`) are ignored.
 */
export const pushSubscriptionSchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }),
  keys: z.object({
    // An uncompressed P-256 point and a secret of at least 16 bytes, as web-push needs them.
    p256dh: base64Url('p256dh', (bytes) => bytes === 65),
    auth: base64Url('auth', (bytes) => bytes >= 16),
  }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

/** The body of `PUT /api/push/devices/:id`: the switches to change. At least one. */
export const pushDeviceUpdateSchema = z.object({
  events: pushEventsPatchSchema.refine((events) => Object.keys(events).length > 0, {
    message: 'Send at least one event.',
  }),
});
export type PushDeviceUpdate = z.infer<typeof pushDeviceUpdateSchema>;

/**
 * What a push carries, as JSON in the push message. `body` is "<job> · <client>" (a job's name,
 * its client and the event, nothing else), `url` is where a tap opens (a path of this app) and
 * `tag` is the job's id, so a newer notification about a job replaces the older one. `badge` is
 * the count of Review + Needs attention for the app icon, only for a device with Count on the app
 * icon on.
 */
export const pushPayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  url: z.string().startsWith('/'),
  tag: z.string().min(1),
  badge: z.number().int().nonnegative().optional(),
});
export type PushPayload = z.infer<typeof pushPayloadSchema>;

/** How long a push service keeps a message for a phone that is off: one hour. */
export const PUSH_TTL_SEC = 60 * 60;

/** The routes the phone calls, under `/api/push`. `:id` is a device's id. */
export const PUSH_ROUTES = {
  key: '/api/push/key',
  devices: '/api/push/devices',
  device: (id: string): string => `/api/push/devices/${encodeURIComponent(id)}`,
  test: (id: string): string => `/api/push/devices/${encodeURIComponent(id)}/test`,
} as const;

/** The title of the test push (`POST /api/push/devices/:id/test`). */
export const PUSH_TEST_TITLE = 'Test from Studio Engine';

/**
 * Where a tap on a notification goes. The review address opens the job's Review full screen
 * (the sheet where the phone has no Review yet); the sheet address opens the job's sheet; `jobs`
 * is the list.
 */
export const PUSH_URLS = {
  review: (jobId: string): string => `/jobs?job=${encodeURIComponent(jobId)}&review=1`,
  sheet: (jobId: string): string => `/jobs?job=${encodeURIComponent(jobId)}`,
  jobs: '/jobs',
} as const;
