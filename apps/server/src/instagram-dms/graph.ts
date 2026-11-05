// The studio account's DMs through Instagram's own API: the Conversations API, with either kind
// of key Meta makes for it. Plain fetch, injected in tests.
//
// - A Unified login key (`EAA…`, what Meta's dashboard makes for an app created since 2026): a
//   system-user key with `instagram_basic` and `instagram_manage_messages`. It reads on
//   graph.facebook.com, finds its account through `/me/assigned_instagram_accounts`, and never
//   runs out.
// - An Instagram login key (`IG…`, older apps): an Instagram User key with
//   `instagram_business_basic` and `instagram_business_manage_messages`. It reads on
//   graph.instagram.com and lasts 60 days, so key.ts refreshes it.
//
// The key goes in an `Authorization: Bearer` header (the refresh is the one call Instagram wants it
// in the query), and it is taken out of every error.

import { readFileSync } from 'node:fs';
import { envFilePath } from '../config.js';
import { dotenvValue } from '../instagram/apify.js';

export const GRAPH_ORIGIN = 'https://graph.instagram.com';

/** Where a Unified login key reads the DMs. */
export const FACEBOOK_GRAPH_ORIGIN = 'https://graph.facebook.com';

/** `meta`: a Unified login key (`EAA…`); `instagram`: an Instagram login key (`IG…`). */
export type DmKeyKind = 'meta' | 'instagram';

export function dmKeyKind(token: string): DmKeyKind {
  return token.startsWith('EAA') ? 'meta' : 'instagram';
}

/** The key's name in the repo's .env (or the environment). Only the name lives here. */
export const DM_TOKEN_ENV = 'INSTAGRAM_DM_TOKEN';

/** Whose messages are kept: usernames, comma separated (before `instagramDmFrom` in config.json). */
export const DM_FROM_ENV = 'INSTAGRAM_DM_FROM';
export const DEFAULT_DM_FROM: readonly string[] = [];

/** How long one call may take. */
const CALL_TIMEOUT_MS = 30_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type GraphErrorCode = 'bad-token' | 'permission' | 'rate-limit' | 'bad-field' | 'failed';

export class GraphError extends Error {
  readonly code: GraphErrorCode;
  /** Instagram's own error code (190, 10, 100…), when it gave one. */
  readonly graphCode: number | null;

  constructor(code: GraphErrorCode, message: string, graphCode: number | null = null) {
    super(message);
    this.name = 'GraphError';
    this.code = code;
    this.graphCode = graphCode;
  }
}

/** A value of `name` in the environment, then in the .env file; `null` when neither has one. */
function envOrFile(
  name: string,
  env: Record<string, string | undefined>,
  envFile: string,
): string | null {
  const given = env[name]?.trim() ?? '';
  if (given !== '') return given;
  try {
    const fromFile = (dotenvValue(readFileSync(envFile, 'utf8'), name) ?? '').trim();
    return fromFile === '' ? null : fromFile;
  } catch {
    return null; // no .env
  }
}

/** The key in .env (or the environment); `null` when there is none. */
export function readDmToken(
  env: Record<string, string | undefined> = process.env,
  envFile: string = envFilePath(env),
): string | null {
  return envOrFile(DM_TOKEN_ENV, env, envFile);
}

/** The senders whose messages are kept, lowercase, without `@`. */
export function readDmSenders(
  env: Record<string, string | undefined> = process.env,
  envFile: string = envFilePath(env),
  configured: readonly string[] = DEFAULT_DM_FROM,
): string[] {
  const clean = (name: string) => name.trim().replace(/^@/, '').toLowerCase();
  const listed = (envOrFile(DM_FROM_ENV, env, envFile) ?? '')
    .split(',')
    .map(clean)
    .filter((name) => name !== '');
  return [...new Set(listed.length > 0 ? listed : configured.map(clean))];
}

export interface GraphConversation {
  id: string;
  updatedTime: string | null;
  /** Who is in it (usernames, lowercase); `null` when Instagram did not say. */
  participants: string[] | null;
}

export interface GraphMessageRef {
  id: string;
  createdTime: string | null;
  /** The sender's username, when the list said it. */
  from: string | null;
  /** The whole message, when the list carried it (then it needs no call of its own). */
  message: GraphMessage | null;
}

