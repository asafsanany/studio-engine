// The models make-shots.mjs may use, and how a request body for each is built (Generated videos,
// GN3; facts: ~/.studio-engine/handoff/generate-design/higgsfield-api.md, live-checked by GN1).
//
// Higgsfield's API silently ignores a field it does not know, so a misspelt name does nothing and
// is never reported. Every body therefore comes from a per-model whitelist built here, never from
// free text, and the defaults that cost money are always overridden: Wan 3.0 would otherwise make
// 1080p (twice the price) with an adaptive aspect and with sound on.
//
// Plain Node, no dependencies, no network: the backend (backends/higgsfield-api.mjs) sends what
// these functions build.

/** Higgsfield's model slugs (the path of a request). */
export const SLUGS = {
  kling25: 'kling-video/v2.5-turbo/standard/image-to-video',
  wan3: 'alibaba/wan-3.0/image-to-video',
  soul: 'higgsfield-ai/soul/v2/standard',
  soulEdit: 'higgsfield-ai/soul/v2/image-to-image',
  qwenEdit: 'alibaba/qwen-image-3/edit',
  qwen: 'alibaba/qwen-image-3/text-to-image',
  zImage: 'z-image/turbo',
};

/** The shape every video is made in. Wan's own default is "adaptive", which follows the image. */
export const DEFAULT_ASPECT = '9:16';

/** Wan 3.0's aspect ratios (without "adaptive": it would follow whatever the keyframe is). */
export const WAN_ASPECTS = ['16:9', '4:3', '1:1', '3:4', '9:16'];
/** Soul 2.0's. */
export const SOUL_ASPECTS = ['9:16', '16:9', '4:3', '3:4', '1:1', '2:3', '3:2'];
/** Qwen Image 3's and Z-Image Turbo's. */
export const IMAGE_ASPECTS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '7:9',
  '9:7',
  '9:16',
  '16:9',
  '21:9',
];

/** A refusal of a request that cannot be made: the caller answers `bad_request` with this text. */
export class ModelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelError';
  }
}

// --- the video tiers ----------------------------------------------------------------------------

/**
 * Our three tiers (GENERATE_TIERS in the shared contract) and the Higgsfield model each one means.
 *   easy    Kling 2.5 Turbo: the cheap model for gentle ambient motion (no hands, no liquid). Only 5 s
 *           or 10 s; a start frame only.
 *   people  Wan 3.0 at 720p: people, hands, water. The exact seconds (any whole number 2 to 30).
 *   tilt    Wan 3.0 with an end frame: a move that must land on an exact view.
 * Kling O3 first-last-frame ($0.357 std for 5 s) also takes two frames; Wan 3.0 took the end frame
 * live, so it is not used.
 */
export const TIERS = {
  easy: {
    slug: SLUGS.kling25,
    model: 'Kling 2.5 Turbo',
    seconds: { set: [5, 10] },
    endFrame: 'no',
    priced: 'estimate',
  },
  people: {
    slug: SLUGS.wan3,
    model: 'Wan 3.0 (720p)',
    seconds: { min: 2, max: 30 },
    endFrame: 'optional',
    priced: 'per second',
  },
  tilt: {
    slug: SLUGS.wan3,
    model: 'Wan 3.0 (720p) with an end frame',
    seconds: { min: 2, max: 30 },
    endFrame: 'required',
    priced: 'per second',
  },
};

export const TIER_NAMES = Object.keys(TIERS);

/** The tier a video model's slug means (`--model <slug>` instead of `--tier`); `end` tells tilt from people. */
export function tierForSlug(slug, hasEnd) {
  if (slug === SLUGS.kling25) return 'easy';
  if (slug === SLUGS.wan3) return hasEnd ? 'tilt' : 'people';
  return null;
}

/**
 * The seconds a clip is really made at: `{ seconds, rounded }`. Kling 2.5 Turbo only makes 5 s or
 * 10 s, so 4 s is made at 5 and 7 s at 10 (it is rounded UP, and the answer says so); Wan 3.0 makes
 * any whole number of seconds from 2 to 30. More than the tier can make is refused.
 */
