/**
 * Renders the app icon (scripts/app-icon.svg) into the four PNGs the Home Screen app needs, in
 * apps/web/public:
 *
 *   apple-touch-icon.png      180   what iOS puts on the Home Screen. Full square: iOS rounds it.
 *   icon-192.png, icon-512.png      the manifest's icons, with the rounded corners transparent
 *   icon-maskable-512.png     512   full square, for Android's masks (the mark stays inside the
 *                                   safe circle)
 *
 * Run it again after changing the drawing:
 *
 *   node scripts/make-app-icons.ts
 *
 * It draws with Google Chrome as installed (the same one `pnpm e2e` uses, nothing is downloaded),
 * so it has no dependencies of its own. The icons are cached for a month (apps/server/src/static.ts):
 * a redrawn icon reaches an open browser after that, and a Home Screen only takes a new one when
 * the app is added again.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE = join(ROOT, 'scripts', 'app-icon.svg');
const OUTPUT_DIR = join(ROOT, 'apps', 'web', 'public');

/** The icon's blue, which a full-square icon shows in the corners the rounded drawing leaves. */
const BLUE = '#2563EB';

interface IconFile {
  file: string;
  size: number;
  /** Corners filled with the blue (the OS rounds or masks it), not left transparent. */
  fullSquare: boolean;
}

const ICON_FILES: readonly IconFile[] = [
  { file: 'apple-touch-icon.png', size: 180, fullSquare: true },
  { file: 'icon-192.png', size: 192, fullSquare: false },
  { file: 'icon-512.png', size: 512, fullSquare: false },
  { file: 'icon-maskable-512.png', size: 512, fullSquare: true },
];

async function main(): Promise<void> {
  const svg = readFileSync(SOURCE, 'utf8');
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    for (const { file, size, fullSquare } of ICON_FILES) {
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      const background = fullSquare ? BLUE : 'transparent';
      await page.setContent(
        `<!doctype html><style>html,body{margin:0;background:${background}}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
      );
      const png = await page.screenshot({
        clip: { x: 0, y: 0, width: size, height: size },
        omitBackground: !fullSquare,
      });
      await page.close();
      writeFileSync(join(OUTPUT_DIR, file), png);
      console.log(`${join('apps/web/public', file)}  ${size}×${size}`);
    }
  } finally {
    await browser.close();
  }
}

await main();
