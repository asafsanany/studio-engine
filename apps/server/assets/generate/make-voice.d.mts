// Types of make-voice.mjs, the voice script (Generated videos, GN2), for its tests and the doctor.
// The lines it prints are the shared contract's (packages/shared/src/domain/generate.ts).

export const EXIT: { ok: 0; failed: 1; refused: 2; down: 3 };
export const KEY_FILE: string;
export const DEFAULT_VOICE_ID: string;

export const ELEVENLABS: {
  base: string;
  expressiveModel: string;
  steadyModel: string;
  scribeModel: string;
  speechFormat: string;
  speechBytesPerSec: number;
  speechTimeoutMs: number;
  scribeTimeoutMs: number;
  sfxTimeoutMs: number;
  retryMs: number;
  textMax: number;
  promptMax: number;
  secondsMin: number;
  secondsMax: number;
};

export const MASTER: {
  sampleRate: number;
  bitrate: string;
  integratedLufs: number;
  truePeakDbtp: number;
  defaultPauseMs: number;
  leadMaxMs: number;
};

export type VoiceErrorCode =
  | 'balance_empty'
  | 'key_rejected'
  | 'over_budget'
  | 'bad_request'
  | 'unavailable'
  | 'generation_failed';

export const MESSAGES: Record<VoiceErrorCode, string>;
export const EXIT_FOR: Record<VoiceErrorCode, number>;

export class VoiceError extends Error {
  constructor(
    code: VoiceErrorCode,
    detail?: string,
    extra?: { message?: string; modelRefused?: boolean },
  );
  code: VoiceErrorCode;
  detail: string;
  modelRefused: boolean;
}

export function redact(text: string): string;
export function readKey(env?: Record<string, string | undefined>, file?: string): string | null;

export interface VoiceArgs {
  command: 'line' | 'check' | 'assemble' | 'sfx';
  editDir: string;
  word: string | null;
  options: Map<string, string>;
}
export function parseArgs(argv: string[]): VoiceArgs;
export function parseOrder(text: string | undefined): { id: string; take: number }[];
export function parsePauses(text: string | undefined): Map<string, number>;
/** `--lead`: whole milliseconds of silence before the first line (0 to `MASTER.leadMaxMs`); none given is 0. */
export function parseLead(text: string | undefined): number;

export function findTool(
  name: 'ffmpeg' | 'ffprobe',
  env?: Record<string, string | undefined>,
): string | null;
export function isInside(root: string, path: string): boolean;

export function failureFor(
  status: number,
  body: unknown,
  what?: string,
): {
  code: VoiceErrorCode;
  detail: string;
  retry: boolean;
  message?: string;
  modelRefused?: boolean;
};

export function directionTags(direction: string | null | undefined): string;
export function speechBody(
  text: string,
  direction: string | null | undefined,
  model: string,
): { sent: string; applied: boolean; body: Record<string, unknown> };
export function loudnessGain(integrated: number, truePeak: number): number;

export function run(
  argv: string[],
  env?: Record<string, string | undefined>,
): Promise<Record<string, unknown>>;