export function clipSeconds(tier, asked) {
  const def = TIERS[tier];
  if (!def) throw new ModelError(`Unknown tier "${tier}": use ${TIER_NAMES.join(', ')}.`);
  if (!Number.isFinite(asked) || asked <= 0)
    throw new ModelError('clip needs --seconds N (above 0).');
  let seconds;
  if (def.seconds.set) {
    seconds = def.seconds.set.find((allowed) => allowed >= asked - 1e-9);
    if (seconds === undefined) {
      const longest = def.seconds.set[def.seconds.set.length - 1];
      throw new ModelError(
        `The ${tier} tier (${def.model}) makes at most ${longest} s; ${asked} s is too long: use a shorter clip or tier people.`,
      );
    }
  } else {
    seconds = Math.max(def.seconds.min, Math.ceil(asked - 1e-9));
    if (seconds > def.seconds.max) {
      throw new ModelError(
        `The ${tier} tier makes at most ${def.seconds.max} s; ${asked} s is too long.`,
      );
    }
  }
  return { seconds, rounded: seconds !== asked };
}

/**
 * The request body of a clip, from a whitelist. `startUrl` and `endUrl` are the public URLs the
 * upload flow gave; `aspect` is only for Wan (Kling follows its start frame).
 */
export function clipBody(tier, { prompt, startUrl, endUrl, seconds, aspect, negative }) {
  const def = TIERS[tier];
  if (!def) throw new ModelError(`Unknown tier "${tier}": use ${TIER_NAMES.join(', ')}.`);
  if (def.endFrame === 'no' && endUrl) {
    throw new ModelError(
      'The easy tier (Kling 2.5 Turbo) takes a start frame only: use tier tilt (or people) for a clip with an end frame.',
    );
  }
  if (def.endFrame === 'required' && !endUrl) {
    throw new ModelError('The tilt tier needs --end <the frame the move must land on>.');
  }
  if (tier === 'easy') {
    if (aspect !== undefined && aspect !== null) {
      throw new ModelError(
        'The easy tier (Kling 2.5 Turbo) has no --aspect: it follows the shape of its start frame.',
      );
    }
    return {
      prompt,
      image_url: startUrl,
      duration: seconds,
      ...(negative ? { negative_prompt: negative } : {}),
    };
  }
  if (negative) {
    throw new ModelError('Wan 3.0 has no negative prompt: say what to avoid in the prompt itself.');
  }
  const ratio = aspect ?? DEFAULT_ASPECT;
  if (!WAN_ASPECTS.includes(ratio)) {
    throw new ModelError(`Wan 3.0 makes ${WAN_ASPECTS.join(', ')}; "${ratio}" is not one of them.`);
  }
  return {
    prompt,
    image_url: startUrl,
    ...(endUrl ? { end_image_url: endUrl } : {}),
    duration: seconds,
    // Always overridden: its defaults are 1080p (double the price), adaptive and sound on.
    resolution: '720p',
    aspect_ratio: ratio,
    generate_audio: false,
  };
}

// --- the image models ---------------------------------------------------------------------------

/**
 * The image models, by the short name an agent may use (or the full slug). `refs` is how many
 * reference images the model takes (it is told off for more or fewer, never silently ignored).
 */
export const IMAGE_MODELS = {
  soul: {
    slug: SLUGS.soul,
    model: 'Soul 2.0',
    refs: { min: 0, max: 0 },
    aspects: SOUL_ASPECTS,
    body: ({ prompt, aspect }) => ({ prompt, aspect_ratio: aspect, resolution: '720p' }),
  },
  'soul-i2i': {
    slug: SLUGS.soulEdit,
    model: 'Soul 2.0 image to image',
    refs: { min: 1, max: 1 },
    aspects: SOUL_ASPECTS,
    // Its docs page does not exist: image_url and prompt are the fields Higgsfield's own 400 names.
    body: ({ prompt, aspect, urls }) => ({ prompt, image_url: urls[0], aspect_ratio: aspect }),
  },
  'qwen-edit': {
    slug: SLUGS.qwenEdit,
    model: 'Qwen Image 3 edit',
    refs: { min: 1, max: 3 },
    aspects: IMAGE_ASPECTS,
    // prompt_extend and enable_thinking both default to true: off keeps the prompt as written.
    body: ({ prompt, aspect, urls }) => ({
      prompt,
      image_urls: urls,
      aspect_ratio: aspect,
      resolution: '1k',
      prompt_extend: false,
      enable_thinking: false,
    }),
  },
  qwen: {
    slug: SLUGS.qwen,
    model: 'Qwen Image 3',
    refs: { min: 0, max: 0 },
    aspects: IMAGE_ASPECTS,
    body: ({ prompt, aspect }) => ({
      prompt,
      aspect_ratio: aspect,
      resolution: '1k',
      prompt_extend: false,
      enable_thinking: false,
    }),
  },
  'z-image': {
    slug: SLUGS.zImage,
    model: 'Z-Image Turbo',
    refs: { min: 0, max: 0 },
    aspects: IMAGE_ASPECTS,
    // The prompt is limited to 800 characters (the free estimate says so if it is longer).
    body: ({ prompt, aspect }) => ({ prompt, aspect_ratio: aspect, resolution: '1k' }),
  },
};

