# Plan: Refactor `refineSchema` for Scalability and Robustness

## Goal

Refactor `refineSchema` (and its field-API machinery in
`packages/drizzle-validators/src/refine.ts`) so that:

- adding a new field operation / format alias is a **single, table-driven
  change** instead of edits scattered across the Proxy traps and type
  declarations;
- the implementation **fails loudly** when a Zod shape or operation is not
  supported, instead of silently returning a partially transformed schema;
- direct access to Zod internals is **contained in one compatibility layer**
  that can be upgraded/version-probed in one place;
- the runtime wrapper model and the TypeScript conditional types **cannot
  drift apart**;
- public API and inference stay compatible with current consumers.

Scope: `packages/drizzle-validators/src/refine.ts` plus its tests
(`tests/refine-schema.test.ts`, `tests/wrapper-edge-cases.test.ts`,
`tests/modifiers-and-wrappers.test.ts`, `tests/composition-chains.test.ts`,
`tests/complex-types.test.ts`, `tests/async-refinements.test.ts`,
`tests/zod4-error-formatting.test.ts`).

Baseline: zod `^4.4.3` (dev), peer `^4.0.0-0`. Tests run with `bun test`;
typecheck with `tsc --noEmit` in `packages/drizzle-validators`.

---

## 1. Why the current implementation is not scalable

### S1 — One bespoke Proxy branch per format alias

`wrapFieldProxy` (`refine.ts:447-556`) repeats the same 3-step flow for every
named alias:

```ts
if (prop === "asEmail")  return (params?) => { createFormatSchema("email") -> transferChecks -> applyWrappers -> wrapFieldProxy }
if (prop === "asUrl")    return ... // identical, format = "url"
if (prop === "asUuid")   return ... // identical, format = "uuid"
if (prop === "asCuid2")  return ... // identical, format = "cuid2"
if (prop === "asUlid")   return ... // identical, format = "ulid"
```

Adding one new format alias currently requires edits in **four** places:

1. the `StringFormat` tuple in `src/constants.ts` (`STRING_FORMAT_NAMES`);
2. the `FORMAT_BUILDERS` map (`refine.ts:226-253`);
3. the `RefinedField` type declaration for the new method (`refine.ts:360-401`);
4. **and** a new branch in both the `has` trap (`refine.ts:451-465`) and the
   `get` trap (`refine.ts:467-555`).

The `has`-trap allowlist (`refine.ts:452-462`) already duplicates the alias
list as a string literal, so it can drift from `RefinedField` and
`FORMAT_BUILDERS` independently. There is no single source of truth.

### S2 — Runtime and type-level wrapper models can drift

Runtime wrappers are decoded by `unwrapAll` / rebuilt by `applyWrappers`
(`refine.ts:54-148`), keyed on `def.type === "optional" | "nullable" |
"default"`, with `exactOptional` detected through a `traits` probe
(`refine.ts:66-72`) because Zod 4 does not tag `ZodExactOptional` with a
distinct `def.type`.

The type-level equivalents `DeepUnwrap` / `PreserveWrapper`
(`refine.ts:403-426`) are a **separate, hand-maintained conditional-type
implementation** over the same four wrappers.

Adding a new wrapper kind (e.g. `readonly`, `brand`, `catch`, `pipe`) must be
done in **both** layers, and nothing enforces that the two agree. The existing
Zod-4 `exactOptional` quirk is evidence this already bit once.

### S3 — The generic Proxy fallback is a broad, unvalidated heuristic

When a property is not one of the named operations, `wrapFieldProxy`
(`refine.ts:542-551`) delegates to the *core* schema:

```ts
if (typeof prop === "string" && typeof core[prop] === "function") {
  return (...args) => applyWrappers(core[prop](...args), wrappers); // re-wrap EVERY result
}
```

- It assumes **every** core method returns a schema that should be re-wrapped.
  Methods that return non-schemas (e.g. `.description`, `.shape` on object
  fields, `.valueOf`, symbols/iterators) flow through `applyWrappers` and
  produce garbage instead of a clear error.
