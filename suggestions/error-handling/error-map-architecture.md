# Error Map Architecture for `refineSchema`

> **Target Package:** `@vacuus/drizzle-validators`
> **Primary Files:** `packages/drizzle-validators/src/refine.ts`, `src/zod-compat.ts`, new `src/error-map.ts`
> **Baseline:** `zod@^4.4.3` (peer `^4.0.0`)
> **Status:** Architectural & Implementation Proposal
> **Related Guarantee:** C1 non-contamination (`tests/bug-repro/refine-contamination.test.ts`)

---

## 1. Executive Summary

`refineSchema` today has a single signature: `refineSchema(baseSchema, refinementFn)`. This proposal adds a **declarative, type-safe error-handling and mapping layer** via two new overload patterns:

1. **Error map only:** `refineSchema(baseSchema, errorMap)`
2. **Rules callback + fallback error map:** `refineSchema(baseSchema, refinementFn, errorMap)`

The `errorMap` is a **per-field stylesheet of default messages** keyed by Zod issue code (`invalid_type`, `too_small`, `too_big`, …) and by fine-grained Zod 4 check kind (`min_length`, `max_length`, `string_format`, …). It fills only the gaps where no explicit inline error was authored — never overriding `.min(18, { error: "Custom inline" })` or `.setError("...")`.

Three architectural pillars:

1. **Left-to-right type inference.** Overloads declare `refinementFn` *before* `errorMap`, and the error map's type parameter is derived from the refinement result `R` — so new fields added and types changed inside the callback are visible to the error map's key/value constraints.
2. **Clone-based, non-mutating application (C1).** The error map is applied as a second *clone pass* over the already-refined schema. Every check/schema clone goes through `cloneSchemaWithDef` / `cloneZodCheck` in `zod-compat.ts`; no shared base definition is ever mutated.
3. **Inline-wins precedence via explicit authorship tagging.** A check whose error was authored inline (in the callback or the base schema) is *tagged*; the error map pass skips tagged checks. The map is never consulted for already-messaged checks.

The layer is validator-agnostic at the API surface (the `errorMap` object shape is the same for Zod, Valibot, and TypeBox), and the runtime application is layered on top of the existing per-adapter `refineSchema` composition so it works with every validator the package offers.

---

## 2. Public API & Syntax

### 2.1 Usage

```ts
import { z } from "zod";
import { refineSchema } from "@vacuus/drizzle-validators/refine";

// (1) Error map only — relabel existing validators with no rules callback.
const insertSchema = refineSchema(baseInsertSchema, {
  email: {
    invalid_type: "Email must be a string",
    invalid_format: "Email looks wrong",
    max_length: "Email is too long",
  },
  age: {
    invalid_type: "Age must be a number",
    too_small: "You must be at least 18",
  },
  role: {
    invalid_enum_value: "Unknown role",
  },
});

// (2) Rules callback + fallback error map.
const insertSchema2 = refineSchema(
  baseInsertSchema,
  (fields) => ({
    email: fields.email.as(z.email({ error: "Inline wins" })), // inline beats map
    age: fields.age.min(18), // no inline error → map fills it
    confirmPassword: z.string().min(8), // brand-new field → map may target it
  }),
  {
    // `confirmPassword` is a valid key here ONLY because the callback added it.
    email: { invalid_format: "Fallback, never shown for email" }, // inline "Inline wins" wins
    age: { too_small: "You must be at least 18" }, // applied, since min(18) has no inline error
    confirmPassword: { too_small: "Password needs 8+ characters" },
  },
);
```

### 2.2 New export surface (`refine.ts`)

```ts
export function refineSchema<
  T extends z.ZodObject<any>,
  TMap extends SchemaErrorMap<T["shape"]>,
>(
  baseSchema: T,
  errorMap: TMap,
): z.ZodObject<ErrorMappedShape<T["shape"], TMap>>;

export function refineSchema<
  T extends z.ZodObject<any>,
  R extends RefinementCallbackResult<T["shape"]>,
  TMap extends SchemaErrorMap<RefinedShapeOf<T, R>>,
>(
  baseSchema: T,
  refinementFn: (fields: RefinableShape<T["shape"]>) => R,
  errorMap: TMap,
): z.ZodObject<ErrorMappedShape<RefinedShapeOf<T, R>, TMap>>;

// Existing single-callback signature (unchanged)...
export function refineSchema<T extends z.ZodObject<any>, R extends RefinementCallbackResult<T["shape"]>>(
  baseSchema: T,
  refinementFn: (fields: RefinableShape<T["shape"]>) => R,
): z.ZodObject<RefinedShapeOf<T, R>>;
```

