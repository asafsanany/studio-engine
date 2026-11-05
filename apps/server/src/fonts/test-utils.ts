// Test helpers for the Fonts tests (not part of the server build, see tsconfig.build.json): the
// same example data as packages/shared's fixtures (Heebo, Karantina, "Gotham Bold" asked for by
// Horizon FPV), and a Fonts service whose methods a test replaces one by one.

import type {
  FontFaceInfo,
  FontFamilyDetail,
  FontFamilySummary,
  FontRequest,
  FontStageItem,
} from '@studio/shared';
import { createDisabledFontService, type FontService } from './font-service.js';

/** Heebo Bold, one of nine faces in one file. */
export function makeFontFace(overrides: Partial<FontFaceInfo> = {}): FontFaceInfo {
  return {
    name: 'Heebo Bold',
    family: 'Heebo',
    weight: 700,
    italic: false,
    fileId: '3f9a1c7e5b20',
    bytes: 46_000,
    format: 'ttf',
    ...overrides,
  };
}

/** Heebo: Hebrew + English, Sans, all nine weights, used by 14 jobs. */
export function makeFontFamilySummary(
  overrides: Partial<FontFamilySummary> = {},
): FontFamilySummary {
  return {
    slug: 'heebo',
    name: 'Heebo',
    he: true,
    style: 'Sans',
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    weightsLabel: '9 weights',
    used: 14,
    usedLabel: '14 jobs',
    addedAt: '2026-10-22T10:07:00.000Z',
    isNew: false,
    ...overrides,
  };
}

/** {@link makeFontFamilySummary} with its pane's fields: one Bold face of one file. */
export function makeFontFamilyDetail(overrides: Partial<FontFamilyDetail> = {}): FontFamilyDetail {
  return {
    ...makeFontFamilySummary(),
    faces: [makeFontFace()],
    files: 9,
    bytes: 420_000,
    usedIn: 14,
    ...overrides,
  };
}

/** A note of the job "Horizon FPV" asked for Gotham Bold, which the library does not have. */
export function makeFontRequest(overrides: Partial<FontRequest> = {}): FontRequest {
  return {
    id: 'a3c19e0b7d44',
    name: 'Gotham Bold',
    jobId: 'a1b2c3d4e5f6',
    jobName: 'Horizon FPV',
    round: 1,
    at: '2026-10-24T09:30:00.000Z',
    ...overrides,
  };
}

/** A new family in an import, three files of Hebrew + English. */
export function makeFontStageItem(overrides: Partial<FontStageItem> = {}): FontStageItem {
  return {
    id: 'karantina',
    name: 'Karantina',
    files: 3,
    he: true,
    weights: [300, 400, 700],
    bytes: 210_000,
    status: 'new',
    info: '3 files · Hebrew + English · 0.2 MB',
    ...overrides,
  };
}

/**
 * A Fonts service for a route test: it refuses like the disabled one (404 "Fonts are off.") for
 * every method the test does not replace, and says it is on.
 */
export function fakeFontService(overrides: Partial<FontService> = {}): FontService {
  return { ...createDisabledFontService(), enabled: true, ...overrides };
}