/** A message as Instagram answers it; read with care (parse.ts), every field may be missing. */
export type GraphMessage = Record<string, unknown>;

/**
 * The field lists a message is asked for with, richest first. Instagram refuses a whole request
 * that names a field it does not have (error 100), so a refusal moves on to the next list.
 */
export const MESSAGE_FIELDS = [
  'id,created_time,from,message,attachments,shares{id,name,description,link,type,url},story,is_unsupported',
  'id,created_time,from,message,attachments,shares{id,name,description,type,url},story,is_unsupported',
  'id,created_time,from,message,attachments,shares,story,is_unsupported',
  'id,created_time,from,message,attachments',
] as const;

/**
 * A conversation's messages: whole first (one call for all of them: Meta counts an app's calls
 * and their server time by the hour), then with each sender, then ids only.
 */
const CONVERSATION_FIELDS = [
  ...MESSAGE_FIELDS.map((fields) => `messages{${fields}}`),
  'messages{id,created_time,from}',
  'messages',
] as const;

/** The conversations list: with who is in each first, so the others are never read. */
const CONVERSATION_LIST_FIELDS = ['id,updated_time,participants', 'id,updated_time'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** The `data` array of an Instagram list answer. */
function dataOf(value: unknown): unknown[] {
  return isRecord(value) && Array.isArray(value.data) ? value.data : [];
}

export interface GraphClientOptions {
  token: string;
  fetch?: FetchLike;
}

export class GraphClient {
  readonly kind: DmKeyKind;
  private readonly token: string;
  private readonly origin: string;
  private readonly fetchImpl: FetchLike;
  /** The first message field list Instagram took; the next calls start there. */
  private messageFields = 0;
  private conversationFields = 0;
  private listFields = 0;

  constructor(options: GraphClientOptions) {
    this.token = options.token;
    this.kind = dmKeyKind(options.token);
    this.origin = this.kind === 'meta' ? FACEBOOK_GRAPH_ORIGIN : GRAPH_ORIGIN;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Whether the key runs out and is refreshed (an Instagram login key); a Unified login key never runs out. */
  get refreshable(): boolean {
    return this.kind === 'instagram';
  }

  /** The account the key belongs to (a Unified login key's first Instagram account). */
  async me(): Promise<{ id: string; username: string }> {
    const body =
      this.kind === 'meta'
        ? dataOf(await this.get('/me/assigned_instagram_accounts', { fields: 'id,username' }))[0]
        : await this.get('/me', { fields: 'id,username' });
    const id = isRecord(body) ? text(body.id) : null;
    const username = isRecord(body) ? text(body.username) : null;
    if (id === null || username === null) {
      throw new GraphError(
        'failed',
        this.kind === 'meta'
          ? 'The key has no Instagram account: generate it next to the account in the app’s Instagram setup.'
          : 'Instagram did not say which account the key belongs to.',
      );
    }
    return { id, username };
  }

  /**
   * The conversations of the account `accountId` (from `me()`), the most recently active first
   * (the first page is enough).
   */
  async conversations(accountId: string): Promise<GraphConversation[]> {
    const owner = this.kind === 'meta' ? `/${encodeURIComponent(accountId)}` : '/me';
    const body = await this.withFields(CONVERSATION_LIST_FIELDS, 'listFields', (fields) =>
      this.get(`${owner}/conversations`, { platform: 'instagram', fields }),
    );
    return dataOf(body).flatMap((item) => {
      const id = isRecord(item) ? text(item.id) : null;
      if (id === null || !isRecord(item)) return [];
      const names = dataOf(item.participants).flatMap((person) => {
        const name = isRecord(person) ? (text(person.username) ?? text(person.name)) : null;
        return name === null ? [] : [name.toLowerCase()];
      });
      return [
        { id, updatedTime: text(item.updated_time), participants: names.length > 0 ? names : null },
      ];
    });
  }

  /** The newest messages of a conversation (Instagram lets the API read the 20 newest). */
  async messages(conversationId: string): Promise<GraphMessageRef[]> {
    const body = await this.withFields(CONVERSATION_FIELDS, 'conversationFields', (fields) =>
      this.get(`/${encodeURIComponent(conversationId)}`, { fields }),
    );
    const whole = this.conversationFields < MESSAGE_FIELDS.length;
    const messages = isRecord(body) ? body.messages : undefined;
    return dataOf(messages).flatMap((item) => {
      if (!isRecord(item)) return [];
      const id = text(item.id);
      if (id === null) return [];
      const from = isRecord(item.from) ? text(item.from.username) : null;
      return [{ id, createdTime: text(item.created_time), from, message: whole ? item : null }];
    });
  }

  /** One message with everything Instagram gives about it. */
  async message(messageId: string): Promise<GraphMessage> {
    const body = await this.withFields(MESSAGE_FIELDS, 'messageFields', (fields) =>
      this.get(`/${encodeURIComponent(messageId)}`, { fields }),
    );
    if (!isRecord(body)) throw new GraphError('failed', 'Instagram sent a message it cannot read.');
    return body;
  }

  /**
   * A fresh key for this one (60 days from now). Instagram refreshes only a key that is at least
   * 24 hours old and has not expired.
   */
  async refreshToken(): Promise<{ token: string; expiresInSecs: number | null }> {
    const body = await this.get(
      '/refresh_access_token',
      { grant_type: 'ig_refresh_token', access_token: this.token },
      false,
    );
    const token = isRecord(body) ? text(body.access_token) : null;
    if (token === null) throw new GraphError('failed', 'Instagram did not send a new key.');
    const expires = isRecord(body) ? body.expires_in : undefined;
    return { token, expiresInSecs: typeof expires === 'number' ? expires : null };
  }

  /** Runs `call` with the remembered field list, moving to a plainer one when Instagram refuses. */
  private async withFields(
    lists: readonly string[],
    slot: 'messageFields' | 'conversationFields' | 'listFields',
    call: (fields: string) => Promise<unknown>,
  ): Promise<unknown> {
    for (let index = this[slot]; ; index += 1) {
      const fields = lists[index] ?? lists[lists.length - 1] ?? '';
      try {
        const body = await call(fields);
        this[slot] = Math.min(index, lists.length - 1);
        return body;
      } catch (err) {
        if (!(err instanceof GraphError && err.code === 'bad-field') || index >= lists.length - 1) {
          throw err;
        }
      }
    }
  }

  private async get(path: string, query: Record<string, string>, bearer = true): Promise<unknown> {
    const url = `${this.origin}${path}?${new URLSearchParams(query).toString()}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: bearer ? { Authorization: `Bearer ${this.token}` } : {},
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GraphError('failed', `Can't reach Instagram: ${this.clean(err)}`);
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Not JSON: said below.
    }
    if (isRecord(body) && isRecord(body.error)) throw this.errorOf(body.error, response.status);
    if (!response.ok) {
      throw new GraphError('failed', `Instagram answered ${response.status}.`);
    }
    if (body === null) throw new GraphError('failed', 'Instagram sent an answer that is not JSON.');
    return body;
  }

  /** Instagram's `{ error: { message, code, type } }` as a GraphError. */
  private errorOf(error: Record<string, unknown>, status: number): GraphError {
    const graphCode = typeof error.code === 'number' ? error.code : null;
    const said = this.clean(text(error.message) ?? `HTTP ${status}`);
    if (graphCode === 190 || status === 401) {
      return new GraphError('bad-token', `Instagram refused the key: ${said}`, graphCode);
    }
    if (graphCode === 10 || (graphCode !== null && graphCode >= 200 && graphCode < 300)) {
      return new GraphError(
        'permission',
        `The key may not read the DMs: ${said} (it needs ${this.kind === 'meta' ? 'instagram_manage_messages' : 'instagram_business_manage_messages'})`,
        graphCode,
      );
    }
    if (graphCode === 4 || graphCode === 17 || graphCode === 32 || graphCode === 613) {
      return new GraphError('rate-limit', `Instagram asks to slow down: ${said}`, graphCode);
    }
    if (graphCode === 100) return new GraphError('bad-field', said, graphCode);
    return new GraphError('failed', `Instagram said: ${said}`, graphCode);
  }

  /** Text with the key taken out. */
  private clean(value: unknown): string {
    const said = value instanceof Error ? value.message : String(value);
    return this.token === '' ? said : said.split(this.token).join('<key>');
  }
}