- The `has` trap (`refine.ts:451-465`) claims any property on `target` or
  `core`, so internals (`_zod`, `_def`, `_zod.def`) are reachable through the
  proxy and can be misused as "fields".
- Method delegation re-runs `unwrapAll` + `applyWrappers` for **every** call,
  so a chain like `.min(3).max(50).regex(...)` pays the full unwrap/rewrap cost
  per link.

### S4 — Callback output is merged unchecked

`refineSchema` (`refine.ts:577-604`) merges the callback result directly:

```ts
return object({ ...baseSchema.shape, ...modifiedFields }) as any;
```

There is **no runtime validation** that each value in `modifiedFields` is a
Zod schema. A callback returning a string, number, or accidental `undefined`
produces a broken object schema with an unhelpful error thrown later by zod
(or silently wrong behavior). The `as any` cast hides it from the compiler.

### S5 — The string-format alias list is duplicated as literals

`FORMAT_BUILDERS` (`refine.ts:226-253`) maps every `StringFormat` name to a
builder, and `asEmail`/`asUrl`/... hardcode the same names in the `get` trap.
This is one more place the single source of truth (`constants.ts`) can be
ignored.

---

## 2. Why some methods are not robust

### R1 — `setErrorOnField` only touches `checks` + `innerType`

`setErrorOnField` (`refine.ts:162-224`) rebuilds the def by patching
`error`, `checks`, and `innerType`. It:

- only recurses through `innerType` (`refine.ts:185-187`) — for fields whose
  structure lives elsewhere (`items` for arrays, `options` for enums, `fields`
  for nested objects, `union`/`intersection` branches), the message override
  does **not** reach nested checks. `setError` on an `z.enum` or `z.array`
  field silently fails to customize nested issue messages;
- **silently returns the original check** when a check has no `_zod.constr`
  (`refine.ts:179-180`), so `setError` becomes a no-op for those checks with no
  warning;
- spreads the entire internal def (`{ ...fieldDef, ... }`, `refine.ts:198`) and
  re-instantiates via `new constr(newDef)`. Spreading a def with accessors
  other than `defaultValue` can drop getter semantics; this is bespoke,
  version-fragile surgery on zod internals.

### R2 — `transferChecks` is a hardcoded heuristic with silent drops

`transferChecks` (`refine.ts:321-358`) + `CHECK_CORE_COMPAT`
(`refine.ts:293-306`) decides check transfer from a string-keyed table:

- **Unknown check names are transferred unconditionally** (no entry in the
  table -> no `compat` guard -> check is grafted). A future zod check with
  core-type-bound semantics can land on the wrong core type with no error.
- It re-uses the **same check instances** via `result.check(check)`
  (`refine.ts:353-355`), so checks are shared across schemas — a mutation of
  one affects the other.
- Format-conflict logic (`refine.ts:345-351`) only special-cases `string_format`
  against a small constraint set (`CONSTRAINT_STRING_FORMATS`,
  `refine.ts:277-282`). A string format that is neither a constraint nor the
  target format and has an unknown `format` name is transferred silently.
- There is no mechanism to **fail** when a requested replacement
  (`.as()`, `.format()`) cannot safely transfer all existing checks; it
  silently produces a schema with fewer validations.

### R3 — Unknown wrappers are treated as core silently

`unwrapAll` (`refine.ts:61-103`) stops at the first `def.type` it does not
recognize (`break`, `refine.ts:101-103`). Wrappers/modifiers such as
`readonly`, `brand`, `catch`, `pipe`, or `preprocess` are therefore treated as
the "core", so:

- `setError`/`format`/`as` on such a field applies to the *wrapped* def, not
  the underlying type, producing subtle behavior differences;
- nothing reports that the operation could not be applied as intended.

### R4 — Object-level behavior is lost on reconstruction

`refineSchema` rebuilds `z.object({ ...baseSchema.shape, ...modifiedFields })`
(`refine.ts:600-603`). This drops the base object's:

- unknown-key policy (`.strict()` / `.strip()` / `.passthrough()`);
- `catchall`, `description`, and other object-level `_def` config.

A strict base schema becomes `strip()` after refinement — a silent behavioral
change for consumers.