`RefinedShapeOf<T, R>` is the shape the existing implementation already computes (the `Omit<T["shape"], keyof R> & {...}` mapping from `refine.ts:583–590`).

### 2.3 Argument ordering rationale (strict `schema → refinementFn → errorMap`)

TypeScript infers generic type parameters **left to right** as it checks arguments. Because the error map's shape constraint is written as `SchemaErrorMap<RefinedShapeOf<T, R>>`, and `R` is only known once `refinementFn` has been checked, the compiler must resolve `R` before it can validate the `errorMap` keys:

- New fields (`confirmPassword`) returned by the callback become keys of `RefinedShapeOf`, so `confirmPassword` is a legal `errorMap` key.
- Type changes made in the callback (e.g. `fields.email.as(z.email())`) narrow the per-field allowed key set (the email field is still a string core, but now `invalid_format` is meaningful).
- Reordering the parameters (`errorMap` before `refinementFn`) would force `R` to be inferred from the error map alone and would *not* see callback-added fields — hence the strict ordering is a **hard constraint**, not a style preference.

---

## 3. Type Definitions (Type-Safety Layer)

### 3.1 Issue-code and check-kind vocabulary

Zod 4 emits issues with a `code` plus check-specific `def.checks[]`. We model two orthogonal namespaces:

```ts
/** Top-level Zod 4 issue codes we remap. Extensible. */
export type ErrorIssueCode =
  | "invalid_type"
  | "invalid_value"
  | "too_small"
  | "too_big"
  | "invalid_format"
  | "invalid_enum_value"
  | "unrecognized_keys"
  | "custom";

/** Fine-grained Zod 4 check kinds (from def.checks[].check). */
export type ErrorCheckKind =
  | "min_length"
  | "max_length"
  | "length_equals"
  | "greater_than"
  | "less_than"
  | "multiple_of"
  | "number_format"
  | "string_format"
  | "regex"
  | "starts_with"
  | "ends_with"
  | "includes"
  | "email"
  | "url"
  | "uuid"
  | (typeof STRING_FORMAT_NAMES)[number];
```

### 3.2 Per-field map with core-type-aware key set

The core insight: allowed keys are a function of the **unwrapped core Zod type** (`DeepUnwrap` already exists in `refine.ts:356`). We define a set of key-permitting interfaces per core category, then a conditional mapped type.

```ts
/** Keys legal on a string core. */
interface StringFieldErrorMapKeys {
  invalid_type?: string;
  invalid_format?: string;
  too_small?: string;
  too_big?: string;
  min_length?: string;
  max_length?: string;
  length_equals?: string;
  string_format?: string;
  regex?: string;
  starts_with?: string;
  ends_with?: string;
  includes?: string;
  email?: string;
  url?: string;
  uuid?: string;
  // ... one key per STRING_FORMAT_NAMES entry (derived via mapped type)
}

/** Keys legal on a number / bigint core. */
interface NumberFieldErrorMapKeys {
  invalid_type?: string;
  too_small?: string;
  too_big?: string;
  invalid_value?: string;
  greater_than?: string;
  less_than?: string;
  multiple_of?: string;
  number_format?: string;
}

/** Keys legal on an array / set / tuple core. */
interface SequenceFieldErrorMapKeys {
  invalid_type?: string;
  too_small?: string;
  too_big?: string;
  min_length?: string;
  max_length?: string;
  length_equals?: string;
}

/** Keys legal on an enum core. */
interface EnumFieldErrorMapKeys {
  invalid_type?: string;
  invalid_enum_value?: string;
  invalid_value?: string;
}

/** Keys legal on a date core. */
interface DateFieldErrorMapKeys {
  invalid_type?: string;
  invalid_value?: string;
  too_small?: string;
  too_big?: string;
  greater_than?: string;
  less_than?: string;
}

/** Keys legal on an object core. */
interface ObjectFieldErrorMapKeys {
  invalid_type?: string;
  unrecognized_keys?: string;
}

/** Universal keys legal on any core (custom/refine failures). */
interface UniversalFieldErrorMapKeys {
  custom?: string;
  invalid_value?: string;
}
```

