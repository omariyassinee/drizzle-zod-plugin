# Hybrid Plan: Declarative Error Maps for `refineSchema`

Target: `@vacuus/drizzle-validators` (Zod 4 only). Status: implementation-ready specification. Synthesised from four plans; every non-trivial claim was checked against Zod 4.0.17, 4.4.3 and 4.6.7 and against TypeScript 5.9.3 and 7.0.2. A runtime prototype of the dispatch passes 34 of 34 assertions on all three Zod versions, and the type layer compiles with positive and negative cases.

## 1. Verdict on the four plans

Weights: Zod 4 correctness 30 %, type safety 20 %, codebase fit 20 %, edge cases and tests 15 %, actionability 15 %. Scores are out of 10.

| Plan | Correctness | Types | Fit | Tests | Action | Total |
| :-- | :-: | :-: | :-: | :-: | :-: | :-: |
| R · refine-schema-error-mapping-plan | 7 | 6 | 8 | 8 | 4 | 6.7 |
| I · error\_handling\_implementation\_plan | 8 | 3 | 6 | 7 | 9 | 6.6 |
| M · error-map-architecture | 4 | 8 | 8 | 8 | 6 | 6.5 |
| D · declarative-error-handling-architecture | 3 | 6 | 4 | 6 | 7 | 4.9 |

No plan wins outright: the first three are separated by 0.2 points and each lacks something another has. Plan D is clearly last.

Defects that decided the scores (all verified):

- **R:** `SchemaErrorMap` ends with a `[field: string]` index signature, so a typo such as `{ emial: ... }` compiles (tsc-verified). Design only, no code. Keeps the misspelt `FieldErorMapForCore` “for compatibility”.
- **I:** key typing is deliberately not core-aware (an `email` key is legal on a number). Its `setErrorOnField` rewrite recurses into `def.element`, which the current code forbids on purpose (`tags: [123]` would report the field-level message).
- **M:** the def-level handler returns one static, code-agnostic message; no key ever reaches root formats such as `z.email()`; `invalid_enum_value` is Zod 3; `multiple_of` is mapped to `invalid_value` (Zod 4 emits `not_multiple_of`); the getter probe on `def.error` solves a problem that does not exist.
- **D:** its Valibot and TypeBox adapters contradict the README (`refineSchema` is Zod-only); its flagship `.as(z.email())` plus `email` key example never applies at runtime; the Valibot algorithm mutates (`pipe[0].message = ...`) while claiming zero mutation; unknown map fields are silently ignored.

What the hybrid takes: **R** vocabulary, precedence and scope discipline; **I** runtime structure, `required`/`null`, function messages and test matrix; **M** strict per-core types, the precedence ladder, idempotence and phasing; **D** the chained-layer scenario and the i18n use case.

## 2. Verified facts the plans missed

