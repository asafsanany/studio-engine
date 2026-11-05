// A stand-in for `hyperframes audio <file> --only … --json` (the script runs MUSIC_HYPERFRAMES
// instead of npx): prints the file FAKE_HF_JSON names, or fails with FAKE_HF_EXIT, and says
// something on stderr like the real one does.

import { readFileSync } from 'node:fs';

process.stderr.write('  4 HyperFrames skills out of date or missing.\n');
if (process.env.FAKE_HF_EXIT) process.exit(Number(process.env.FAKE_HF_EXIT));
process.stdout.write(readFileSync(process.env.FAKE_HF_JSON, 'utf8'));