The public mapped type — `FieldErrorMapForCore`:

```ts
export type FieldErrorMapForCore<T extends z.ZodTypeAny> =
  DeepUnwrap<T> extends z.ZodString
    ? StringFieldErrorMapKeys & UniversalFieldErrorMapKeys
    : DeepUnwrap<T> extends z.ZodNumber
      ? NumberFieldErrorMapKeys & UniversalFieldErrorMapKeys
      : DeepUnwrap<T> extends z.ZodBigInt
        ? NumberFieldErrorMapKeys & UniversalFieldErrorMapKeys
        : DeepUnwrap<T> extends z.ZodArray<any> | z.ZodSet<any> | z.ZodTuple
          ? SequenceFieldErrorMapKeys & UniversalFieldErrorMapKeys
          : DeepUnwrap<T> extends z.ZodEnum<any> | z.ZodNativeEnum<any>
            ? EnumFieldErrorMapKeys & UniversalFieldErrorMapKeys
            : DeepUnwrap<T> extends z.ZodDate
              ? DateFieldErrorMapKeys & UniversalFieldErrorMapKeys
              : DeepUnwrap<T> extends z.ZodObject<any>
                ? ObjectFieldErrorMapKeys & UniversalFieldErrorMapKeys
                : UniversalFieldErrorMapKeys; // safe fallback for exotic cores
```

> Note: `invalid_type` belongs to *every* core (a wrong JS type always produces `invalid_type`), so it should be included in the universal set too — the per-category interfaces keep it for clarity and documentation. The final union always includes `UniversalFieldErrorMapKeys`.

### 3.3 Schema-level map

```ts
export type SchemaErrorMap<TShape extends Record<string, z.ZodTypeAny>> = {
  [K in keyof TShape]?: FieldErrorMapForCore<TShape[K]>;
};
```

Because `TShape` is `RefinedShapeOf<T, R>` in the three-arg overload, this:
- admits only existing + callback-added field names as keys,
- restricts each field's allowed error keys to its final core type,
- rejects typo'd keys and wrong-category keys at compile time.

### 3.4 Output shape mapping

```ts
/** Shape passthrough: the error map only changes messages, never the type. */
export type ErrorMappedShape<
  TShape extends Record<string, z.ZodTypeAny>,
  TMap extends SchemaErrorMap<TShape>,
> = TShape;
```

This documents the invariant that error mapping never alters inferred types (`z.infer` of the refined schema is identical with or without the map).

---

## 4. Runtime Design (`src/error-map.ts`)

### 4.1 Core helper: `applyFieldErrorMap`

```ts
export function applyFieldErrorMap(
  field: z.ZodTypeAny,
  fieldMap: FieldErrorMapForCore<z.ZodTypeAny> | undefined,
): z.ZodTypeAny;
```

Behavior (fully clone-based — never mutates inputs):

1. `const { core, wrappers } = unwrapAll(field);` — peel `optional/nullable/default/catch/readonly` (existing helper, `refine.ts:53`).
2. `const nextCore = applyCoreErrorMap(core, fieldMap);` — the per-check + def-level error clone.
3. `return applyWrappers(nextCore, wrappers);` — re-attach the outer wrappers unchanged (existing helper, `refine.ts:107`).

### 4.2 Core dispatch: `applyCoreErrorMap`

```ts
function applyCoreErrorMap(
  core: z.ZodTypeAny,
  fieldMap: FieldErrorMapForCore<z.ZodTypeAny> | undefined,
): z.ZodTypeAny {
  if (!fieldMap) return core;
  const def = getZodDef(core);
  if (!def) return core;

  const overrides: Record<string, unknown> = {};

  // (a) Per-check error overrides — match by check kind.
  if (Array.isArray(def.checks)) {
    const mappedChecks = def.checks.map((check) =>
      applyErrorMapToCheck(check, fieldMap),
    );
    if (mappedChecks.some((c, i) => c !== def.checks[i])) {
      overrides.checks = mappedChecks;
    }
  }

  // (b) Def-level error overrides — for issue codes not owned by a specific check
  //     (invalid_type, unrecognized_keys, invalid_value on the schema itself).
  const defLevel = resolveDefLevelError(def, fieldMap);
  if (defLevel !== undefined && !hasInlineError(def)) {
    overrides.error = () => defLevel;
  }

  return Object.keys(overrides).length > 0
    ? cloneSchemaWithDef(core, overrides, "error map")
    : core;
}
```

