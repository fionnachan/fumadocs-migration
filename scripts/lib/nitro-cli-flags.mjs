/**
 * Turn an indexed Nitro source tree into the flag list behind the CLI flags reference page.
 *
 * Two halves:
 *  - `extractFlags` walks the registration tree from `NodeConfigAddOptions`, composing the
 *    dotted flag names the same way Nitro does at runtime (each `…ConfigAddOptions` is handed a
 *    prefix and appends to it).
 *  - the value resolver turns a default expression such as `DefaultBatchPosterConfig.MaxDelay`
 *    into the string pflag would print, by following the `var …Default = T{…}` literal it
 *    points at.
 *
 * Anything the resolver cannot evaluate is reported, never guessed: a reference page with a
 * quietly wrong default is worse than one that fails to build.
 */
import { literalFields, matchDelim, splitArgs } from './go-source.mjs';

/**
 * pflag registration method to the type name `--help` prints.
 *
 * pflag shortens four of its own type names in `UnquoteUsage` (`int64`→`int`, `uint64`→`uint`,
 * `float64`→`float`, `stringSlice`→`strings`) and blanks `bool` entirely. This table reproduces
 * that mapping, keeping `bool` spelled out because a blank cell in the Type column reads as a
 * bug rather than as "boolean".
 */
export const FLAG_TYPES = {
  String: 'string',
  Bool: 'bool',
  Int: 'int',
  Int8: 'int8',
  Int16: 'int16',
  Int32: 'int32',
  Int64: 'int',
  Uint: 'uint',
  Uint8: 'uint8',
  Uint16: 'uint16',
  Uint32: 'uint32',
  Uint64: 'uint',
  Float32: 'float32',
  Float64: 'float',
  Duration: 'duration',
  StringSlice: 'strings',
  IntSlice: 'ints',
  UintSlice: 'uints',
  BoolSlice: 'bools',
  DurationSlice: 'durationSlice',
  StringArray: 'stringArray',
};

/**
 * Go standard-library constants that appear in Nitro's defaults and usage strings. They are not
 * in the indexed tree (the standard library is not vendored), and there are few enough to name.
 */
const STDLIB_CONSTANTS = {
  'math.MaxInt': 9223372036854775807n,
  'math.MaxInt8': 127,
  'math.MaxInt16': 32767,
  'math.MaxInt32': 2147483647,
  'math.MaxInt64': 9223372036854775807n,
  'math.MinInt32': -2147483648,
  'math.MinInt64': -9223372036854775808n,
  'math.MaxUint8': 255,
  'math.MaxUint16': 65535,
  'math.MaxUint32': 4294967295,
  'math.MaxUint64': 18446744073709551615n,
  'math.MaxFloat64': 1.7976931348623157e308,
};

const DURATION_UNITS = {
  Nanosecond: 1n,
  Microsecond: 1000n,
  Millisecond: 1000000n,
  Second: 1000000000n,
  Minute: 60000000000n,
  Hour: 3600000000000n,
};

/** Conversions that do not change the value for our purposes. */
const TRANSPARENT_CASTS = new Set([
  'string',
  'int',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'float32',
  'float64',
  'time.Duration',
]);

/**
 * Walk the flag registration tree.
 *
 * @param {object} input
 * @param {Map} input.dirs indexed packages from `indexGoTree`
 * @param {Map} input.fileImports per-file import maps from `indexGoTree`
 * @param {{ dir: string, func: string }} input.entryPoint where the walk starts
 * @param {Record<string, {type: string, default: string}>} [input.customTypes] `f.Var` overrides
 * @param {Record<string, string>} [input.defaultOverrides] defaults that are not static values
 * @returns {{ flags: Array, problems: string[] }}
 */
