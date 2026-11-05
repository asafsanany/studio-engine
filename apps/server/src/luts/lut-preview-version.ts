// What goes after `?v=` on a preview still's address (LUTs plan, "Previews"). OWNER: LU2. Its own
// file so the repository can use it without pulling in the preview makers.

import { createHash } from 'node:crypto';
import type { LutKind } from '@studio/shared';

/**
 * 8 hex characters of a hash of the LUT's file *and* its kind (marking a LUT Camera changes what
 * its stills show, so the address must change too). The server lets a still whose address has the
 * current one be cached for good; the page gets it as the summary's `previewKey`. `null` when the
 * file's hash is not known.
 */
export function lutPreviewVersion(sha256: string | null, kind: LutKind): string | null {
  if (sha256 === null || !/^[0-9a-f]{8,}$/i.test(sha256)) return null;
  return createHash('sha256').update(`${sha256.toLowerCase()}:${kind}`).digest('hex').slice(0, 8);
}