### 4.3 Check-level application & inline-wins

```ts
function applyErrorMapToCheck(
  check: unknown,
  fieldMap: FieldErrorMapForCore<z.ZodTypeAny>,
): unknown {
  const checkDef = getZodDef(check);
  if (!checkDef) return check;

  // PRECEDENCE: an explicitly authored inline error always wins.
  if (hasInlineError(checkDef)) return check;

  // Prefer the fine-grained check-kind key, then the coarse issue-code key.
  const kindKey = checkKindOf(checkDef);            // e.g. "min_length"
  const issueKey = issueCodeForCheck(checkDef);     // e.g. "too_small"
  const msg =
    (fieldMap as Record<string, unknown>)[kindKey] ??
    (fieldMap as Record<string, unknown>)[issueKey];
  if (typeof msg !== "string") return check;

  return cloneZodCheck(check, msg); // C1-safe: fresh check def { ...def, error: () => msg }
}
```

`checkKindOf` returns the precise signature, reusing the existing `checkSignature` logic in `refine.ts:199`:
- `min_length` → `"min_length"`
- `max_length` → `"max_length"`
- `length_equals` → `"length_equals"`
- `greater_than` → `"greater_than"`
- `less_than` → `"less_than"`
- `multiple_of` → `"multiple_of"`
- `number_format` → `"number_format"`
- `string_format` with `format: "email"` → `"email"` (falls back to `"string_format"` for unknown formats)

`issueCodeForCheck` maps a check kind to the issue code it produces:

| Check kind | Produced issue code |
| :--- | :--- |
| `min_length` | `too_small` |
| `max_length` | `too_big` |
| `length_equals` | `too_small` (short) / `too_big` (long) → map to `too_small`/`too_big` via both coarse keys |
| `greater_than` | `too_small` |
| `less_than` | `too_big` |
| `multiple_of` | `invalid_value` |
| `number_format` | `invalid_format` |
| `string_format` (incl. formats) | `invalid_format` |
| `regex` / `starts_with` / `ends_with` / `includes` | `invalid_format` |
| `custom` | `custom` |

`resolveDefLevelError` maps coarse issue codes for the schema itself:

```ts
function resolveDefLevelError(def, fieldMap): string | undefined {
  // invalid_type: emitted by the core when the JS value has the wrong type.
  if (typeof fieldMap.invalid_type === "string") return fieldMap.invalid_type;
  // unrecognized_keys: object-level strictness.
  if (typeof fieldMap.unrecognized_keys === "string") return fieldMap.unrecognized_keys;
  // invalid_value / invalid_enum_value for enum/literal cores.
  if (typeof fieldMap.invalid_enum_value === "string") return fieldMap.invalid_enum_value;
  return fieldMap.invalid_value;
}
```

### 4.4 `hasInlineError` — the precedence backstop

```ts
/**
 * True when an error was EXPLICITLY authored on this def. An inline authoring
 * is (a) a constructor/params error (`z.string({ error })`, `.min(5, { error })`),
 * or (b) a `setError`/`withError` clone (which we also mark via ERROR_MAP_BRAND
 * for round-tripping through `.as()`).
 */
export function hasInlineError(def: InternalZodDef): boolean {
  return (
    typeof def.error === "function" || // zod 4 normalizes error params to () => string
    typeof def.message === "string" || // zod 4 def.message fallback
    def[ERROR_MAP_BRAND] === true      // our own marker (set by setErrorOnField)
  );
}
```

`setErrorOnField` in `refine.ts:331` already clones with `error: () => error`; we add a brand to that clone so precedence survives `.as()` transfers and future passes:

```ts
// In cloneSchemaWithDef's overrides for setError:
overrides[ERROR_MAP_BRAND] = true;
```