### R5 — `exactOptional` detection is a fragile traits probe

`unwrapAll` distinguishes `optional` from `exactOptional` via
`current._zod?.traits.has("ZodExactOptional")` (`refine.ts:66-72`). This
relies on a zod-internal `traits` set whose shape is not public API; it is
exactly the kind of probe that breaks on a zod minor bump and should live in
one version-gated compatibility helper.

---

## 3. Proposed design

### 3.1 Operation registry (single source of truth for field ops)

Replace the bespoke `has`/`get` branches with a table of field operations:

```ts
type FieldOp = {
  name: string;                     // e.g. "asEmail", "format"
  kind: "replace-core" | "method";  // replace core, or apply to core
  build: (field: FieldContext, params?: any) => z.ZodTypeAny;
  declare?: true;                   // whether it appears in RefinedField
};
```

- `format` and every named alias (`asEmail`, `asUrl`, `asUuid`, `asCuid2`,
  `asUlid`, ...) become **thin delegates** over one `replaceCore(formatName,
  params)` path — same `transferChecks` + `applyWrappers` flow, defined once.
- The Proxy `has`/`get` traps walk the registry; adding an alias is one entry
  in the registry (plus the `StringFormat` tuple in `constants.ts`).
- Derive `RefinedField` method declarations from the registry where feasible so
  the type surface cannot drift from the runtime table.
- Restrict the generic fallback to a **deny-list** of non-schema-returning
  methods (e.g. `.description`, `.valueOf`, internals) and validate that a
  delegated result is a schema before re-wrapping; throw otherwise.

### 3.2 One wrapper model, shared by runtime and types

- Define a single `WrapperKind` union (`optional | nullable | exactOptional |
  default`) and a `WrapperStack` descriptor in one module.
- `unwrapAll`/`applyWrappers` become the only code that reads zod wrapper
  defs; the `traits` probe moves behind a documented compatibility function
  (`detectExactOptional`) with a zod-version probe and a clear error if the
  probe becomes ambiguous.
- Keep `DeepUnwrap`/`PreserveWrapper` but drive them from the same
  `WrapperKind` union and add a **type-level test** (assert-identical helper)
  that a wrapper combination typed by `PreserveWrapper` matches the runtime
  `applyWrappers` result.
- If a wrapper cannot be reconstructed without losing semantics, **throw** with
  the field key and wrapper kind instead of returning a partial schema.

### 3.3 Compatibility layer for zod internals

Create one module (e.g. `src/zod-compat.ts`) that owns every read of `_zod`,
`_def`, `_zod.constr`, `traits`, `def.checks`, `def.defaultValue` accessors.
Each accessor returns a validated result or throws an error that names the
unsupported schema kind and the operation being attempted. `refine.ts` then
contains **zero** direct `_zod`/`_def` reads outside that layer.

### 3.4 Explicit check policy (clone / classify / transfer)

Replace the ad-hoc `transferChecks` with a strategy module:

- `cloneCheckWithError(check, message)` — always produce a new check instance;
  throw if the check cannot be cloned instead of returning the original.
- `classifyCheck(checkDef)` — returns `{ coreBound: "number"|"string"|...,
  kind: "constraint"|"format"|"custom"|"unknown" }` from a typed policy table
  (keep `CHECK_CORE_COMPAT`, but extend it with an explicit `unknown` policy).
- `canTransfer(sourceCore, targetCore, check)` — decide per check; for
  `unknown` checks, either transfer through a verified path or **throw** with
  the check name rather than silently dropping it.
- Never share check instances between schemas; every transfer clones.

### 3.5 Validate callback output and preserve object behavior

Before `object({ ...shape, ...modifiedFields })`:

- verify every non-`undefined` value in `modifiedFields` is a `ZodType` and
  throw an actionable error naming the offending key otherwise;
- read and re-apply the base object's unknown-key policy (`strict`/`strip`/
  `passthrough`), `catchall`, and `description` onto the rebuilt object;
- define and test the behavior for callback keys whose value is `undefined`.

### 3.6 Type-level hardening

