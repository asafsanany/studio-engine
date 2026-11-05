// The DMs inbox: every minute it reads the studio account's DMs (graph.ts) and keeps the reels in
// its conversations with the senders (@owner_account), both ways: what a sender sent the studio and
// what the studio sent them. Each reel's file is downloaded. What it keeps is in
// <dataDir>/instagram-dms/: state.json (the items and what was read), files/ (the downloads) and
// key.json (key.ts). It does nothing while .env has no key, and reads .env again on every check,
// so a key added there works within a minute, with no restart.
//
// Instagram lets the API read only the 20 newest messages of a conversation, so the inbox reads
// often and keeps everything it has seen; a conversation is read again only when it has a new
// message (`updated_time`), and one without a sender in it is not read at all. Meta allows an app
// in development about 200 calls an hour, so when it asks to slow down the inbox waits 15 minutes.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DmItem, DmsResponse } from '@studio/shared';
import { envFilePath } from '../config.js';
import { downloadDmFile } from './download.js';
import {
  type FetchLike,
  GraphClient,
  GraphError,
  type GraphMessage,
  readDmSenders,
} from './graph.js';
import { DmKeyStore } from './key.js';
import { itemsOfMessage } from './parse.js';

/** How often the DMs are read. */
export const DM_CHECK_EVERY_MS = 60_000;

/** The wait after Instagram asks to slow down (its limit counts the calls of the last hour). */
export const DM_SLOW_DOWN_MS = 15 * 60_000;

/**
 * What the inbox keeps, as a number: a state kept under other rules is read again from the start
 * (2: only reels, both ways; 1 kept everything the senders sent).
 */
const DM_RULES = 2;

/** The wait before the first check after the engine starts. */
const FIRST_CHECK_MS = 5_000;

/** How many times a file that failed to download is tried (each with a fresh link). */
const FILE_TRIES = 3;

/** The most message ids remembered as read. */
const SEEN_LIMIT = 5000;

export interface DmLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

const SILENT: DmLogger = { info() {}, warn() {} };

/** An item with what the inbox needs to try its file again. */
interface StoredItem extends DmItem {
  mediaUrl: string | null;
  tries: number;
}

interface DmState {
  rules: number;
  account: { id: string; username: string } | null;
  /** Each conversation's `updated_time` when it was last read through. */
  conversations: Record<string, string | null>;
  /** Message ids already handled, whoever sent them. */
  seen: string[];
  items: StoredItem[];
  checkedAt: string | null;
  error: string | null;
}

const EMPTY_STATE = (): DmState => ({
  rules: DM_RULES,
  account: null,
  conversations: {},
  seen: [],
  items: [],
  checkedAt: null,
  error: null,
});

export interface DmInboxOptions {
  /** The engine's data folder; the inbox keeps its files in `<dataDir>/instagram-dms`. */
  dataDir: string;
  /** The usernames whose DMs are kept (`instagramDmFrom` in config.json). */
  from?: readonly string[];
  env?: Record<string, string | undefined>;
  /** The .env file the key is read from. Default: the repo's (or STUDIO_ENV_FILE). */
  envFile?: string;
  /** Injected in tests: Instagram and its file server. */
  fetch?: FetchLike;
  now?: () => number;
  logger?: DmLogger;
  everyMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Instagram's `2026-10-30T12:00:00+0000` as an ISO timestamp; `null` when it is not a time. */
function isoOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function senderOf(message: GraphMessage): string | null {
  const from = message.from;
  return isRecord(from) && typeof from.username === 'string' ? from.username : null;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class DmInbox {
  private readonly from: readonly string[];
  readonly dir: string;
  readonly filesDir: string;
  private readonly statePath: string;
  private readonly env: Record<string, string | undefined>;
  private readonly envFile: string;
  private readonly keys: DmKeyStore;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly logger: DmLogger;
  private readonly everyMs: number;
  private state: DmState;
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Whether the last check was told to slow down; the next one waits {@link DM_SLOW_DOWN_MS}. */
  private slowDown = false;

  constructor(options: DmInboxOptions) {
    this.from = options.from ?? [];
    this.dir = join(options.dataDir, 'instagram-dms');
    this.filesDir = join(this.dir, 'files');
    this.statePath = join(this.dir, 'state.json');
    this.env = options.env ?? process.env;
    this.envFile = options.envFile ?? envFilePath(this.env);
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? SILENT;
    this.everyMs = options.everyMs ?? DM_CHECK_EVERY_MS;
    this.keys = new DmKeyStore({
      path: join(this.dir, 'key.json'),
      env: this.env,
      envFile: this.envFile,
      now: this.now,
      logger: this.logger,
    });
    this.state = this.load();
  }

  /** The connection and every item, newest first. */
  read(): DmsResponse {
    const hasKey = this.keys.hasKey();
    return {
      connection: {
        state: !hasKey ? 'off' : this.state.error !== null ? 'failing' : 'connected',
        account: hasKey ? (this.state.account?.username ?? null) : null,
        from: readDmSenders(this.env, this.envFile, this.from),
        checkedAt: hasKey ? this.state.checkedAt : null,
        error: hasKey ? this.state.error : null,
        everySecs: Math.round(this.everyMs / 1000),
      },
      items: this.state.items
        .map(({ mediaUrl: _url, tries: _tries, ...item }) => item)
        .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)),
    };
  }