export const IMAGE_MODEL_NAMES = Object.keys(IMAGE_MODELS);

/** The image model a `--model` value means: a short name or a full slug. Without one: by references. */
export function imageModel(asked, refCount) {
  if (asked === undefined || asked === '') {
    return IMAGE_MODELS[refCount > 0 ? 'qwen-edit' : 'soul'];
  }
  const found = Object.values(IMAGE_MODELS).find((model) => model.slug === asked);
  const model = IMAGE_MODELS[asked] ?? found;
  if (!model) {
    throw new ModelError(
      `Unknown image model "${asked}": use ${IMAGE_MODEL_NAMES.join(', ')} (or the full slug).`,
    );
  }
  return model;
}

/** The request body of a still, from the model's whitelist; refused when the references do not fit. */
export function stillBody(model, { prompt, aspect, urls }) {
  if (urls.length < model.refs.min || urls.length > model.refs.max) {
    const wants =
      model.refs.max === 0
        ? 'takes no reference image'
        : `takes ${model.refs.min === model.refs.max ? model.refs.min : `${model.refs.min} to ${model.refs.max}`} reference image${model.refs.max === 1 ? '' : 's'}`;
    throw new ModelError(`${model.model} ${wants}; ${urls.length} given with --ref.`);
  }
  const ratio = aspect ?? DEFAULT_ASPECT;
  if (!model.aspects.includes(ratio)) {
    throw new ModelError(
      `${model.model} makes ${model.aspects.join(', ')}; "${ratio}" is not one of them.`,
    );
  }
  return model.body({ prompt, aspect: ratio, urls });
}

// --- prices -------------------------------------------------------------------------------------

/**
 * The dollars of one request, from the answer of `POST /estimate/<slug>`:
 *   { type: "estimate", usd }          the price to pay, already net of the model's discount (the
 *                                       discount moves per model: 50% on Kling 2.5 Turbo today, none
 *                                       on the image models); used as it is
 *   { type: "description", pricing_description }
 *                                       models priced per second ("720p $0.10") say so in words and
 *                                       give no number; the LIST price times the seconds is booked,
 *                                       because no discount is visible (the worst case)
 * Returns `{ usd, basis: "estimate" | "list" }`, or throws a ModelError when the answer cannot be read.
 */
export function priceOf(answer, body) {
  if (answer && answer.type === 'estimate') {
    const usd = Number(answer.usd);
    if (Number.isFinite(usd) && usd >= 0) return { usd, basis: 'estimate' };
  }
  if (answer && answer.type === 'description' && typeof answer.pricing_description === 'string') {
    const perSecond = listRatePerSecond(answer.pricing_description, body?.resolution);
    const seconds = Number(body?.duration);
    if (perSecond !== null && Number.isFinite(seconds) && seconds > 0) {
      return { usd: Math.round(perSecond * seconds * 1e6) / 1e6, basis: 'list' };
    }
  }
  throw new ModelError('Higgsfield gave no price for this request that can be read.');
}

/**
 * The list rate per second at a resolution out of a price description such as "Priced per generated
 * second by resolution: 480p $0.05, 720p $0.10, or 1080p $0.20. Rates shown are before any
 * applicable customer discount." `null` when the description does not give one.
 */
export function listRatePerSecond(description, resolution) {
  if (!/per\s+(?:generated\s+)?second/i.test(description) || !resolution) return null;
  for (const match of description.matchAll(/(\d{3,4}p)\s*\$\s*(\d+(?:\.\d+)?)/gi)) {
    if (match[1].toLowerCase() === String(resolution).toLowerCase()) return Number(match[2]);
  }
  return null;
}
