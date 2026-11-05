// Camera LUTs: match the footage, and the "waiting for a camera LUT" sentence (LUTs build 2, LU10).
// OWNER: LU10.
//
// What the footage can and cannot say (the LU10 spike, ffprobe over every clip on this Mac):
//   - Nothing in ffprobe's colour fields names a camera log curve. They say bt709 for ordinary
//     exports, `arib-std-b67` (HLG) for an iPhone, and a log camera's MP4 usually says nothing or
//     bt709. `make` / `model` tags only say which camera made the file, not which curve it shot.
//   - Whether footage IS log is only known from the pixels: the colour-grade wrapper measures it
//     (`footage_type.py`) and blocks a log source that has no camera LUT.
//   - Which curve is only known when the file says it in words: a tag, or a name the person gave
//     the file ("A7S_S-Log3_001.mp4"). That is a hint, never a fact: the wrapper's measurement
//     decides whether a camera LUT is applied at all.
//   - The measurement is cautious. A clip encoded with Sony's S-Log3 curve (all four shape signals
//     fired: black point 0.16, highlights stop at 0.56, range 0.40, purity 0.14) was still called
//     "ambiguous", not "log", so a source the grade cannot tell, whose files name a curve, counts as
//     log here. Without a name, "ambiguous" stays a question for a person, not a missing LUT.
//
// So the rule is small and never guesses:
//   1. A clip's texts (its tags and its file name) name exactly one known curve -> that curve. Two
//      different curves, or none -> no curve.
//   2. The Camera LUTs of the library that name that same curve (their name, slug or file name) are
//      the matches. Exactly one -> the engine hands it to the editor, who applies it only to a source
//      the wrapper calls log. None, or more than one -> the job waits and says so; a note can still
//      name one by hand (`@luts/…`), which always wins.
//   3. A curve is never taken from the camera's make or model, and a LUT is never matched by its
//      kind alone ("any Camera LUT").
//
// A LUT whose job is a gamut change ("S-Gamut3 to Cine") does not name a log curve and so matches
// nothing here.
//
// The sentence a waiting job ends with is the contract between the editor (which writes it as its
// `Blocked:` line), the engine (which shows it as the job's error) and the page (which finds the
// waiting jobs by parsing it): `Waiting for a camera LUT: the clips are Sony S-Log3.`

/** The log curves known by name. */
export const CAMERA_CURVE_IDS = [
  'slog3',
  'slog2',
  'vlog',
  'clog3',
  'clog2',
  'clog',
  'logc3',
  'logc4',
  'log3g10',
  'nlog',
  'flog2',
  'flog',
  'dlogm',
  'dlog',
  'bmdfilm',
] as const;
export type CameraCurveId = (typeof CAMERA_CURVE_IDS)[number];

interface CameraCurve {
  id: CameraCurveId;
  /** The camera maker and the curve, as a person says it: "Sony S-Log3". */
  label: string;
  /** Matches the curve's name in a tag, a file name or a LUT name (lower-case text). */
  pattern: RegExp;
}

