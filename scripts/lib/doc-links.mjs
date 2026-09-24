// Temporary shim for the mjs-to-TypeScript conversion: four files in other clusters still import
// `./doc-links.mjs`. Phase 3 flips those specifiers to `.ts` and deletes this file.
export * from './doc-links.ts';
