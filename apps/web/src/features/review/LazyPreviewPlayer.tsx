import { lazy } from 'react';

/**
 * PreviewPlayer, loaded on first use: the player and its runtime (about 640 kB) stay out of the Jobs
 * page's main bundle and have their own chunks. Nothing else in the app may import `./PreviewPlayer`
 * statically (the dev gallery may; it is dev-only). React 19 passes `ref` through a lazy function
 * component as a prop, so `ref={playerRef}` still reaches the player's handle.
 */
export const LazyPreviewPlayer = lazy(() =>
  import('./PreviewPlayer').then((module) => ({ default: module.PreviewPlayer })),
);