export function extractFlags({
  dirs,
  fileImports,
  entryPoint,
  customTypes = {},
  defaultOverrides = {},
}) {
  const flags = [];
  const problems = [];
  const resolver = new ValueResolver(dirs, fileImports, problems);
  const visited = new Set();

  function walk(dir, funcName, prefix, depth, bindings) {
    const key = `${dir}.${funcName} ${prefix}`;
    if (visited.has(key)) return;
    visited.add(key);
    if (depth > 40) {
      problems.push(`registration tree deeper than 40 at ${dir}.${funcName} ("${prefix}")`);
      return;
    }

    const fn = dirs.get(dir)?.funcs.get(funcName);
    if (!fn) {
      problems.push(`flag function ${dir}.${funcName} not found (prefix "${prefix}")`);
      return;
    }
    const imports = fileImports.get(fn.file) ?? new Map();
    const body = fn.body;
    const scope = withLocals(body, dir, bindings);

    for (const call of calls(body)) {
      const { qualifier, name, args } = call;

      if (qualifier === 'f' && FLAG_TYPES[name]) {
        const flag = flagName(args[0], prefix);
        if (flag === null) {
          problems.push(`unreadable flag name ${args[0]} in ${dir}.${funcName}`);
          continue;
        }
        flags.push({
          flag,
          type: FLAG_TYPES[name],
          default:
            defaultOverrides[flag] ??
            resolver.format(args[1], dir, FLAG_TYPES[name], `${flag} default`, scope),
          description: resolver.describe(args[2], dir, prefix, scope, `${flag} description`),
        });
        continue;
      }

      // `f.Var(&value, name, usage)` registers a flag whose type and default live on a custom
      // pflag.Value implementation. Reading those would mean evaluating Go methods, so they are
      // declared in the data file instead and checked here.
      if (qualifier === 'f' && name === 'Var') {
        const flag = flagName(args[1], prefix);
        if (flag === null) {
          problems.push(`unreadable flag name ${args[1]} in ${dir}.${funcName}`);
          continue;
        }
        const override = customTypes[flag];
        if (!override) {
          problems.push(
            `f.Var flag "${flag}" has no entry in customFlagTypes ` +
              `(scripts/data/nitro-cli-reference.data.mjs); add its pflag type and default`,
          );
          continue;
        }
        flags.push({
          flag,
          type: override.type,
          default: override.default,
          description: resolver.describe(args[2], dir, prefix, scope, `${flag} description`),
        });
        continue;
      }

      // A nested `…AddOptions(prefix+".sub", f, …)` call, or one that reuses the same prefix.
      //
      // Anything handed the FlagSet registers flags, so a call this walk cannot follow is a whole
      // namespace missing from the page. Both ways of failing to follow one are reported rather
      // than skipped: silently dropping them is what the hardcoded go-ethereum check in
      // generate-cli-reference.mjs guards against for one known case, and there is no reason the
      // general case should be quieter. Measured against Nitro v3.11.3, neither fires.
      if (!args.includes('f')) continue;
      const targetDir = qualifier ? imports.get(qualifier) : dir;
      if (!targetDir || !dirs.get(targetDir)?.funcs.has(name)) {
        problems.push(
          `registration call ${qualifier ? `${qualifier}.` : ''}${name} in ${dir}.${funcName} ` +
            `("${prefix}") resolves to no indexed package; its flags would be dropped`,
        );
        continue;
      }
      const sub = args[0] === 'f' ? prefix : flagName(args[0], prefix);
      if (sub === null) {
        problems.push(`unreadable prefix ${args[0]} for ${name} in ${dir}.${funcName}`);
        continue;
      }
      walk(targetDir, name, sub, depth + 1, bindArgs(dirs, targetDir, name, args, dir, scope));
    }
  }

  walk(entryPoint.dir, entryPoint.func, '', 0, new Map());
  flags.sort((a, b) => a.flag.localeCompare(b.flag));
  return { flags, problems };
}

/** Every `qualifier.name(args…)` call in a function body, in source order. */
function* calls(body) {
  const re = /(?:(\w+)\.)?(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(body))) {
    const open = m.index + m[0].length - 1;
    const close = matchDelim(body, open);
    if (close === -1) continue;
    yield { qualifier: m[1], name: m[2], args: splitArgs(body.slice(open + 1, close)) };
  }
}

/**
 * Bind a callee's parameters to the expressions the caller passed.
 *
 * Nitro reuses one registration function for several namespaces and hands it the defaults to
 * use: `DataPosterConfigAddOptions(prefix+".data-poster", f, DefaultBatchPosterDataPosterConfig, …)`
 * registers `node.batch-poster.data-poster.*` from one struct and `node.staker.data-poster.*`
 * from another. Without this binding every one of those defaults reads as an unknown identifier.
 *
 * Each binding carries the directory its expression was written in, so a later lookup resolves in
 * the caller's package. An argument that is itself a bound parameter keeps the original binding
 * rather than becoming a name that means nothing one level down.
 */
