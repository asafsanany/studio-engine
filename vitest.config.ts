import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      // Every directory under apps/ and packages/ is a Vitest project.
      'apps/*',
      'packages/*',
      '!**/.gitkeep',
      // Repo-level tooling tests (scripts/). Also keeps the project list non-empty,
      // which Vitest requires, while apps/ and packages/ are empty.
      { test: { name: 'root', include: ['scripts/**/*.test.ts'] } },
    ],
  },
});
