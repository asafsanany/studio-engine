// Fonts for the pane's tests, shaped like the real library (~/Studio Inbox/_Fonts): Heebo has
// Hebrew and nine weights, Poppins has no Hebrew, Secular One has one weight. Every face is its own
// file, the way the library's static fonts are.

import { type FontFaceInfo, type FontFamilyDetail, faceName, familySlug } from '@studio/shared';
import { makeFontFace, makeFontFamilyDetail } from '@/data/test-utils';

const ALL_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

/** One static file per weight, named after the family and the weight. */
export function facesOf(
  family: string,
  weights: readonly number[],
  bytes = 46_000,
  italic = false,
): FontFaceInfo[] {
  const slug = familySlug(family);
  return weights.map((weight) =>
    makeFontFace({
      name: faceName(family, weight, italic),
      family,
      weight: weight as FontFaceInfo['weight'],
      italic,
      fileId: `${slug}-${weight}${italic ? 'i' : ''}`,
      bytes,
      version: '1761350400000',
    }),
  );
}

/** A family of static files. */
export function familyDetail(
  name: string,
  weights: readonly number[],
  overrides: Partial<FontFamilyDetail> = {},
  fileBytes = 46_000,
): FontFamilyDetail {
  const faces = facesOf(name, weights, fileBytes);
  return makeFontFamilyDetail({
    slug: familySlug(name),
    name,
    weights: weights as FontFamilyDetail['weights'],
    weightsLabel: weights.length === 1 ? '1 weight' : `${weights.length} weights`,
    faces,
    files: faces.length,
    bytes: faces.reduce((sum, face) => sum + face.bytes, 0),
    ...overrides,
  });
}

/** Heebo: Sans, Hebrew + English, all nine weights, 0.4 MB, used in 14 jobs. */
export const heeboDetail = (overrides: Partial<FontFamilyDetail> = {}) =>
  familyDetail('Heebo', ALL_WEIGHTS, { he: true, style: 'Sans', usedIn: 14, ...overrides });

/** Poppins: Sans, English only, all nine weights, used in 2 jobs. */
export const poppinsDetail = (overrides: Partial<FontFamilyDetail> = {}) =>
  familyDetail(
    'Poppins',
    ALL_WEIGHTS,
    { he: false, style: 'Sans', used: 2, usedLabel: '2 jobs', usedIn: 2, ...overrides },
    150_000,
  );

/** Secular One: Display, Hebrew + English, one weight (Regular). */
export const secularOneDetail = (overrides: Partial<FontFamilyDetail> = {}) =>
  familyDetail('Secular One', [400], { he: true, style: 'Display', usedIn: 3, ...overrides });