// Written for lower-case text. `-`, `_` and `.` may sit inside a name ("s-log3", "s_log3", "slog3");
// a following letter or digit ends the match from being the same name ("c-log" is not "c-log3"),
// and an optional trailing "-3" style number is excluded where it would make a different curve.
const CURVES: readonly CameraCurve[] = [
  { id: 'slog3', label: 'Sony S-Log3', pattern: /s[-_.]?log[-_. ]?3(?![0-9])/ },
  { id: 'slog2', label: 'Sony S-Log2', pattern: /s[-_.]?log[-_. ]?2(?![0-9])/ },
  {
    id: 'vlog',
    label: 'Panasonic V-Log',
    // "vlog" alone is also what people call a video blog, so it needs the dash (or the V-Log L spelling).
    pattern: /v[-_. ]log(?![a-z0-9])|vlog[-_.]?l(?![a-z0-9])|vlog[-_.]?to[-_.]?v?709/,
  },
  { id: 'clog3', label: 'Canon C-Log3', pattern: /c[-_.]?log[-_. ]?3(?![0-9])/ },
  { id: 'clog2', label: 'Canon C-Log2', pattern: /c[-_.]?log[-_. ]?2(?![0-9])/ },
  {
    id: 'clog',
    label: 'Canon C-Log',
    pattern: /c[-_.]?log(?![a-z0-9])(?![-_.][23](?![0-9]))/,
  },
  { id: 'logc4', label: 'ARRI LogC4', pattern: /log[-_.]?c[-_.]?4(?![0-9])/ },
  {
    id: 'logc3',
    label: 'ARRI LogC3',
    pattern: /log[-_.]?c(?:[-_.]?3)?(?![a-z0-9])(?![-_.]4(?![0-9]))/,
  },
  { id: 'log3g10', label: 'RED Log3G10', pattern: /log[-_.]?3g10/ },
  {
    id: 'nlog',
    label: 'Nikon N-Log',
    // "canon-log" ends in "n-log": a single letter only counts at the start of a word, or after the maker.
    pattern: /(?<![a-z])n[-_.]?log(?![a-z0-9])|nikon[-_. ]?n[-_.]?log(?![a-z0-9])/,
  },
  {
    id: 'flog2',
    label: 'Fujifilm F-Log2',
    pattern:
      /(?<![a-z])f[-_.]?log[-_. ]?2(?![0-9])|fuji(?:film)?[-_. ]?f[-_.]?log[-_. ]?2(?![0-9])/,
  },
  {
    id: 'flog',
    label: 'Fujifilm F-Log',
    pattern:
      /(?<![a-z])f[-_.]?log(?![a-z0-9])(?![-_.]2(?![0-9]))|fuji(?:film)?[-_. ]?f[-_.]?log(?![a-z0-9])(?![-_.]2(?![0-9]))/,
  },
  {
    id: 'dlogm',
    label: 'DJI D-Log M',
    pattern: /(?<![a-z])d[-_.]?log[-_. ]?m(?![a-z0-9])|dji[-_. ]?d[-_.]?log[-_. ]?m(?![a-z0-9])/,
  },
  {
    id: 'dlog',
    label: 'DJI D-Log',
    pattern:
      /(?<![a-z])d[-_.]?log(?![a-z0-9])(?![-_. ]?m(?![a-z0-9]))|dji[-_. ]?d[-_.]?log(?![a-z0-9])(?![-_. ]?m(?![a-z0-9]))/,
  },
  { id: 'bmdfilm', label: 'Blackmagic Film', pattern: /(?:bmd|blackmagic)[-_. ]?film/ },
];

const BY_ID = new Map<CameraCurveId, CameraCurve>(CURVES.map((curve) => [curve.id, curve]));

/** "Sony S-Log3" for `slog3`. */
export function cameraCurveLabel(id: CameraCurveId): string {
  return BY_ID.get(id)?.label ?? id;
}

/** The curve a label (as {@link cameraCurveLabel} says it, in any case) names, or `null`. */
export function cameraCurveOfLabel(label: string): CameraCurveId | null {
  const wanted = label.trim().toLowerCase();
  return CURVES.find((curve) => curve.label.toLowerCase() === wanted)?.id ?? null;
}

/** The curves a text names, each once, in the table's order. */
export function curvesNamedIn(text: string): CameraCurveId[] {
  const lower = text.toLowerCase();
  return CURVES.filter((curve) => curve.pattern.test(lower)).map((curve) => curve.id);
}

/**
 * The curve a clip says it was shot in: the one curve its texts (tags, file name) name. Two
 * different curves in one clip's texts is a contradiction and answers `null`, like no curve at all.
 */
export function cameraCurveOfClip(texts: readonly string[]): CameraCurveId | null {
  const found = new Set<CameraCurveId>();
  for (const text of texts) for (const id of curvesNamedIn(text)) found.add(id);
  if (found.size !== 1) return null;
  return [...found][0] ?? null;
}

// --- the match ----------------------------------------------------------------------------------

/** What the match needs to know of a LUT of the library. */
export interface CameraLutCandidate {
  slug: string;
  name: string;
  kind: 'look' | 'camera' | 'fix';
  /** The file name (`Sony S-Log3 to Rec709.cube`); `null` for a LUT with no file. */
  file: string | null;
}

export type CameraLutMatch<T extends CameraLutCandidate = CameraLutCandidate> =
  /** Exactly one Camera LUT names the curve: use it. */
  | { kind: 'one'; lut: T }
  /** More than one does: the engine does not choose between them. */
  | { kind: 'several'; luts: T[] }
  /** None does (or the curve is not known): the job waits for one. */
  | { kind: 'none' };

