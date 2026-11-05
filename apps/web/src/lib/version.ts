/** App version (X.Y.Z), injected from the root package.json at build time (vite.config.ts). */
export const APP_VERSION: string = __APP_VERSION__;

/** How the version is shown in the sidebar footer, e.g. `v0.1.0`. */
export const APP_VERSION_LABEL = `v${APP_VERSION}`;