1. **Zod version split.** Up to 4.4.3 a schema-level `def.error` covers only issues raised by that schema itself; checks need their own `error`. From 4.6 it also acts as a fallback for its checks’ issues, but a check-level `error` still wins. Per-check cloning is therefore mandatory for the `^4.0.0` peer range. No plan mentions this.
2. **Root format schemas.** `z.email()`, `z.url()`, `z.uuid()` and `z.int()` have no `checks`; their format error lives on the core def. The README’s `.as(z.email())` pattern depends on them, so core-level dispatch must handle `invalid_format`.
3. **`.int()` is not an `invalid_format`.** Both `.int()` and `z.int()` emit `invalid_type` with `format: 'safeint'`. Dispatching on the issue code alone shows the type message for a decimal. Check issues are dispatched on `checkDef.check` and `format`; core issues on `code`, `input` and `format`.
4. **Raw issues carry `input`.** Error functions receive the raw issue (with `input` and `inst`), so `required` (undefined) and `null` keys are implementable. On 4.6 messages are evaluated lazily, when `.message` is read.
5. **No accessor on `def.error`.** It is `undefined` or a plain function; no getter probe and no `def.message` are needed.
6. **Type-level trap.** `ZodEmail` and `ZodUUID` do not extend `ZodString` (they extend `ZodStringFormat`); `ZodNumberFormat` does extend `ZodNumber`. Core detection must test `ZodString | ZodStringFormat`, otherwise the flagship pattern loses every string key.
7. **Dead format keys.** Four of the 23 `STRING_FORMAT_NAMES` (`httpUrl`, `uuidv4`, `uuidv6`, `uuidv7`) are never emitted: Zod reports `url` and `uuid`. Keys must follow emitted `def.format` values.
8. **Argument order is a style choice, not an inference constraint.** With a non-generic map parameter, map-first also compiles and still rejects typos and stale keys. Keep callback-first because the existing call stays a strict prefix of the new one.
9. **`setErrorOnField` does not recurse into `def.element`**, deliberately. The new code must not either.
10. **README and code disagree.** The README shows `(fields, z) => ...`; `refine.ts` calls the callback with one argument. Reconcile this before touching the overloads.

## 3. Scope

**In:** Zod `refineSchema` with `(schema, map)` and `(schema, callback, map)`.

**Out of v1:** Valibot and TypeBox (own specification), object-level entries (`_object`), nested or dotted keys, element-level maps, `setError(map)` (Plan I, pattern 3), `gt/gte/lt/lte` distinctions, `number_format` variants other than `safeint`.

## 4. Public API

```ts
// 1. Map only
export const userInsert = refineSchema(insertSchema, {
  name: 'Please enter a name',                    // shorthand for { default }
  email: { required: 'Email is required', email: 'Enter a valid email', max: 'Too long' },
  age: { int: 'Whole numbers only', min: (iss) => `Minimum age is ${iss.minimum}` },
});

// 2. Callback + map (callback first)
export const register = refineSchema(
  insertSchema,
  (fields) => ({
    email: fields.email.as(z.email()),
    age: fields.age.min(18, { error: 'Adults only' }), // inline error: always wins
    confirmPassword: z.string().min(8),                // added field: legal map key
  }),
  {
    email: { required: 'Email is required', email: 'Enter a valid email' },
    age: { min: 'Fallback; never shown for min(18)' },
    confirmPassword: { required: 'Please confirm', min: 'At least 8 characters' },
  },
);
```

```ts
// Overloads: callback overloads first, map-only last
export function refineSchema<T extends z.ZodObject<any>, R extends RefinementCallbackResult<T['shape']>>(
  base: T, fn: (fields: RefinableShape<T['shape']>) => R,
): z.ZodObject<RefinedShapeOf<T['shape'], R>>;              // existing, unchanged
export function refineSchema<T extends z.ZodObject<any>, R extends RefinementCallbackResult<T['shape']>>(
  base: T, fn: (fields: RefinableShape<T['shape']>) => R,
  errorMap: SchemaErrorMap<RefinedShapeOf<T['shape'], R>>,
): z.ZodObject<RefinedShapeOf<T['shape'], R>>;
export function refineSchema<T extends z.ZodObject<any>>(
  base: T, errorMap: SchemaErrorMap<T['shape']>,
): z.ZodObject<T['shape']>;
```

`RefinedShapeOf` is the existing return-type expression extracted into an alias (a pure type refactor). Overload order was tested and is harmless even when the table has a `name` column.

Rules:

- A string or function entry is shorthand for `{ default }`. It is a fallback, never an override.
- An `undefined` entry or value is absent; an empty string is a valid message.
- An unknown field in the map throws a `DrizzleValidatorsError` naming the field and listing the known ones (both overloads).
- `(schema, map, callback)` throws an actionable error: the callback must come before the error map.

## 5. Keys and resolution