> **Important caveat:** zod 4 normalizes a check's `error` param to a function on the check def, and also places a default `error` accessor on every def. `hasInlineError` must distinguish "user authored" from "zod's default accessor". The proposal pins this by probing `Object.getOwnPropertyDescriptor(def, "error")` — a *getter* is zod's default (auto-generated locale error), a *data property / own function value* is user-authored. This mirrors the existing `hasLazyDefaultGetter` pattern in `zod-compat.ts:37` and is verified against `zod@4.4.3` during implementation (see §7 verification).

---

## 5. Integration Into `refineSchema` (`src/refine.ts`)

### 5.1 Composition order

```ts
export function refineSchema(baseSchema, refinementFn?, errorMap?) {
  // 1. Existing single-callback behavior produces the refined schema (unchanged).
  //    If errorMap is undefined, behave exactly as today.
  // 2. When errorMap is present, run a final non-mutating clone pass over the
  //    refined shape, applying each field's map via applyFieldErrorMap.
  // 3. Rebuild the object (strict/loose/catchall preserved) with the mapped shape.
}
```

Concretely, the existing implementation already builds `nextShape` and calls `rebuildZodObject`. The error-map path inserts one step:

```ts
if (errorMap !== undefined) {
  for (const key of Object.keys(nextShape)) {
    const fieldMap = (errorMap as any)[key];
    if (fieldMap === undefined) continue;
    nextShape[key] = applyFieldErrorMap(nextShape[key], fieldMap);
  }
}
return rebuildZodObject(baseSchema, nextShape);
```

### 5.2 C1 non-contamination, preserved

- `applyFieldErrorMap` → `applyCoreErrorMap` → `cloneSchemaWithDef` / `cloneZodCheck` all produce **fresh defs** (`{ ...def, ... }` + `new constr(nextDef)`), exactly like `setErrorOnField` does today.
- The base schema and sibling validators refined from the same base are untouched.
- No `def.error` write, no `def.checks.push`, no shared check instance reuse.
- The existing regression test `tests/bug-repro/refine-contamination.test.ts` must still pass; new cases extend it (see §8).

### 5.3 Interaction with `.as()` and `setError`

- `fields.email.as(z.email({ error: "Inline wins" }))` → the new core's `string_format` check carries an authored error → `hasInlineError` true → error map skips it. **Inline wins.**
- `fields.age.min(18)` (no error) → the cloned `greater_than` check has no authored error → error map sets `too_small`. **Map fills the gap.**
- `fields.x.setError("...")` → branded clone → map skips the whole field. **Inline wins.**
- `transferChecks` clones source checks via `cloneZodCheck` (`refine.ts:325`) — those clones are then subject to the map pass like any other check, but only if they lack an authored error.

### 5.4 Validator compatibility (Zod / Valibot / TypeBox)

The `errorMap` **object shape is target-agnostic**; only the runtime application differs per validator. In this codebase the per-target refinement surfaces are adapter-driven (`src/adapters/`). Design:

| Target | Error-map runtime |
| :--- | :--- |
| `zod` | `applyFieldErrorMap` (this doc) — direct check/def cloning. |
| `valibot` | Valibot v1 supports `message` on each action; map keys map to `v.minLength(msg)`, `v.maxLength(msg)`, `v.email(msg)`, … via an `applyValibotErrorMap` that wraps/replaces the top-level message per action kind. |
| `typebox` | TypeBox carries `errorMessage` per schema node / `Value.Error` messages; map keys feed `t.String({ minLength, errorMessage })` / format-level `errorMessage`. |

The `SchemaErrorMap` type is shared across targets; per-target `applyXxxErrorMap` functions live in the adapter files. Because the package's `refineSchema` is currently exported only for Zod (`refine.ts`), the Valibot/TypeBox paths are designed as **adapter-local** functions that can be surfaced later under the same overload contract — no changes to the shared type layer.

---

## 6. Zod 4 Runtime Dispatch — Complete

### 6.1 Issue-code → producer mapping (no mutation)

