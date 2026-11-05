// Types of stock-env.mjs, the keys and plain HTTP of the stock script (Stock media), for its tests.

export const ENV_FILE_ENV: string;
export const REPO_ENV_FILE: string;
export const KEY_ENV: { openverseId: string; openverseSecret: string; unsplash: string };
export const LIMITS: {
  httpTimeoutMs: number;
  transferTimeoutMs: number;
  maxSfxBytes: number;
  maxPhotoBytes: number;
};

export function rememberSecret(value: string): void;
export function redact(text: string): string;
export function dotenvValue(text: string, name: string): string | null;
export function envFile(env?: Record<string, string | undefined>, home?: string): string;
export function readKey(
  name: string,
  env?: Record<string, string | undefined>,
  file?: string,
): string | null;
export function clipTitle(text: unknown, max?: number): string;
export function apiBase(defaultBase: string, override?: string): string;
export function downloadAllowed(url: string): boolean;

export type StockErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'key_missing'
  | 'key_rejected'
  | 'limit_reached'
  | 'rate_limited'
  | 'unavailable';

export class StockError extends Error {
  constructor(code: StockErrorCode, message: string, extra?: Record<string, unknown>);
  code: StockErrorCode;
}

export type FetchFn = typeof fetch;

export function requestJson(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  options: { service: string; timeoutMs?: number },
): Promise<{ json: unknown; headers: Headers }>;

export function downloadBytes(
  fetchFn: FetchFn,
  url: string,
  options: { maxBytes: number; typeOk: (type: string) => boolean; timeoutMs?: number },
): Promise<{ bytes: Buffer; type: string }>;