| Key | Matches |
| :-- | :-- |
| `required` | `invalid_type` with `input === undefined` |
| `null` | `invalid_type` with `input === null` |
| `invalid_type` | any other type mismatch (not `.int()` decimals) |
| `invalid_value` | enum, literal |
| `min`, `max` | `min_length`, `greater_than` / `max_length`, `less_than` (string, number, bigint, date, array, set) |
| `length` | `length_equals`, too short or too long |
| `int` | `.int()` and `z.int()` (format `safeint`) |
| `multiple_of` | `multiple_of` |
| `format` | any string format |
| `email`, `url`, `uuid`, … | one emitted `def.format` name (see fact 7) |
| `regex`, `starts_with`, `ends_with`, `includes` | the matching string checks |
| `custom` | `.refine()` and custom checks without their own message |
| `unrecognized_keys`, `invalid_union` | object and union cores |
| `too_small`, `too_big`, `invalid_format`, `not_multiple_of` | general (issue-code) form of the keys above |
| `default` | everything unmatched on the field |

Resolution per issue: specific key, then issue-code key, then `default`, then Zod’s native message. A message function that returns `undefined` falls through to the next candidate.

## 6. Types

Compiled and tested on TypeScript 5.9.3 and 7.0.2 (typos, wrong key per core, `int` on bigint, `min` on enum, stale key after a type swap, callback-added field, `.as(z.email())` string keys, `z.int()` number keys, typed message function).

```ts
const EMITTED_STRING_FORMATS = ['email','url','uuid','guid','cuid','cuid2','ulid','emoji','nanoid',
  'jwt','ipv4','ipv6','cidrv4','cidrv6','base64','base64url','xid','ksuid','e164'] as const;
type StringFormatKey = (typeof EMITTED_STRING_FORMATS)[number];

export type ErrorMessage = string | ((issue: z.core.$ZodRawIssue) => string | undefined);
type M = ErrorMessage;

interface CommonKeys { default?: M; required?: M; null?: M; invalid_type?: M; custom?: M }
interface BoundKeys { min?: M; max?: M; too_small?: M; too_big?: M }
export interface StringErrorKeys extends CommonKeys, BoundKeys {
  length?: M; format?: M; invalid_format?: M; regex?: M; starts_with?: M; ends_with?: M; includes?: M }
export interface NumberErrorKeys extends CommonKeys, BoundKeys { int?: M; multiple_of?: M; not_multiple_of?: M }
export interface BigIntErrorKeys extends CommonKeys, BoundKeys { multiple_of?: M; not_multiple_of?: M }
export interface SizedErrorKeys extends CommonKeys, BoundKeys { length?: M }          // array, set
export interface DateErrorKeys extends CommonKeys, BoundKeys {}
export interface ChoiceErrorKeys extends CommonKeys { invalid_value?: M }              // enum, literal
export interface ObjectErrorKeys extends CommonKeys { unrecognized_keys?: M }
export interface GenericErrorKeys extends CommonKeys { invalid_value?: M; invalid_union?: M }

// DeepUnwrap: the existing helper in refine.ts
export type CoreErrorMap<C> =
  [C] extends [z.ZodString | z.ZodStringFormat] ? StringErrorKeys & { [K in StringFormatKey]?: M } :
  [C] extends [z.ZodNumber] ? NumberErrorKeys :
  [C] extends [z.ZodBigInt] ? BigIntErrorKeys :
  [C] extends [z.ZodDate] ? DateErrorKeys :
  [C] extends [z.ZodArray<any> | z.ZodSet<any>] ? SizedErrorKeys :
  [C] extends [z.ZodEnum<any> | z.ZodLiteral<any>] ? ChoiceErrorKeys :
  [C] extends [z.ZodObject<any>] ? ObjectErrorKeys :
  GenericErrorKeys;

export type FieldErrorEntry<F extends z.ZodTypeAny> = ErrorMessage | CoreErrorMap<DeepUnwrap<F>>;

// No index signature and no Record<string, ...> fallback: both would disable typo detection.
export type SchemaErrorMap<S extends Record<string, z.ZodTypeAny>> = {
  [K in keyof S]?: FieldErrorEntry<S[K]>;
};
```