| Issue code | Produced by | Error map key to fill it |
| :--- | :--- | :--- |
| `invalid_type` | Core schema def (wrong JS type) | `invalid_type` (def-level) |
| `invalid_value` | `multiple_of`, `literal`, some number/date checks | `invalid_value`, `multiple_of` |
| `invalid_enum_value` | `ZodEnum` | `invalid_enum_value` |
| `too_small` | `min_length`, `greater_than`, `length_equals` (short) | `min_length`, `greater_than`, `too_small` |
| `too_big` | `max_length`, `less_than`, `length_equals` (long) | `max_length`, `less_than`, `too_big` |
| `invalid_format` | `string_format` (formats, regex, starts_with, ends_with, includes), `number_format` | `string_format`, `regex`, `email`, `url`, `uuid`, … `number_format`, `invalid_format` |
| `unrecognized_keys` | `ZodObject` strict/catchall | `unrecognized_keys` (def-level) |
| `custom` | `.refine()`, `z.custom()`, `ctx.addIssue` | `custom` (check-level, only if check lacks authored error) |

### 6.2 Check-signature → key resolution

Reuses `checkSignature` (`refine.ts:199`):
- `min_length` → `"min_length"`
- `max_length` → `"max_length"`
- `length_equals` → `"length_equals"`
- `greater_than` → `"greater_than"`
- `less_than` → `"less_than"`
- `multiple_of` → `"multiple_of"`
- `number_format` → `"number_format"`
- `string_format:{format}` → mapped to the named format key when it exists in `STRING_FORMAT_NAMES`, else `"string_format"`.
- `regex`/`starts_with`/`ends_with`/`includes` → their own keys (these are `string_format` sub-kinds with `CONSTRAINT_STRING_FORMATS`).

Precedence within the map: **fine-grained check-kind key beats coarse issue-code key.** E.g. `email: { min_length: "Too short", too_small: "Generic small" }` → `min_length` wins for the `min_length` check; `too_small` fills any other smallness issue.

### 6.3 Full precedence ladder (highest → lowest)

1. Authored inline error on the check (`error: "..."` in `.min(18, { error })`, or `.setError()`) — **always wins.**
2. Fine-grained map key for the exact check kind (`min_length`, `email`, `regex`, …).
3. Coarse map key for the issue code (`too_small`, `invalid_format`, …).
4. Zod 4 default locale message — untouched.

The ladder is implemented purely by *cloning only what needs a change* and *skipping what already has an authored error*, never by string precedence at parse time — so there is no ambiguity and no shared-state risk.

---

## 7. Edge Cases & Guard Rails

| Edge case | Behavior |
| :--- | :--- |
| Map key present but no matching check on the schema | **No-op.** The map is a stylesheet, not a constraint engine; it never invents validators. |
| Field in base shape but absent from map | Field untouched. |
| Field in map but absent from base shape (2-arg form) | Compile-time error (key not in `T["shape"]`); runtime no-op with a `DrizzleValidatorsError` in non-typed call sites. |
| Field added in callback, mapped | Works only in the 3-arg form (ordering guarantees `R` is inferred first). |
| `.as()` transferred checks carrying authored errors | Transferred via `cloneZodCheck`; `hasInlineError` sees the authored error → skipped by map. |
| `setError` on a whole field + a map for the same field | Field-level `setError` brands the def → map skips every check on that field. |
| Optional/nullable/default fields | `unwrapAll` peels wrappers, map applies to the core, `applyWrappers` re-attaches. Message on `invalid_type` still applies when a value is present but wrong-typed. |
| Union/intersection/record/tuple cores | Fall to `UniversalFieldErrorMapKeys` (no over-restrictive keys); `custom` and `invalid_value` remain legal. |
| Symbol-keyed shapes | Rejected earlier by the existing object serialization guard; unchanged. |
| Empty map `{}` | No-op; returns the refined schema uncloned (fast path). |
| Error map applied twice (idempotence) | Second pass sees branded/cloned checks with authored errors → no further changes. Cloning again is still C1-safe. |
| Throwing custom error functions | Cloning preserves them; `extractCheckError` in `zod-serializer.ts:35` already try/catches — unchanged. |
| `z.object({ error })` schema-level authoring in base | `hasInlineError` true → map's `invalid_type` does not override. Base-authored messages are treated as authored (consistent with "inline wins"). |
| Deeply nested fields (`address.city`) | Error map is flat-per-field (top-level keys). Nested-object remapping is a documented future extension (`refineSchema(base, fn, { "address.city": ... })` dotted keys) and is *not* in scope for v1. |

---

## 8. Verification & Test Plan

