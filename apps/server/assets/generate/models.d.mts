// Types of models.mjs, the Higgsfield models make-shots.mjs uses and their request bodies (GN3).

export const SLUGS: {
  kling25: string;
  wan3: string;
  soul: string;
  soulEdit: string;
  qwenEdit: string;
  qwen: string;
  zImage: string;
};

export const DEFAULT_ASPECT: string;
export const WAN_ASPECTS: string[];
export const SOUL_ASPECTS: string[];
export const IMAGE_ASPECTS: string[];

export class ModelError extends Error {}

export type TierName = 'easy' | 'people' | 'tilt';

export interface TierDef {
  slug: string;
  model: string;
  seconds: { set?: number[]; min?: number; max?: number };
  endFrame: 'no' | 'optional' | 'required';
  priced: 'estimate' | 'per second';
}

export const TIERS: Record<TierName, TierDef>;
export const TIER_NAMES: TierName[];

export function tierForSlug(slug: string, hasEnd: boolean): TierName | null;
export function clipSeconds(tier: string, asked: number): { seconds: number; rounded: boolean };
export function clipBody(
  tier: string,
  options: {
    prompt: string;
    startUrl: string;
    endUrl?: string;
    seconds: number;
    aspect?: string;
    negative?: string;
  },
): Record<string, unknown>;

export interface ImageModel {
  slug: string;
  model: string;
  refs: { min: number; max: number };
  aspects: string[];
  body: (options: { prompt: string; aspect: string; urls: string[] }) => Record<string, unknown>;
}

export const IMAGE_MODELS: Record<string, ImageModel>;
export const IMAGE_MODEL_NAMES: string[];
export function imageModel(asked: string | undefined, refCount: number): ImageModel;
export function stillBody(
  model: ImageModel,
  options: { prompt: string; aspect?: string; urls: string[] },
): Record<string, unknown>;

export function priceOf(
  answer: unknown,
  body: Record<string, unknown> | undefined,
): { usd: number; basis: 'estimate' | 'list' };
export function listRatePerSecond(description: string, resolution?: string): number | null;