## 7. Runtime

Validated as a JavaScript prototype (34 of 34 assertions on Zod 4.0.17, 4.4.3 and 4.6.7). The production version reuses `unwrapAll`, `applyWrappers`, `cloneSchemaWithDef`, `cloneZodCheck` and `rebuildZodObject`. Style: adapt to the repository (tabs, double quotes).

```ts
// zod-compat.ts
export const FALLBACK = Symbol.for('drizzle-validators.fallback-error');
export type IssueFn = (issue: Record<string, any>) => string | undefined;

// cloneZodCheck(check, error?: string | IssueFn): otherwise unchanged
//   if (error !== undefined) nextDef.error = typeof error === 'function' ? error : () => error;

export const asFallback = (fn: IssueFn): IssueFn => Object.defineProperty(fn, FALLBACK, { value: true });
// An error is authored unless this module installed it.
export const isAuthoredError = (def: InternalZodDef): boolean =>
  typeof def.error === 'function' && !(def.error as any)[FALLBACK];
```

```ts
// error-map.ts (new; named zod imports only, no locale imports)
type FieldMap = Readonly<Record<string, ErrorMessage | undefined>>;

const normalise = (entry: FieldErrorEntry<any>): FieldMap =>
  Object.freeze(typeof entry === 'object'
    ? Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined))
    : { default: entry });

function checkKeys(def: InternalZodDef): string[] {          // static candidates, specific first
  switch (def.check) {
    case 'min_length': case 'greater_than': return ['min', 'too_small'];
    case 'max_length': case 'less_than': return ['max', 'too_big'];
    case 'length_equals': return ['length', 'too_small', 'too_big'];
    case 'multiple_of': return ['multiple_of', 'not_multiple_of'];
    case 'number_format': return def.format === 'safeint' ? ['int'] : [];
    case 'string_format': return [String(def.format), 'format', 'invalid_format'];
    case 'custom': return ['custom'];
    default: return [];                                         // unknown kinds: only `default`
  }
}

function coreKeys(iss: Record<string, any>, coreFormat?: string): string[] {
  if (iss.format === 'safeint') return ['int'];                // .int() and z.int() report invalid_type
  switch (iss.code) {
    case 'invalid_type':
      return iss.input === undefined ? ['required', 'invalid_type']
        : iss.input === null ? ['null', 'invalid_type'] : ['invalid_type'];
    case 'invalid_format': return [String(iss.format ?? coreFormat), 'format', 'invalid_format'];
    case 'too_small': return ['min', 'too_small'];
    case 'too_big': return ['max', 'too_big'];
    default: return [iss.code];
  }
}

function pick(map: FieldMap, keys: string[], iss: Record<string, any>): string | undefined {
  for (const key of [...keys, 'default']) {
    const entry = map[key];
    if (entry === undefined) continue;
    const message = typeof entry === 'function' ? entry(iss as any) : entry;
    if (message !== undefined) return message;                  // undefined: keep looking
  }
  return undefined;
}

const hasAny = (map: FieldMap, keys: string[]) =>
  map.default !== undefined || keys.some((k) => map[k] !== undefined);
// Checks have a `check` and no `type`; format schemas such as z.email() have both.
const isCheck = (inst: any) => { const d = inst?._zod?.def; return typeof d?.check === 'string' && d.type === undefined; };

function applyCoreErrorMap(core: z.ZodTypeAny, map: FieldMap): z.ZodTypeAny {
  const def = getZodDef(core);
  if (!def) return core;
  const overrides: Record<string, unknown> = {};

  if (Array.isArray(def.checks)) {
    let changed = false;
    const checks = def.checks.map((check: unknown) => {
      const checkDef = getZodDef(check);
      if (!checkDef || isAuthoredError(checkDef)) return check;   // inline wins
      const keys = checkKeys(checkDef);
      if (!hasAny(map, keys)) return check;
      const skipCode = checkDef.check === 'number_format';        // decimals arrive as invalid_type
      changed = true;
      return cloneZodCheck(check, asFallback((iss) => pick(map, skipCode ? keys : [...keys, iss.code], iss)));
    });
    if (changed) overrides.checks = checks;
  }

  if (!isAuthoredError(def) && Object.keys(map).length > 0) {
    const coreFormat = def.format as string | undefined;        // copy a primitive, never the def
    overrides.error = asFallback((iss) => (isCheck(iss.inst) ? undefined : pick(map, coreKeys(iss, coreFormat), iss)));
  }
  return Object.keys(overrides).length ? cloneSchemaWithDef(core, overrides, 'error map') : core;
}

export function applyFieldErrorMap(field: z.ZodTypeAny, entry: FieldErrorEntry<any>): z.ZodTypeAny {
  const map = normalise(entry);
  const { core, wrappers } = unwrapAll(field);
  const next = applyCoreErrorMap(core, map);
  return next === core ? field : applyWrappers(next, wrappers);
}
```

