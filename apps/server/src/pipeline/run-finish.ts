import type { RunKind } from '@studio/shared';

/**
 * How a run ends (Phase 3 §2, §3): `final` delivers edit/final.mp4, which the worker exports
 * (SUCCEED, ready); `preview` leaves a live composition in edit/preview/ (PREVIEW_READY, review).
 */
export type RunFinish = 'final' | 'preview';

/**
 * A revise run always ends in a preview, and a render run in final.mp4. An edit run ends in a
 * preview only while the Review switch is on; off, it delivers final.mp4 as before Phase 3. The
 * same rule as the machine's (`runKindAllows` in packages/shared/src/machine.ts).
 */
export function runFinishOf(kind: RunKind, review: boolean): RunFinish {
  if (kind === 'revise') return 'preview';
  if (kind === 'render') return 'final';
  return review ? 'preview' : 'final';
}
