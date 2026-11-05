import { defineConfig } from 'drizzle-kit';

// `pnpm --filter @studio/server db:generate` writes the migration SQL to ./drizzle (committed).
// The server applies it on boot (src/db/database.ts); nothing here talks to a database.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
