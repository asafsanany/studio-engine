import { readFileSync } from 'node:fs';
import { z } from 'zod';

// src/ and dist/ sit at the same depth, so this resolves to the repo root from either.
const rootPackageUrl = new URL('../../../package.json', import.meta.url);

const rootPackage = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(rootPackageUrl, 'utf8')));

export const version = rootPackage.version;