  /** The item `id`, or `undefined`. */
  item(id: string): DmItem | undefined {
    return this.read().items.find((item) => item.id === id);
  }

  /** Reads the DMs now. A check that is already running is waited for instead of a second one. */
  async check(): Promise<DmsResponse> {
    this.running ??= this.runCheck().finally(() => {
      this.running = null;
    });
    await this.running;
    return this.read();
  }

  /**
   * Reads the DMs a few seconds from now and then every minute (every 15 after Instagram asks to
   * slow down), until `stop()`.
   */
  start(): void {
    if (this.timer !== null || this.stopped) return;
    const tick = (): void => {
      void this.check().finally(() => {
        if (this.stopped) return;
        this.timer = setTimeout(tick, this.slowDown ? DM_SLOW_DOWN_MS : this.everyMs);
        this.timer.unref();
      });
    };
    this.timer = setTimeout(tick, FIRST_CHECK_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  private async runCheck(): Promise<void> {
    const key = this.keys.current();
    if (key === null) return; // no key in .env: nothing to read
    if (key.fresh) this.state.account = null; // a new key may be another account's
    const client = new GraphClient({ token: key.token, fetch: this.fetchImpl });
    const senders = readDmSenders(this.env, this.envFile, this.from);
    try {
      const account = this.state.account ?? (await client.me());
      if (this.state.account === null) {
        this.state.account = account;
        this.logger.info(
          { account: account.username },
          'reading the Instagram DMs of this account',
        );
      }
      await this.keys.refreshIfDue(client);
      for (const conversation of await client.conversations(account.id)) {
        if (this.stopped) return;
        const { participants } = conversation;
        const withSender =
          participants === null ? null : participants.some((name) => senders.includes(name));
        if (withSender === false) continue; // a client's conversation: never read
        const last = this.state.conversations[conversation.id];
        if (conversation.updatedTime !== null && last === conversation.updatedTime) continue;
        await this.readConversation(client, conversation.id, senders, account.username, withSender);
        this.state.conversations[conversation.id] = conversation.updatedTime;
        this.save();
      }
      await this.retryFiles(client);
      this.state.error = null;
      this.slowDown = false;
    } catch (err) {
      this.slowDown = err instanceof GraphError && err.code === 'rate-limit';
      this.state.error = this.slowDown
        ? `${errorText(err)}. The next check is in ${DM_SLOW_DOWN_MS / 60_000} min.`
        : errorText(err);
      this.logger.warn({ err: this.state.error }, 'could not read the Instagram DMs');
    } finally {
      this.state.checkedAt = new Date(this.now()).toISOString();
      this.save();
    }
  }

  /**
   * The new messages of one conversation, oldest first. The senders' are kept, and the studio's
   * own (`account`) when the conversation is with a sender: `withSender`, or when Instagram did
   * not say who is in it, a sender's message among the newest.
   */
  private async readConversation(
    client: GraphClient,
    conversationId: string,
    senders: readonly string[],
    account: string,
    withSender: boolean | null,
  ): Promise<void> {
    const refs = await client.messages(conversationId);
    const together =
      withSender ??
      refs.some((ref) => ref.from !== null && senders.includes(ref.from.toLowerCase()));
    const kept = together ? [...senders, account.toLowerCase()] : senders;
    const seen = new Set(this.state.seen);
    for (const ref of [...refs].reverse()) {
      if (this.stopped) return;
      if (seen.has(ref.id)) continue;
      if (ref.from === null || kept.includes(ref.from.toLowerCase())) {
        const message = ref.message ?? (await client.message(ref.id));
        const from = senderOf(message);
        if (from !== null && kept.includes(from.toLowerCase())) {
          await this.addMessage(ref.id, message, from, isoOf(ref.createdTime));
        }
      }
      this.markSeen(ref.id);
      seen.add(ref.id);
      this.save();
    }
  }

  private async addMessage(
    messageId: string,
    message: GraphMessage,
    from: string,
    listedAt: string | null,
  ): Promise<void> {
    const at = isoOf(message.created_time) ?? listedAt ?? new Date(this.now()).toISOString();
    const parsed = itemsOfMessage(message);
    const reels = parsed.filter((part) => part.kind === 'reel');
    // The index is the item's place among all the message's parts, so a fresh read finds it again.
    for (const [index, part] of parsed.entries()) {
      if (part.kind !== 'reel') continue;
      const item: StoredItem = {
        id: `${messageId}:${index}`,
        messageId,
        at,
        from,
        kind: part.kind,
        title: part.title,
        text: part.text,
        link: part.link,
        file: null,
        missing: null,
        mediaUrl: part.mediaUrl,
        tries: 0,
      };
      this.state.items.push(item);
      if (item.mediaUrl !== null) await this.fetchFile(item);
    }
    if (reels.length > 0) this.logger.info({ from, reels: reels.length }, 'a reel came in a DM');
  }

  /** Downloads an item's file; a failure is kept on the item as `missing`. */
  private async fetchFile(item: StoredItem): Promise<void> {
    if (item.mediaUrl === null) return;
    item.tries += 1;
    const hash = createHash('sha1').update(item.id).digest('hex').slice(0, 10);
    try {
      item.file = await downloadDmFile(
        item.mediaUrl,
        this.filesDir,
        `${item.at.slice(0, 10)}-${item.kind}-${hash}`,
        this.fetchImpl,
      );
      item.missing = null;
    } catch (err) {
      item.missing = errorText(err);
      this.logger.warn({ item: item.id, err: item.missing }, 'could not download a DM file');
    }
  }

  /** The files that failed before, each with the fresh link a new read of its message gives. */
  private async retryFiles(client: GraphClient): Promise<void> {
    for (const item of this.state.items) {
      if (this.stopped) return;
      if (item.file !== null || item.mediaUrl === null || item.tries >= FILE_TRIES) continue;
      const index = Number(item.id.slice(item.id.lastIndexOf(':') + 1));
      try {
        const fresh = itemsOfMessage(await client.message(item.messageId))[index];
        if (fresh?.mediaUrl) item.mediaUrl = fresh.mediaUrl;
      } catch (err) {
        // A key or a limit problem is the whole check's; anything else is this message's.
        if (err instanceof GraphError && (err.code === 'bad-token' || err.code === 'rate-limit')) {
          throw err;
        }
        item.tries = FILE_TRIES;
        item.missing = 'Instagram no longer gives this file.';
        continue;
      }
      await this.fetchFile(item);
      this.save();
    }
  }

  private markSeen(id: string): void {
    this.state.seen.push(id);
    if (this.state.seen.length > SEEN_LIMIT)
      this.state.seen.splice(0, this.state.seen.length - SEEN_LIMIT);
  }

  private load(): DmState {
    let text: string;
    try {
      text = readFileSync(this.statePath, 'utf8');
    } catch {
      return EMPTY_STATE(); // the first start
    }
    try {
      const json: unknown = JSON.parse(text);
      if (!isRecord(json) || !Array.isArray(json.items) || !Array.isArray(json.seen)) {
        throw new Error('not the inbox state');
      }
      const state = { ...EMPTY_STATE(), rules: 1, ...(json as Partial<DmState>) } as DmState;
      if (state.rules === DM_RULES) return state;
      // Kept under other rules: read again from the start (the files stay in files/).
      this.logger.info({ rules: DM_RULES }, 'reading the Instagram DMs again under new rules');
      return { ...EMPTY_STATE(), account: state.account };
    } catch (err) {
      // Kept aside rather than written over; the files stay in files/.
      const aside = `${this.statePath}.unreadable-${this.now()}`;
      try {
        renameSync(this.statePath, aside);
      } catch {
        // Nothing more to save.
      }
      this.logger.warn({ err: errorText(err), aside }, 'the DMs inbox state could not be read');
      return EMPTY_STATE();
    }
  }

  private save(): void {
    mkdirSync(this.dir, { recursive: true });
    const temp = `${this.statePath}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`);
    renameSync(temp, this.statePath);
  }
}
