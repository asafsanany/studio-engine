// @studio/shared: domain types, schemas and constants used by apps/server and apps/web.
// Consumed as source: no build step. Relative imports use `.ts` so Node's type stripping can load
// them as they are (it does not map `.js` to `.ts`); see tsconfig `rewriteRelativeImportExtensions`.
export * from './brief/index.ts';
export * from './domain/index.ts';
export * from './format.ts';
export * from './home-currency.ts';
export * from './machine.ts';
export * from './releases.ts';
export * from './review/index.ts';
