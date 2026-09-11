/**
 * faq-data — cross-check `<FAQStructuredDataJsonLd faqsId>` usages in `content/docs` against the
 * static JSON files in `components/mdx/FAQStructuredData/data/`.
 *
 * `FAQStructuredData` (see `components/mdx/FAQStructuredData/index.tsx`) resolves `faqsId`
 * through a static `Record<FaqsId, FAQ[]>` and throws on an unknown id, but MDX content is never
 * type-checked against that union — a typo in a page's `faqsId` attribute would only surface when
 * someone requests that page. This module makes the check static instead: every `faqsId` written
 * in `content/docs` must have a same-named `<id>-faqs.json` data file, and every data file must
 * parse as a non-empty array of `{ question, answer, key }` string triples.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Match `<FAQStructuredDataJsonLd faqsId="...">` (either quote style) in one MDX source string. */
const FAQS_ID_RE = /<FAQStructuredDataJsonLd\b[^>]*\bfaqsId\s*=\s*["']([^"']+)["']/g;

/** Extract every `faqsId` usage from one MDX file's source, with 1-based line numbers. */
export function extractFaqsIdUsages(source) {
  const usages = [];
  for (const match of source.matchAll(FAQS_ID_RE)) {
    const line = source.slice(0, match.index).split('\n').length;
    usages.push({ id: match[1], line });
  }
  return usages;
}

/** Recursively list `.mdx` file paths under `dir`, relative to `dir`. */
export function listMdxFiles(dir) {
  const results = [];
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const entryAbs = path.join(abs, entry.name);
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(entryAbs, entryRel);
      } else if (entry.name.endsWith('.mdx')) {
        results.push(entryRel);
      }
    }
  };
  walk(dir, '');
  return results.sort();
}

/**
 * Validate a parsed FAQ data file's shape. Returns an array of human-readable issue strings;
 * empty means the file is well-formed.
 */
export function validateFaqEntries(data) {
  if (!Array.isArray(data)) return ['data is not an array'];
  if (data.length === 0) return ['data array is empty'];

  const issues = [];
  const seenKeys = new Set();
  data.forEach((entry, i) => {
    for (const field of ['question', 'answer', 'key']) {
      if (typeof entry?.[field] !== 'string' || entry[field].length === 0) {
        issues.push(`entry ${i}: "${field}" is not a non-empty string`);
      }
    }
    if (typeof entry?.key === 'string') {
      if (seenKeys.has(entry.key)) issues.push(`entry ${i}: duplicate key "${entry.key}"`);
      seenKeys.add(entry.key);
    }
  });
  return issues;
}

/**
 * Full check: scan `docsRoot` for `faqsId` usages, scan `dataDir` for `<id>-faqs.json` files, and
 * report every mismatch. All filesystem access happens here; `extractFaqsIdUsages` and
 * `validateFaqEntries` above stay pure and unit-testable on fixtures.
 */
export function checkFaqData({ docsRoot, dataDir }) {
  const usagesById = new Map(); // id -> [{ rel, line }]
  for (const rel of listMdxFiles(docsRoot)) {
    const source = readFileSync(path.join(docsRoot, rel), 'utf8');
    for (const { id, line } of extractFaqsIdUsages(source)) {
      if (!usagesById.has(id)) usagesById.set(id, []);
      usagesById.get(id).push({ rel, line });
    }
  }

  const dataFiles = readdirSync(dataDir).filter((f) => f.endsWith('-faqs.json'));
  const idsWithDataFile = new Set(dataFiles.map((f) => f.replace(/-faqs\.json$/, '')));

  const missingDataFile = [...usagesById.keys()]
    .filter((id) => !idsWithDataFile.has(id))
    .sort()
    .map((id) => ({ id, sites: usagesById.get(id) }));

  const malformed = [];
  for (const file of dataFiles) {
    const id = file.replace(/-faqs\.json$/, '');
    const abs = path.join(dataDir, file);
    let issues;
    try {
      issues = validateFaqEntries(JSON.parse(readFileSync(abs, 'utf8')));
    } catch (err) {
      issues = [`invalid JSON: ${err.message}`];
    }
    if (issues.length > 0) malformed.push({ id, file, issues });
  }

  const unusedDataFile = [...idsWithDataFile].filter((id) => !usagesById.has(id)).sort();

  return { usagesById, missingDataFile, malformed, unusedDataFile };
}
