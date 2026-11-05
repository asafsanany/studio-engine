import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { graphicSamplePlugin } from './dev-graphic-sample.ts';
import { previewSamplePlugin } from './dev-preview-sample.ts';
import { createApiProxy } from './dev-proxy.ts';

// The app version is the root package.json's, injected at build time as __APP_VERSION__
// (see src/globals.d.ts and src/lib/version.ts).
const rootPackage = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

// The Studio Engine server (apps/server) listens here. `STUDIO_API_TARGET` points a throwaway dev
// server at another one (a seed server on a spare port, for example); nothing sets it normally.
const API_TARGET = process.env.STUDIO_API_TARGET ?? 'http://127.0.0.1:4310';

const apiProxy = createApiProxy(API_TARGET);

// Dev only: the sample composition the review player plays on /components.
const PREVIEW_SAMPLE_DIR = fileURLToPath(
  new URL('../server/src/pipeline/testdata/preview/', import.meta.url),
);

// Dev only: the canned graphic the Graphics preview plays on /components (CVP-267), with the sample
// frames and GSAP from the engine's assets and the host page from the engine's own source.
const GRAPHIC_SAMPLE_PATHS = {
  sampleDir: fileURLToPath(
    new URL('../server/src/graphics/testdata/host-sample/', import.meta.url),
  ),
  assetsDir: fileURLToPath(new URL('../server/assets/graphics/', import.meta.url)),
  hostModule: fileURLToPath(new URL('../server/src/graphics/graphic-host.ts', import.meta.url)),
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    previewSamplePlugin(PREVIEW_SAMPLE_DIR),
    graphicSamplePlugin(GRAPHIC_SAMPLE_PATHS),
  ],
  define: { __APP_VERSION__: JSON.stringify(rootPackage.version) },
  resolve: { tsconfigPaths: true },
  // `.ts.net`: the phone opens the dev server through Tailscale Serve (README › Open it on your
  // phone). Vite still listens on localhost only, and the engine behind /api checks the tailnet
  // login itself.
  server: { port: 5173, strictPort: true, proxy: apiProxy, allowedHosts: ['.ts.net'] },
  preview: { proxy: apiProxy },
});
