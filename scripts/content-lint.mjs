/**
 * content-lint — fail on structural MDX defects that render wrong to readers.
 *
 * Usage:
 *   pnpm content:lint                 # human report grouped by rule; exits 1 on any finding
 *   pnpm content:lint --json          # JSON array of findings to stdout; exits 0
 *   pnpm content:lint --rule=A1,A3    # restrict to specific rules
 *   pnpm content:lint --all           # every rule, including one excluded from the default set
 *   node scripts/content-lint.mjs <file.mdx> [file2.mdx ...]  # lint only these files (lint-staged)
 *
 * Rules are documented in scripts/lib/content-lint.mjs. None of these are visible to `types:check`
 * or `build`: MDX is compiled, not type-checked, so an admonition with its body text stranded in a
 * `title=` attribute or a literal `:::caution` line ships silently.
 *
 * The bare command runs `DEFAULT_RULES`, not every rule — see the comment on that constant below
 * for which rule that currently excludes and why.
 */
import { lintContent } from './lib/content-lint.mjs';

const RULE_TITLES = {
  A1: 'empty admonition body (prose likely stranded in title=)',
  A2: 'invalid admonition type',
  A3: 'unconverted Docusaurus ::: directive',
  A4: 'markdown/entity syntax inside a title= attribute',
  A5: 'internal link keeps a .md/.mdx suffix',
  A6: '<Var> inside code renders as a literal tag',
  A7: 'local image src has no file under public/',
  A8: 'link inside a heading nests <a> inside <a>',
  A9: 'hand-written <p> nests inside the paragraph markdown already emits',
  A10: '<tr> is a direct child of <table>',
  A11: '<Var> in a link destination, which never substitutes and never parses as a link',
};

/**
 * A7 is new (FS-2700) and, as of that ticket, not yet clean across the tree: three stylus
 * screenshots in `content/docs/stylus/cli-tools/verify-contracts.mdx` reference local images
 * that were never committed — a pre-existing defect this rule surfaced, not one it introduces.
 * `content:lint` runs with no `--rule` filter in both CI and the pre-commit hook (see CLAUDE.md),
 * so a rule that isn't clean yet must not be in the default set or it blocks on day one. Pass
 * `--rule=A7` (or `--all`) to check it explicitly; once the stylus page is fixed, fold A7 back
 * into `ALL_RULES` below and delete this list.
 */
const ALL_RULES = Object.keys(RULE_TITLES);
const DEFAULT_RULES = ALL_RULES.filter((r) => r !== 'A7');

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const explicitRule = argv
    .find((a) => a.startsWith('--rule='))
    ?.slice('--rule='.length)
    .split(',');
  const only = explicitRule ?? (argv.includes('--all') ? ALL_RULES : DEFAULT_RULES);
  const fileArgs = argv.filter((a) => !a.startsWith('--'));

  const all = lintContent(process.cwd(), fileArgs.length ? { files: fileArgs } : {});
  const findings = all.filter((f) => only.includes(f.rule));

  // Only surface the note when the caller took the implicit default — an explicit --rule=A7 or
  // --all already sees these findings in the report below, and doesn't need to be told about them.
  if (!json && !explicitRule && !argv.includes('--all')) {
    const excludedA7 = all.filter((f) => f.rule === 'A7').length;
    if (excludedA7 > 0) {
      console.error(
        `content-lint: note — ${excludedA7} A7 finding(s) exist but A7 is excluded from the default rule set pending cleanup (see DEFAULT_RULES in this file). Run with --rule=A7 or --all to see them.`,
      );
    }
  }

  if (json) {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  if (findings.length === 0) {
    console.log('content-lint: no structural defects.');
    return;
  }

  const byRule = new Map();
  for (const f of findings) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, []);
    byRule.get(f.rule).push(f);
  }

  const files = new Set(findings.map((f) => f.rel)).size;
  console.error(`content-lint: ${findings.length} finding(s) across ${files} file(s):`);

  // Numeric, not lexicographic: with A10 in the set, a plain sort puts it between A1 and A2.
  const ruleOrder = (r) => Number(r.slice(1));
  for (const rule of [...byRule.keys()].sort((a, b) => ruleOrder(a) - ruleOrder(b))) {
    const group = byRule.get(rule);
    const groupFiles = new Set(group.map((f) => f.rel)).size;
    console.error(`\n  ${rule} — ${RULE_TITLES[rule]}: ${group.length} in ${groupFiles} file(s)`);
    for (const f of group.slice(0, 12)) console.error(`      ${f.rel}:${f.line}  ${f.message}`);
    if (group.length > 12) console.error(`      … ${group.length - 12} more`);
  }

  process.exit(1);
}

main();