function bindArgs(dirs, targetDir, targetFunc, args, callerDir, callerScope) {
  const bindings = new Map();
  const params = dirs.get(targetDir)?.funcs.get(targetFunc)?.params ?? [];
  for (let i = 0; i < params.length && i < args.length; i++) {
    const paramName = params[i].trim().split(/\s+/)[0];
    if (!/^\w+$/.test(paramName) || paramName === 'prefix' || paramName === 'f') continue;
    const arg = args[i].trim();
    bindings.set(
      paramName,
      callerScope.get(arg) ?? { expr: arg, dir: callerDir, bindings: callerScope },
    );
  }
  return bindings;
}

/**
 * Add a function's local variables to its scope.
 *
 * go-ethereum's RPC config does `arbDebug := DefaultConfig.ArbDebug` and then registers several
 * flags off `arbDebug`. Treating a local exactly like a bound parameter costs one pass over the
 * body and removes the whole class of "unknown identifier" failures those aliases cause.
 */
function withLocals(body, dir, bindings) {
  const scope = new Map(bindings);
  for (const m of body.matchAll(/(?:^|\n)[ \t]*(\w+)[ \t]*:?=[ \t]*([^\n]+)/g)) {
    const name = m[1];
    if (name === 'prefix' || name === 'f' || scope.has(name)) continue;
    scope.set(name, { expr: m[2].trim(), dir, bindings });
  }
  return scope;
}

/** Resolve a flag-name expression (`prefix`, `prefix+".x"`, or a literal) against the prefix. */
function flagName(expr, prefix) {
  if (expr === undefined) return null;
  const t = expr.trim();
  if (t === 'prefix') return prefix;
  const joined = text(t, prefix);
  return joined ?? null;
}

/**
 * Evaluate a `+`-concatenation of string literals and `prefix`, then collapse whitespace.
 *
 * Nitro splits long usage strings across source lines with `"…\n" + "…"`. Those newlines exist
 * to wrap terminal output; inside a markdown table cell they would break the row, so every run
 * of whitespace becomes a single space.
 */
