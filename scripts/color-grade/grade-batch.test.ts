import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Runs the Python tests of grade_batch.py (test_grade_batch.py, standard library only) so the
// LUTs page's Cinematic bake and the --look-lut option (a LUT a note names) are covered by the
// same `vitest run` as the rest. Skipped, with the reason in the test's name, when there is no python3.
const here = dirname(fileURLToPath(import.meta.url));
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const hasPython = python.status === 0;

describe('grade_batch.py --bake-look and --look-lut', () => {
  it.skipIf(!hasPython)(
    hasPython
      ? 'passes its Python unit tests'
      : 'passes its Python unit tests (skipped: python3 is not installed)',
    () => {
      const run = spawnSync('python3', ['-I', join(here, 'test_grade_batch.py')], {
        encoding: 'utf8',
        cwd: here,
      });
      expect(run.stderr + run.stdout).toMatch(/OK/);
      expect(run.status).toBe(0);
    },
    60_000,
  );
});
