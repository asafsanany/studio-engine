// Types of backends/higgsfield-api.mjs, the Higgsfield API backend of make-shots.mjs (GN3), for its
// tests and the doctor's "Higgsfield key" check.

export const API_BASE: string;
export const KEY_ENV: 'HIGGSFIELD_API_KEY';
export const ENV_FILE_ENV: 'STUDIO_ENV_FILE';
export const API_BASE_ENV: 'HIGGSFIELD_API_BASE';
export const REPO_ENV_FILE: string;

export const LIMITS: {
  httpTimeoutMs: number;
  transferTimeoutMs: number;
  retryMs: number;
  attempts: number;
  throttleTries: number;
  throttleMaxMs: number;
};

export function rememberKey(key: string): void;
export function redact(text: string): string;
export function dotenvValue(text: string, name: string): string | null;
export function envFile(env?: Record<string, string | undefined>, home?: string): string;
export function readKey(env?: Record<string, string | undefined>, file?: string): string | null;
export function apiBase(env?: Record<string, string | undefined>): string;

export class ApiError extends Error {
  code: 'key_rejected' | 'balance_empty' | 'bad_request' | 'unavailable' | 'generation_failed';
  detail: string;
  status: number | null;
  constructor(
    code: string,
    detail: string,
    status?: number | null,
    extra?: Record<string, unknown>,
  );
}

export function detailOf(json: unknown, text?: string): string;
export function errorForReply(
  status: number,
  json: unknown,
  text: string | null,
  label: string,
): ApiError;
export function retryAfterMs(
  headers: { get?: (name: string) => string | null } | undefined,
  json: unknown,
): number;

export interface Backend {
  base: string;
  estimate(slug: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  uploadUrl(contentType: string): Promise<{
    public_url: string;
    upload_url: string;
    upload_headers?: Record<string, string>;
  }>;
  putFile(url: string, headers: Record<string, string>, bytes: Buffer): Promise<void>;
  submit(
    slug: string,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<{ request_id: string; status_url?: string; status?: string }>;
  status(requestId: string): Promise<Record<string, unknown> & { status: string }>;
  download(url: string): Promise<Buffer>;
}

export function createBackend(options: {
  key: string;
  base?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  deadline?: number;
  httpTimeoutMs?: number;
  retryMs?: number;
  log?: (line: string) => void;
}): Backend;