function text(expr, prefix) {
  if (expr === undefined) return null;
  let out = '';
  for (const part of splitPlus(expr)) {
    const t = part.trim();
    if (t === 'prefix') {
      out += prefix;
      continue;
    }
    const lit = stringLiteral(t);
    if (lit === null) return null;
    out += lit;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Split on `+` at nesting depth 0, quote-aware. */
function splitPlus(src) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === '`') {
      i = skipString(src, i);
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === '+' && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(src.slice(start));
  return parts;
}

function skipString(src, i) {
  const quote = src[i];
  i++;
  while (i < src.length) {
    if (quote !== '`' && src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return i;
}

/** A Go string literal's value, or null when the expression is not one. */
function stringLiteral(expr) {
  const t = expr.trim();
  if (t.startsWith('`') && t.endsWith('`') && t.length >= 2) return t.slice(1, -1);
  if (!(t.startsWith('"') && t.endsWith('"') && t.length >= 2)) return null;
  try {
    return JSON.parse(t);
  } catch {
    return t.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
  }
}

/**
 * Evaluates default-value expressions against the indexed tree.
 *
 * Nearly every Nitro default is a selector into a package-level defaults struct
 * (`DefaultBatchPosterConfig.MaxDelay`), so the work is: follow the selector to a leaf
 * expression, evaluate it, and format it the way pflag would.
 */
class ValueResolver {
  constructor(dirs, fileImports, problems) {
    this.dirs = dirs;
    this.fileImports = fileImports;
    this.problems = problems;
  }

  /**
   * The string pflag prints for this default, or '' when the value is its type's zero.
   *
   * pflag omits `(default …)` from `--help` for zero values, and the page renders an empty
   * default as a dash, so collapsing zeros here keeps a wall of `false` and `0` out of the
   * table without losing information.
   */
  format(expr, dir, type, label, bindings = new Map()) {
    if (expr === undefined) return '';
    const value = this.evaluate(expr, dir, new Set(), bindings);
    if (value === null) {
      this.problems.push(`cannot evaluate ${label}: ${oneLine(expr)}`);
      return '';
    }
    return formatValue(value, type);
  }

  /**
   * @returns {{kind: string, value: any} | null}
   */
  evaluate(expr, dir, seen, bindings = new Map()) {
    const t = expr.trim();
    if (t === '' || t === 'nil') return { kind: 'nil', value: null };

    // `&DefaultClientConfig` and `*cfg`: the address-of and dereference are noise here, and a
    // pointer to a defaults struct is how several registration functions receive theirs.
    if (t.startsWith('&') || t.startsWith('*'))
      return this.evaluate(t.slice(1), dir, seen, bindings);

    // `^uint64(0)`: Go's bitwise complement, used as an "unset" sentinel. BigInt because the
    // result does not survive a double.
    if (t.startsWith('^')) {
      const inner = this.evaluate(t.slice(1), dir, seen, bindings);
      if (inner === null) return null;
      const n = numeric(inner);
      if (n === null) return null;
      return { kind: 'number', value: (2n ** 64n - 1n) ^ BigInt(Math.trunc(n)) };
    }

    // `append(base, "a", "b")`: go-ethereum's default RPC module lists are built this way.
    if (/^append\s*\(/.test(t) && matchDelim(t, t.indexOf('(')) === t.length - 1) {
      const parts = splitArgs(t.slice(t.indexOf('(') + 1, -1));
      const base = this.evaluate(parts[0], dir, seen, bindings);
      if (base === null) return null;
      const head = base.kind === 'slice' ? base.value : [];
      const tail = parts.slice(1).map((item) => this.evaluate(item, dir, seen, bindings));
      if (tail.some((item) => item === null)) return null;
      return { kind: 'slice', value: [...head, ...tail] };
    }

    const str = stringLiteral(t);
    if (str !== null) return { kind: 'string', value: str };

    if (t === 'true' || t === 'false') return { kind: 'bool', value: t === 'true' };

    // Slice and map literals: `[]string{"a", "b"}`, `[]time.Duration{…}`.
    const slice = /^\[\s*\]\s*[\w.]+\s*\{/.exec(t);
    if (slice) {
      const open = t.indexOf('{');
      const end = matchDelim(t, open);
      if (end === -1) return null;
      const items = splitArgs(t.slice(open + 1, end)).map((item) =>
        this.evaluate(item, dir, seen, bindings),
      );
      if (items.some((item) => item === null)) return null;
      return { kind: 'slice', value: items };
    }

    // A conversion such as `uint64(x)` or `time.Duration(0)` is transparent here.
    const cast = /^([\w.]+)\s*\(/.exec(t);
    if (cast && TRANSPARENT_CASTS.has(cast[1]) && matchDelim(t, t.indexOf('(')) === t.length - 1) {
      return this.evaluate(t.slice(t.indexOf('(') + 1, -1), dir, seen, bindings);
    }

    // Parenthesised expression.
    if (t.startsWith('(') && matchDelim(t, 0) === t.length - 1) {
      return this.evaluate(t.slice(1, -1), dir, seen, bindings);
    }

    const arithmetic = this.arithmetic(t, dir, seen, bindings);
    if (arithmetic) return arithmetic;

    if (
      /^[-+]?(?:0[xXbBoO])?[\da-fA-F_]+$/.test(t) ||
      /^[-+]?[\d_]*\.?[\d_]*(?:[eE][-+]?\d+)?$/.test(t)
    ) {
      const n = Number(t.replace(/_/g, ''));
      if (Number.isFinite(n)) return { kind: 'number', value: n };
    }

    return this.selector(t, dir, seen, bindings);
  }

  /** `a * b`, `a + b`, `a - b`, `a / b` over numbers and durations. */
  arithmetic(expr, dir, seen, bindings) {
    // Lowest-precedence operators first, so `a + b * c` splits at the `+`. Byte-size defaults in
    // Nitro are written as shifts (`512 << 10`), which bind tighter than the arithmetic ones.
    for (const op of ['+', '-', '*', '/', '<<', '>>']) {
      const idx = splitOperator(expr, op);
      if (idx === -1) continue;
      const left = this.evaluate(expr.slice(0, idx), dir, seen, bindings);
      const right = this.evaluate(expr.slice(idx + op.length), dir, seen, bindings);
      if (!left || !right) return null;
      const a = numeric(left);
      const b = numeric(right);
      if (a === null || b === null) return null;
      const kind = left.kind === 'duration' || right.kind === 'duration' ? 'duration' : 'number';
      const value =
        op === '+'
          ? a + b
          : op === '-'
            ? a - b
            : op === '*'
              ? a * b
              : op === '/'
                ? b === 0
                  ? 0
                  : a / b
                : op === '<<'
                  ? a * 2 ** b
                  : Math.floor(a / 2 ** b);
      return { kind, value: kind === 'duration' ? Math.round(value) : value };
    }
    return null;
  }

  /** `Ident`, `Ident.Field.Field`, or `pkg.Ident.Field`. */
  selector(expr, dir, seen, bindings = new Map()) {
    const parts = expr.split('.').map((p) => p.trim());
    if (parts.some((p) => !/^\w+$/.test(p))) return null;

    // A parameter the caller supplied: continue in the caller's package.
    const bound = bindings.get(parts[0]);
    if (bound) {
      const substituted = [bound.expr, ...parts.slice(1)].join('.');
      const guard = `bound:${bound.dir}.${substituted}`;
      if (seen.has(guard)) return null;
      seen.add(guard);
      return this.evaluate(substituted, bound.dir, seen, bound.bindings ?? new Map());
    }

    if (parts.length >= 2 && parts[0] === 'time' && DURATION_UNITS[parts[1]] !== undefined) {
      return { kind: 'duration', value: Number(DURATION_UNITS[parts[1]]) };
    }

    const stdlib = STDLIB_CONSTANTS[expr.trim()];
    if (stdlib !== undefined) return { kind: 'number', value: stdlib };

    // A leading lowercase segment that names an import is a package qualifier.
    const imports = this.importsFor(dir);
    let searchDir = dir;
    let rest = parts;
    if (parts.length >= 2 && imports.has(parts[0])) {
      const target = imports.get(parts[0]);
      if (!target) return null;
      searchDir = target;
      rest = parts.slice(1);
    }

    const found = this.lookup(searchDir, rest[0]);
    if (!found) return null;

    const guard = `${found.dir}.${rest.join('.')}`;
    if (seen.has(guard)) return null;
    seen.add(guard);

    let expression = found.entry.expr;
    let currentDir = found.dir;
    for (const field of rest.slice(1)) {
      const next = this.fieldOf(expression, currentDir, field, seen);
      if (next === null) return null;
      if (next === 'zero') return { kind: 'zero', value: null };
      expression = next.expr;
      currentDir = next.dir;
    }
    return this.evaluate(expression, currentDir, seen);
  }

  /**
   * The expression for `field` of a struct-valued expression, `'zero'` when the struct literal
   * simply omits it, or null when the shape is one this reader does not understand.
   *
   * Returning `'zero'` only for a real composite literal is the whole point. Nitro builds some
   * defaults with an immediately-invoked closure that copies a base struct and tweaks fields;
   * treating that closure's braces as a struct literal made every one of its fields look like a
   * deliberate zero, which is how a page of confidently wrong defaults gets published.
   */
  fieldOf(expression, dir, field, seen) {
    const t = expression.trim();

    // func() T { cfg := Base; cfg.Field = v; return cfg }()
    const closure = /^func\s*\(\s*\)\s*[\w.[\]*]*\s*\{/.exec(t);
    if (closure) {
      const open = t.indexOf('{');
      const close = matchDelim(t, open);
      if (close === -1) return null;
      const body = t.slice(open + 1, close);
      const returned = /\breturn\s+(\w+)/.exec(body)?.[1];
      if (!returned) return null;

      const assigned = [
        ...body.matchAll(new RegExp(`(?:^|\\n)\\s*${returned}\\.(\\w+)\\s*=\\s*([^\\n]+)`, 'g')),
      ].filter((m) => m[1] === field);
      if (assigned.length > 0) return { expr: assigned.at(-1)[2].trim(), dir };

      const base = new RegExp(`(?:^|\\n)\\s*${returned}\\s*:?=\\s*([^\\n]+)`).exec(body);
      if (!base) return null;
      return this.fieldOf(base[1].trim(), dir, field, seen);
    }

    // A composite literal: an absent field is Go's zero value.
    if (/^[\w.[\]*]*\{/.test(t)) {
      const fields = literalFields(t);
      return fields.has(field) ? { expr: fields.get(field), dir } : 'zero';
    }

    // An identifier or selector: resolve it, then ask the same question of what it names.
    if (/^[&*]/.test(t)) return this.fieldOf(t.slice(1), dir, field, seen);
    const target = this.resolveIndirect(t, dir, seen);
    if (target) return this.fieldOf(target.expr, target.dir, field, seen);

    const nested = this.selector(t, dir, seen);
    if (nested && (nested.kind === 'zero' || nested.kind === 'nil')) return 'zero';
    return null;
  }

  /**
   * A flag's usage string. Reports rather than blanks when it cannot be read: an empty
   * Description cell is indistinguishable from a flag Nitro genuinely left undocumented.
   */
  describe(expr, dir, prefix, bindings, label) {
    if (expr === undefined) return '';
    const parts = [];
    for (const part of splitPlus(expr)) {
      const t = part.trim();
      if (t === 'prefix') {
        parts.push(prefix);
        continue;
      }
      const lit = stringLiteral(t);
      if (lit !== null) {
        parts.push(lit);
        continue;
      }
      const formatted = this.sprintf(t, dir, prefix, bindings);
      if (formatted !== null) {
        parts.push(formatted);
        continue;
      }
      const value = this.evaluate(t, dir, new Set(), bindings);
      if (value && (value.kind === 'string' || value.kind === 'number')) {
        parts.push(String(value.value));
        continue;
      }
      this.problems.push(`cannot read ${label}: ${oneLine(expr)}`);
      return '';
    }
    return parts.join('').replace(/\s+/g, ' ').trim();
  }

  /** `fmt.Sprintf(format, …)`, supporting the verbs Nitro's usage strings actually use. */
  sprintf(expr, dir, prefix, bindings) {
    const t = expr.trim();
    if (!/^fmt\.Sprintf\s*\(/.test(t)) return null;
    const open = t.indexOf('(');
    if (matchDelim(t, open) !== t.length - 1) return null;

    const args = splitArgs(t.slice(open + 1, -1));
    const format = stringLiteral(args[0]);
    if (format === null) return null;

    const values = args.slice(1).map((arg) => this.evaluate(arg, dir, new Set(), bindings));
    if (
      values.some(
        (v) => v === null || (v.kind !== 'string' && v.kind !== 'number' && v.kind !== 'bool'),
      )
    ) {
      return null;
    }
    let i = 0;
    return format.replace(/%(%|[sdvqtf])/g, (match, verb) => {
      if (verb === '%') return '%';
      const value = values[i++];
      if (value === undefined) return match;
      return verb === 'q' ? JSON.stringify(String(value.value)) : String(value.value);
    });
  }

  /**
   * When a struct field's value is itself a bare identifier pointing at another defaults var
   * (`Dangerous: DefaultDangerousConfig`), follow it so later field lookups keep working.
   */
  resolveIndirect(expr, dir, seen) {
    const t = expr.trim();
    if (!/^[\w.]+$/.test(t) || t.includes('(')) return null;
    const parts = t.split('.');
    const imports = this.importsFor(dir);
    let searchDir = dir;
    let rest = parts;
    if (parts.length >= 2 && imports.has(parts[0])) {
      const target = imports.get(parts[0]);
      if (!target) return null;
      searchDir = target;
      rest = parts.slice(1);
    }
    if (rest.length !== 1) return null;
    const found = this.lookup(searchDir, rest[0]);
    if (!found || !found.entry.expr.includes('{')) return null;
    if (seen.has(`indirect:${found.dir}.${rest[0]}`)) return null;
    seen.add(`indirect:${found.dir}.${rest[0]}`);
    return { expr: found.entry.expr, dir: found.dir };
  }

  lookup(dir, name) {
    const entry = this.dirs.get(dir);
    if (!entry) return null;
    if (entry.vars.has(name)) return { dir, entry: entry.vars.get(name) };
    if (entry.consts.has(name)) return { dir, entry: entry.consts.get(name) };
    return null;
  }

  /** Union of the import maps of every file in a directory; aliases are consistent in practice. */
  importsFor(dir) {
    if (!this._importCache) this._importCache = new Map();
    if (this._importCache.has(dir)) return this._importCache.get(dir);
    const merged = new Map();
    const entry = this.dirs.get(dir);
    const files = new Set(
      [...(entry?.vars.values() ?? []), ...(entry?.consts.values() ?? [])].map((v) => v.file),
    );
    for (const fn of entry?.funcs.values() ?? []) files.add(fn.file);
    for (const file of files) {
      for (const [alias, target] of this.fileImports.get(file) ?? []) {
        if (!merged.has(alias)) merged.set(alias, target);
      }
    }
    this._importCache.set(dir, merged);
    return merged;
  }
}

/** Index of the last occurrence of a binary operator at depth 0, so evaluation is left-assoc. */
function splitOperator(src, op) {
  let depth = 0;
  let i = 0;
  let last = -1;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === '`') {
      i = skipString(src, i);
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    // `i > 0` keeps a leading sign from reading as a binary operator.
    else if (depth === 0 && i > 0 && src.startsWith(op, i)) {
      last = i;
      i += op.length;
      continue;
    }
    i++;
  }
  return last;
}

function numeric(value) {
  if (value.kind === 'number' || value.kind === 'duration') {
    return typeof value.value === 'bigint' ? Number(value.value) : value.value;
  }
  if (value.kind === 'zero' || value.kind === 'nil') return 0;
  return null;
}

/** Format an evaluated value the way pflag's `Value.String()` would, '' for a zero value. */
export function formatValue(value, type) {
  if (value.kind === 'nil' || value.kind === 'zero') return '';

  if (type === 'duration') {
    const ns = numeric(value);
    return ns ? formatDuration(ns) : '';
  }
  if (type === 'bool') return value.value === true ? 'true' : '';
  if (value.kind === 'slice') {
    if (value.value.length === 0) return '';
    const items = value.value.map((item) =>
      item.kind === 'duration' ? formatDuration(item.value) : String(item.value ?? ''),
    );
    return `[${items.join(',')}]`;
  }
  if (value.kind === 'string') return value.value;
  if (value.kind === 'number') {
    if (value.value === 0 || value.value === 0n) return '';
    return formatNumber(value.value);
  }
  if (value.kind === 'bool') return value.value ? 'true' : '';
  return '';
}

/** Go prints floats with `strconv.FormatFloat(f, 'g', -1, 64)`; integers print plainly. */
function formatNumber(n) {
  if (typeof n === 'bigint') return String(n);
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  const exponent = Math.floor(Math.log10(Math.abs(n)));
  if (exponent < -4 || exponent >= 21) {
    return n.toExponential().replace(/e([+-])(\d)$/, 'e$10$2');
  }
  return String(n);
}

/**
 * Go's `time.Duration.String()`: sub-second durations use ns/µs/ms, anything longer is
 * `1h2m3s` with every larger unit present once one is (`30m0s`, not `30m`).
 */
export function formatDuration(ns) {
  if (ns === 0) return '0s';
  const sign = ns < 0 ? '-' : '';
  let n = Math.abs(ns);

  if (n < 1000) return `${sign}${trim(n)}ns`;
  if (n < 1e6) return `${sign}${trim(n / 1000)}µs`;
  if (n < 1e9) return `${sign}${trim(n / 1e6)}ms`;

  const hours = Math.floor(n / 3.6e12);
  n -= hours * 3.6e12;
  const minutes = Math.floor(n / 6e10);
  n -= minutes * 6e10;
  const seconds = n / 1e9;

  let out = `${trim(seconds)}s`;
  if (hours || minutes) out = `${minutes}m${out}`;
  if (hours) out = `${hours}h${out}`;
  return sign + out;
}

/** Drop a trailing `.0…` the way Go's duration formatter does. */
function trim(value) {
  return String(Number(value.toFixed(9)));
}

function oneLine(expr) {
  return expr.replace(/\s+/g, ' ').trim().slice(0, 120);
}