- Type `FormatParams` against the supported zod format builders instead of
  `string | Record<string, any>`; narrow the error-message param shape to the
  zod `{ error?: string | ((issue) => string) }` convention.
- Replace broad `any` in `wrapFieldProxy`, `unwrapAll`, `applyWrappers`, and
  `transferChecks` with narrow casts that fail at the zod boundary, keeping the
  public `RefinedField`/`RefinableShape`/`PreserveWrapper` inference intact.

---

## 4. Suggested implementation phases

### Phase 0 — Characterize current behavior

- Inventory the public `refineSchema` API and supported field methods.
- Add missing tests for current guarantees and identify intentional edge-case
  behavior before changing internals (nested wrappers, lazy defaults,
  contamination, object-level policies).
- Record the supported zod version range and the exact internal structures
  used (defs, checks, `traits`, `constr`).

### Phase 1 — Extract compatibility and wrapper helpers

- Introduce typed internal accessors for definitions, constructors, checks,
  and wrapper descriptors in `src/zod-compat.ts`.
- Move `unwrapAll`, `applyWrappers`, and lazy-default handling behind the
  wrapper adapter; make unknown wrappers fail loudly.
- Preserve behavior with the existing test suite before changing dispatch.

### Phase 2 — Introduce the operation registry

- Consolidate `format` + all named aliases into one `replaceCore` path.
- Keep the existing public names and TypeScript inference.
- Remove duplicated Proxy branches and add registry-driven tests.

### Phase 3 — Harden check policy and callback validation

- Extract check cloning/classification/transfer policy (section 3.4).
- Replace silent fallbacks with explicit errors where transformation safety
  cannot be guaranteed.
- Validate callback output and preserve object-level schema behavior
  (section 3.5).

### Phase 4 — Optimize and document

- Cache immutable metadata (wrapper stacks, check policies) only where
  profiling or targeted tests show value; never cache mutable schema
  instances or lazy default results.
- Update the package README/API docs with supported operations, limitations,
  and failure behavior.
- Run focused tests, typecheck/build, and the full package suite.

---

## 5. Testing strategy

- Keep all existing `refineSchema`, wrapper-edge, modifiers, composition,
  complex-types, async, and zod4-error-formatting tests green.
- Add regression tests for each refactor stage:
  - nested and repeated wrappers, including lazy defaults, preserve behavior;
  - `setError` does not mutate the base schema or sibling refinements;
  - chained operations do not duplicate checks;
  - number -> string replacement does not transfer incompatible checks;
  - compatible length/regex/prefix/suffix/transform checks remain;
  - conflicting format checks are excluded intentionally;
  - all registered format aliases behave identically to `format`;
  - malformed callback output throws an actionable error;
  - unsupported or incomplete zod internals fail loudly, not silently;
  - `.strict()`/`.passthrough()`/`.catchall()` object policies survive
    refinement;
  - large shapes and repeated operations do not introduce avoidable
    per-operation recomputation.
- Add a **type-level** test asserting `PreserveWrapper` inference matches the
  runtime wrapper reconstruction for every supported wrapper combination.
- Where practical, assert both runtime parsing and inferred TypeScript types;
  keep version-specific zod probes in one test/helper area.

---

## 6. Acceptance criteria

- No unrelated behavior changes to generated schemas or existing consumers.
- Existing test suites pass (refine-schema, wrapper-edge-cases,
  modifiers-and-wrappers, composition-chains, complex-types,
  async-refinements, zod4-error-formatting).
- New tests cover every supported wrapper and operation combination listed
  above.
- Unsupported zod shapes fail explicitly with actionable diagnostics.
- The Proxy implementation no longer contains one bespoke branch per format
  alias.
- Direct zod-internal access is localized to compatibility helpers.
- Public TypeScript inference remains correct for replaced, wrapped, optional,
  nullable, defaulted, and newly added fields.
- Documentation accurately describes the supported zod compatibility boundary.

---

## 7. Out of scope

- Supporting non-Zod validator targets through `refineSchema`.
- Changing the public name or semantics of `refineSchema`.
- Rewriting generated schema serialization unrelated to field refinement.
- Upgrading Zod solely for this refactor without a separate compatibility
  decision.