Extend `tests/refine-schema.test.ts` and `tests/bug-repro/refine-contamination.test.ts` (plus a new `tests/error-map.test.ts`):

1. **2-arg form:** `refineSchema(base, { email: { invalid_format: "..." } })` produces the custom message; other fields keep defaults.
2. **3-arg form + new field:** callback adds `confirmPassword: z.string().min(8)`; map keys `confirmPassword.too_small` — typechecks and applies.
3. **Inline wins:** `.min(18, { error: "Inline" })` + map `age.too_small` → parse yields "Inline".
4. **setError wins:** `.setError("X")` + map → "X".
5. **Fine-grained beats coarse:** map `{ min_length: "A", too_small: "B" }` on a `min(5)` string → "A"; on a different smallness issue → "B".
6. **No-op on absent checks:** map `email.max_length` on a field with no max → no behavior change, no clone side effects.
7. **C1 regression:** sibling validators + base schema keep their messages after a mapped refine (mirror of `refine-contamination.test.ts`).
8. **Wrapper preservation:** optional/nullable/default fields mapped and parsed; wrapper inference unchanged (`z.infer` identical).
9. **Type errors (tsc negative tests):** wrong field name, wrong key category (`age.email`), and map-before-callback ordering rejections.
10. **Idempotence:** applying the map twice yields byte-identical behavior.
11. **Cross-target smoke (Valibot/TypeBox):** map shape typechecks against a target-agnostic `SchemaErrorMap`; adapter-local apply functions unit-tested in `valibot-adapter.test.ts` / `typebox-adapter.test.ts`.

Typecheck: `bun run typecheck`; tests: `bun test`.

---

## 9. Phased Implementation Roadmap

### Phase 1 — Type layer (`src/error-map.ts` types)
- Add `ErrorIssueCode`, `ErrorCheckKind`, `StringFieldErrorMapKeys` … `UniversalFieldErrorMapKeys`, `FieldErrorMapForCore`, `SchemaErrorMap`, `ErrorMappedShape`.
- Add `RefinedShapeOf` refactor of the existing return-type computation (pure type, no runtime change).
- Wire the two new overloads onto `refineSchema` with `any`-erased runtime (map ignored) so type tests can be written first.

### Phase 2 — Runtime core (`src/error-map.ts` functions)
- Implement `applyFieldErrorMap`, `applyCoreErrorMap`, `applyErrorMapToCheck`, `checkKindOf`, `issueCodeForCheck`, `resolveDefLevelError`.
- Add `hasInlineError` (with the own-property-vs-getter probe) to `zod-compat.ts`.
- Add `ERROR_MAP_BRAND` and set it in `setErrorOnField`.

### Phase 3 — Integration (`src/refine.ts`)
- Add the two overloads, arg-dispatch (`typeof refinementFn === "object"` ⇒ error-map-only form), and the post-refine error-map clone pass.
- Preserve the existing single-callback fast path when no map is passed.

### Phase 4 — Tests & hardening
- New `tests/error-map.test.ts` (cases 1–10 above), extend C1 regression.
- Negative-typecheck fixture for §8 case 9.
- Verify `hasInlineError`'s own-property/getter probe against `zod@4.4.3` (and pin behavior in a test) since it is the load-bearing precedence primitive.

### Phase 5 — Adapter surfaces (Valibot / TypeBox)
- Add `applyValibotErrorMap` / `applyTypeboxErrorMap` in the respective adapter files behind the same `SchemaErrorMap` contract. Out of scope for the Zod merge but designed here so the API surface stays uniform.

---

## 10. Non-Breaking Compatibility & Bundle Safety

- **Zero breaking changes:** the existing one-argument `refinementFn` signature, `.as()`, `setError`, `withError`, `unwrap`, `required`, `nonnullable`, and the lazy shape proxy all behave identically when no error map is passed.
- **Tree-shaking:** `error-map.ts` is only referenced from the new overload path; named zod imports only (the package's existing rule — no `import * as z`). `hasInlineError` lives in `zod-compat.ts` which is already imported by `refine.ts`.
- **C1 guarantee:** all application is clone-based; the contamination regression suite is extended, not weakened.
- **Type parity:** `ErrorMappedShape<TShape, TMap> = TShape` guarantees `z.infer` never changes when an error map is added or removed.