/** Whether a Camera LUT names `curve` in its name, slug or file name. */
export function cameraLutNamesCurve(lut: CameraLutCandidate, curve: CameraCurveId): boolean {
  if (lut.kind !== 'camera') return false;
  const wanted = BY_ID.get(curve);
  if (wanted === undefined) return false;
  return [lut.name, lut.slug, lut.file ?? ''].some((text) =>
    wanted.pattern.test(text.toLowerCase()),
  );
}

/** The match rule (see the top of the file). An unknown curve (`null`) matches nothing. */
export function matchCameraLuts<T extends CameraLutCandidate>(
  curve: CameraCurveId | null,
  luts: readonly T[],
): CameraLutMatch<T> {
  if (curve === null) return { kind: 'none' };
  const matches = luts.filter((lut) => cameraLutNamesCurve(lut, curve));
  if (matches.length === 0) return { kind: 'none' };
  const [only] = matches;
  return matches.length === 1 && only !== undefined
    ? { kind: 'one', lut: only }
    : { kind: 'several', luts: matches };
}

// --- the sentence -------------------------------------------------------------------------------

/** How the sentence starts: the job's error for a job that waits for a camera LUT. */
export const CAMERA_LUT_WAIT_PREFIX = 'Waiting for a camera LUT:';

/** What the sentence says about the clips when no curve is known. */
const UNKNOWN_CLIPS = 'log footage';

/** The part of the sentence that says more than one camera LUT matched. */
const SEVERAL_TAIL = 'and more than one of your camera LUTs match, so name one in the job’s note';

/** What a job waits for. */
export interface CameraLutWait {
  /** The curve the footage says; `null` when the files do not say. */
  curve: CameraCurveId | null;
  /** The file the curve was read from, when the sentence names it. */
  source: string | null;
  /** More than one of the library's camera LUTs names the curve: the engine did not choose. */
  several: boolean;
}

/** `Waiting for a camera LUT: the clips are Sony S-Log3 (C0003.MP4).` One line, plain text. */
export function cameraLutWaitSentence(wait: {
  curve: CameraCurveId | null;
  source?: string | null;
  several?: boolean;
}): string {
  const clips = wait.curve === null ? UNKNOWN_CLIPS : cameraCurveLabel(wait.curve);
  const source = (wait.source ?? '').replace(/[()\n\r]/g, ' ').trim();
  const named = source === '' || wait.curve === null ? clips : `${clips} (${source})`;
  const tail = wait.several === true && wait.curve !== null ? `, ${SEVERAL_TAIL}` : '';
  return `${CAMERA_LUT_WAIT_PREFIX} the clips are ${named}${tail}.`;
}

/**
 * Reads the sentence back from a job's error text (the editor writes it as its `Blocked:` line; the
 * engine passes it on as the error). Lenient about case, a trailing full stop and anything the
 * editor adds after it; `null` for any other text. The sentence may be preceded by another one
 * ("Finished without a final video: …"), so it is looked for anywhere in the text.
 */
export function parseCameraLutWait(text: string | null | undefined): CameraLutWait | null {
  if (text === null || text === undefined) return null;
  const at = text.toLowerCase().indexOf(CAMERA_LUT_WAIT_PREFIX.toLowerCase());
  if (at < 0) return null;
  const rest = text.slice(at + CAMERA_LUT_WAIT_PREFIX.length).trim();
  const clips = /^the clips are\s+(.+)$/i.exec(rest);
  if (clips === null) return null;
  const body = clips[1] ?? '';
  const several = /\bmore than one\b/i.test(body);
  // The label ends at the first "(", "," or "." that follows it.
  const head = /^([^(,.]*?)\s*(?:\(([^)]*)\))?\s*(?:[,.]|$)/.exec(body);
  const label = (head?.[1] ?? '').trim();
  const source = (head?.[2] ?? '').trim();
  const curve = cameraCurveOfLabel(label);
  return {
    curve,
    source: source === '' || curve === null ? null : source,
    several: several && curve !== null,
  };
}

/**
 * What the dialog and the banner call the LUT being asked for: "a Sony S-Log3 to Rec709 camera
 * LUT", or "a camera LUT for its log footage" when no curve is known.
 */
export function cameraLutAskedFor(wait: Pick<CameraLutWait, 'curve'>): string {
  return wait.curve === null
    ? 'a camera LUT for its log footage'
    : `a ${cameraCurveLabel(wait.curve)} to Rec709 camera LUT`;
}
