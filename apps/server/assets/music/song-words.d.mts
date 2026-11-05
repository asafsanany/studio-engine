export const WORDS: {
  base: string;
  model: string;
  listenMs: number;
  timeoutMs: number;
};

/** The start in ms of the first word in Scribe's answer, `null` for none. */
export function firstWordMs(answer: unknown): number | null;

/** Where the first word starts in `file` (ms), or `ms: null` and why not. Never throws. */
export function firstSungWordMs(options: {
  file: string;
  key: string | null;
  base?: string;
  timeoutMs?: number;
}): Promise<{ ms: number | null; why: string | null }>;