```ts
// refine.ts: runtime dispatch
export function refineSchema(base: any, second?: unknown, third?: unknown): any {
  const callback = typeof second === 'function' ? second : undefined;
  const errorMap = callback ? third : second;
  if (!callback && !isPlainObject(errorMap)) throw new DrizzleValidatorsError(
    'refineSchema expects a refinement callback or an error map as its second argument.');
  if (!callback && third !== undefined) throw new DrizzleValidatorsError(
    'refineSchema: the callback must come before the error map: refineSchema(schema, callback, errorMap).');
  if (callback && third !== undefined && !isPlainObject(third)) throw new DrizzleValidatorsError(
    'refineSchema: the error map must be a plain object.');

  const nextShape = /* existing pipeline when a callback is present, else { ...base.shape } */;

  if (errorMap !== undefined) {
    for (const [key, entry] of Object.entries(errorMap)) {
      if (entry === undefined) continue;
      const field = nextShape[key];
      if (!field) throw new DrizzleValidatorsError(
        `Error map references unknown field "${key}". Known fields: ${Object.keys(nextShape).join(', ')}.`);
      nextShape[key] = applyFieldErrorMap(field, entry);
    }
  }
  return rebuildZodObject(base, nextShape);
}
```

## 8. Precedence and invariants

Ladder, highest first:

1. An authored `error` on the node that raises the issue: the check for check issues, the core for core issues. `.setError()` counts as authored.
2. The specific map key.
3. The issue-code key.
4. `default`.
5. Zod’s native message.

Invariants:

- No existing def, check or shape is ever written to; every change is a clone through `cloneSchemaWithDef` or `cloneZodCheck` (C1 holds).
- A map adds no checks and changes no parse outcome; `z.infer` and success or failure are identical with or without it.
- Closures capture only a frozen copy of the map and primitives, never a schema definition.

Consequences worth documenting:

- **Zod 4.6 and later:** an authored schema-level `error` is also a native catch-all for check issues. A map key for a check outranks it, because specific beats generic, on every version. This is pinned by a test.
- **Chained maps cascade.** Installed fallbacks are branded; a later map replaces an earlier fallback but never an authored error. Plan D’s two-layer example behaves as written.
- `.setError()` gives the core and every check an authored error, so the map skips that field entirely.

## 9. Edge-case policy

| Case | Policy |
| :-- | :-- |
| Key without a matching check | No-op; a map never invents a validator |
| Unknown field in the map | Throws, lists known fields |
| `undefined` value / empty string | Absent / valid message |
| Message function throws / returns `undefined` | Propagates / falls through to the next candidate |
| Array, tuple, set field | Styles the container only; element schema untouched (no `def.element` recursion) |
| Object, union, pipe, transform cores | Core-level keys only; no recursion into members |
| Optional, nullable, default, catch, readonly | Peeled and re-applied with `unwrapAll` and `applyWrappers`; lazy getters preserved |
| Strict, loose, catchall, object-level checks | Preserved by `rebuildZodObject`; object-level issues are never styled |
| Unknown check kinds | Only `default` applies |
| Empty map | No clones |
| Zod patch drift | All `_zod.def` reads stay in `zod-compat.ts`, guarded; CI matrix below |
| Async refinements | Unaffected; the map is construction-time only |

## 10. Test plan

**Runtime** (extend `refine-schema.test.ts`; new `refine-error-map.test.ts`):

1. Every key against its real Zod issue: `required`, `null`, `invalid_type`, `invalid_value`, `min`, `max`, `length` (short and long), `int` (check and root), `multiple_of`, `format` (both `z.string().email()` and root `z.email()`), `regex`, `starts_with`, `ends_with`, `includes`, `custom`, `unrecognized_keys`, `invalid_union`.
2. `.int()` and `z.int()` with a decimal and only `invalid_type` mapped: Zod’s native message appears, not the type message.
3. Precedence: inline check, inline core on a core issue, `.setError()`, shorthand never overriding inline, function returning `undefined`.
4. Contamination: base checks keep `_zod.def.error === undefined`; two maps from one base stay independent; the existing contamination suite stays green.
5. Wrappers and defaults; array element untouched; strict, loose and catchall preserved.
6. Chained maps (cascade) and idempotence.
7. Argument errors: wrong order, non-object map, unknown field.

**Types:** `@ts-expect-error` fixtures for every case listed in section 6, run on the package’s TypeScript version and on the latest.

**Conformance:** for every name in `STRING_FORMAT_NAMES`, build the schema, read `def.format` and assert it is a legal key. Fails today for the four dead names, which is why the emitted list exists.

**CI matrix:** Zod 4.0.x, 4.4.3 (baseline) and latest, via aliased installs (for example `zod40@npm:zod@4.0.17`), one process per version, because several Zod versions in one process interfere through shared global state.

**Bundle:** the existing tree-shaking test (under 120 000 characters; about 90 KB on Zod 4.6) must stay green. `error-map.ts` uses named imports only.

Commands: `bun test packages/drizzle-validators/tests/refine-schema.test.ts`, the contamination suite, then `bun run --filter='@vacuus/drizzle-validators' typecheck` and `build`.

## 11. Rollout

1. **Types:** extract `RefinedShapeOf`, add key sets, `SchemaErrorMap` and the overload declarations (runtime ignores the map). Type tests first.
2. **Runtime:** `zod-compat.ts` (function support in `cloneZodCheck`, `FALLBACK`, `isAuthoredError`), new `error-map.ts`, argument dispatch in `refine.ts`.
3. **Tests and CI matrix.**
4. **Docs:** README section (keys, ladder, cascade, Zod 4.6 note); fix the `(fields, z)` mismatch; confirm the generated `.d.ts` shim picks up the overloads (`dts-builder.ts` references `typeof import(...)['refineSchema']`, so no change is expected).
5. **Later, separate specifications:** Valibot and TypeBox, `_object`, nested keys.

## 12. Decisions needed

1. **Authored core error versus `required` and `null`.** Default: an authored core `error` wins for everything the core raises (native Zod semantics). Plan I’s carve-out, which lets the map still supply `required` and `null` over `z.email({ error })`, is rejected for predictability. It costs about ten lines if you want it.
2. **Cascade of chained maps.** Default: a later map replaces earlier fallbacks, never authored errors.
3. **Key names.** Default: domain names (`min`, `max`, `length`, `int`) plus Zod issue codes. Raw check kinds (`min_length`, `greater_than`) and Plan D’s camelCase aliases are not supported.
