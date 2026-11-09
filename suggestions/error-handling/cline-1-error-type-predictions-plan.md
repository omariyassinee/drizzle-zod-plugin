# Final Plan — Error-Type Predictions for Refined Schemas

> **Model / Agent:** Cline (`cline`)
> **Package:** `@vacuus/drizzle-validators` v0.1.32 · **Locator:** `packages/drizzle-validators`
> **Validator stack:** Zod dev `^4.4.3` / peer `^4.0.0-0` · Valibot dev `^1.5.0` / peer `^1.0.0` · TypeBox `1.1.0`
> **Status:** Ready for review. Implementable as written once the Phase 0 probes (§9) confirm the introspection assumptions (§3.4, §4.4).
> **Companions:** supersedes the roadmap placeholder `todos.txt` → `Error Types Predictions`; builds on the delivered declarative error-map engine (`src/error-map.ts`, `src/valibot-error-map.ts`).

---

## 0. Executive Summary

The package already **dispatches runtime issues to error-map keys** in both engines:

- `candidateKeys(issue, site)` (Zod, `error-map.ts` ~L294) and `checkCandidateKeys(checkDef)` (~L408);
- `candidateVKeys(issue)` (Valibot, `valibot-error-map.ts` ~L210);
- a **type-level** per-core prediction already exists as `FieldErrorMapForCore<TCore>` (`refine.ts` ~L478).

What is **missing**, and what this plan delivers, is the *inverse*, **first-class, both-direction prediction API**:

1. **Runtime**: given a *fully refined* field schema (core + wrappers + checks/pipe actions), return the **exact, deduplicated, ordered set of error keys that field can ever emit** — a `PredictedIssue`.
2. **Type**: `PredictedErrorKeys<TField>` extracts that same set as a **string-literal union** at compile time, so error-map literals and structured error handles are checked against the *actual* universe of keys a field can raise, not just its core type.
3. **Structured result**: `errorsOf(schema, input, options?)` returns typed `{ field, kind, message, ctx }` records — turning bare issues/messages into portable, serializable, framework-friendly error data (TanStack Standard Schema, RHF `fieldErrors`, API 422 bodies).
4. **Parity across all three targets** (Zod / Valibot / TypeBox) with a single, portable key vocabulary, enforced by the existing bug-repro harness pattern.

**Verdict: very feasible and low-to-medium risk.** The runtime dispatch already encodes the hard mapping rules (including the subtle `int`-vs-`invalid_type`, sized-origin, and format-parent cases). The real work is an **introspection walker** (core + check/action keys), a **type-level twin**, and **structured-issue extraction** with full parity tests. No mutation, no serializer changes, no behavior change to existing refinement.

---

## 1. Problem Statement

### 1.1 Today

A refined form schema lets you map error messages:

```ts
const schema = refineZSchema(insertUserSchema, (f) => ({
  age: f.age.min(18, { error: "You must be 18+" }),
  email: f.email.setError("A valid email is required"),
  nickname: f.nickname.pipe(v.minLength(3, "At least 3 chars")), // valibot
}), {
  age:  { too_small: "Too young" },
  email: { format: "Invalid email" },
});
```

But a consumer still gets back **library-specific issue objects** (`z.core.$ZodIssue[]`, valibot `issues`) or raw message strings. There is no way to:

- ask which error keys a field can ever raise and get a typed answer;
- render errors *programmatically* (by key, not by string) across TanStack / RHF uniformly;
- statically guarantee that an error-map literal or error-handler only references **keys that actually exist** for that field's *refined* shape (post `.as()` / `.setError()` / `.pipe()`, not just the Drizzle core);
- describe the error surface of a whole table in one object (validation hints, documentation, API error-contracts).

### 1.2 The gap this plan closes

| Existing capability | Location | Limitation |
| :--- | :--- | :--- |
| Runtime issue → key dispatch | `candidateKeys` / `candidateVKeys` | Forward only (issue ⇒ keys), not schema ⇒ keys |
| Type per-core error-map keys | `FieldErrorMapForCore` | **Core-type-only**; ignores attached checks/actions; never accounts for refinements |
| Structured error object | none | consumers get raw issues / strings |
| Build-time artifact | none | no description of a table error surface |

This plan turns the existing forward dispatch into a **reversible prediction** and adds the missing type + artifact layers, all on the **already-unwrapped/refined** field view so it composes with `.as()`, `.setError()`, `.pipe()`, `.required()`, `.nonnullable()`.

---

## 2. Design Goals

1. **G0 — No behavior change to refinement.** Prediction is a pure, read-only introspection layer. It must not mutate schemas, not alter emitted code, and not affect parse results (C1 invariant, same as the error-map engine).
2. **G1 — Exact key set.** `predictedKeys(schema)` must reproduce, bit-for-bit, the keys the runtime dispatch *could* emit for that schema across **all possible inputs** — including the edge cases in §5.
3. **G2 — Type safety.** The type-level extraction must match the runtime walker for every case where the type can know the checks (static literals), and degrade to a documented superset when it cannot (context-sensitive callbacks, untagged `.pipe()`).
4. **G3 — Cross-target parity.** One portable key vocabulary for Zod, Valibot, and TypeBox. Where a target has no native equivalent of a key, that key is simply absent from its prediction (it can never fire).
5. **G4 — Consumer-friendly.** `errorsOf` returns plain, serializable objects; works on the server (422 bodies) and the client (forms).
6. **G5 — Tree-shakeable & zero cost when unused.** All prediction code lives behind explicit subpath imports; never pulled into bundles unless used.

---

## 3. Core Concept: the Prediction Model

### 3.1 Terminology

- **Key** — a string in the portable vocabulary (`"required"`, `"min_length"`, `"email"`, `"not_multiple_of"`, `"invalid_union"`, …). Identical set to `VALID_MAP_KEYS` / the `FieldErrorMapV` fields today.
- **Core keys** — keys a field can raise from its *core* schema def, independent of checks (e.g. `required`, `null`, `invalid_type`, `invalid_value`, `unrecognized_keys`, `invalid_union`). From `CORE_ONLY_KEYS`.
- **Check/action keys** — keys a specific attached check or pipe action can raise (e.g. `min_length` from `.min(3)`). From `checkCandidateKeys` / `SPECIFIC_FORMAT_ACTIONS`.
- **PredictedIssue** — runtime result: `{ keys, meta, coreType }` where `meta` carries per-key contextual hints (§3.3).
- **PredictedErrorKeys<TField>** — type-level result: a string-literal union of the same keys.

### 3.2 The prediction walker (conceptual)

```
predictedKeys(field)
  ── unwrapAll(field)                     // core + wrappers (reuse existing)
  ├── coreKeys = coreKeySet(core.site)    // required/null/invalid_type/... by core type
  │                (+ enum → invalid_value, object → unrecognized_keys,
  │                   union → invalid_union, picklist → invalid_value)
  └── checkKeys = Σ checkKeySet(check)    // for each def.checks[] (zod) or pipe action
                     min_length    → [min_length, min, too_small]
                     string_format → [<format>, format, invalid_format] (+ parent)
                     number_format → [int]                     // never invalid_type
                     multiple_of   → [multiple_of, not_multiple_of]
                     custom/check  → [custom]
  keys = dedupe( coreKeys ∪ checkKeys ), order: core-first, then check order
```

This is the **schema ⇒ keys** inverse of `candidateKeys` / `candidateVKeys`. Because dispatch is deterministic per `(site, check)` and prediction enumerates the same site/check universe, the two are provably inverse for the keys the runtime can ever produce.

---

### 3.3 Per-key context (`meta`)

Each predicted key can carry a small, static hint derivable from the schema def (no parsing required):

- `min_length` → `{ minimum: <value>, inclusive: true }` from `.min(n)`
- `max_length` → `{ maximum }`
- `length` → `{ length }` from `length_equals`
- `email` / `url` / … → `{ format: "email" }`
- `not_multiple_of` → `{ multipleOf }` from `.multipleOf(n)`
- `regex` → `{ pattern }`
- `min_value` / `max_value` → `{ minimum }` / `{ maximum }` from `.min(n)` / `.max(n)` on numbers

These are **best-effort hints** for UI labels ("must be at least 18") — never asserted at runtime. Where the requirement is not a static literal (a function, `z.lazy`), `meta` is omitted and the key degrades gracefully.

### 3.4 Introspection surface required

Reuses existing, proven primitives — **no new version assumptions**:

| Need | Zod | Valibot |
| :--- | :--- | :--- |
| Core & site | `getZodDef` (type, format), `siteOf` | node `.type`, `pipe[0]` |
| Checks | `def.checks[]`, `getZodDef(check)`, `checkCandidateKeys` | `node.pipe.slice(1)` actions (`kind==="validation"`) |
| Wrappers | `unwrapAll` / `isExactOptionalSchema` | `unwrapAllV` (`OPTIONAL_TYPES`, `NON_TYPES`) |
| Format resolution | `resolveStringFormatName` | action `.type` in `SPECIFIC_FORMAT_ACTIONS` |
| Enum / object / union | `def.type` ∈ `enum`/`literal`, `object`, `union` | `.type` ∈ `picklist/literal/enum`, `object/strict_object`, `union/variant` |

**Phase 0 probes (§9)** confirm: `def.checks` non-empty access (Zod 4.4 cross-version stability), `pipe[0]` / `pipe.slice(1)` shape (Valibot 1.5), TypeBox `[Kind]`+`options`+`value` introspection.

---

### 3.5 Where the type-level twin differs from runtime

`FieldErrorMapForCore` yields a *static, per-core-type* key set. The new `PredictedErrorKeys<TSchema>` must additionally reflect *checks*, which is only fully possible when the schema is passed as a **concrete** type value (Zod 4 types do not encode per-check constraints — checks are runtime). Therefore a **hybrid** design:

1. **Concrete refined type**: `PredictedErrorKeys` unions core keys with a *broad, sound* check contribution keyed off which builder/wrapper the type reveals — a **sound superset** (may include keys the runtime predicts, never misses any).
2. **Exactness**: the runtime `predictedKeys()` (hence `errorsOf`) is the source of truth; the type-level API is a *validation* layer, not a substitute.

This mirrors the compromise already documented for context-sensitive callbacks (`AnyCoreErrorKeys` superset): exactness where types can, a sound superset where they cannot, and the runtime as the always-exact authority.

---

## 4. Public API Surface

All new exports live in **new subpath entries** to preserve tree-shaking (G5):

| Subpath | Exports |
| :--- | :--- |
| `@vacuus/drizzle-validators/predictions` | Zod: `predictedKeys`, `PredictedIssue`, `FieldErrorRecord`, `PredictedErrorKeys<T>`, `errorsOf` |
| `@vacuus/drizzle-validators/predictions/valibot` | Valibot mirror (`predictedVKeys`, `errorsOfV`) |
| `@vacuus/drizzle-validators/predictions/typebox` | `predictedTKeys` + artifact shape |
| (re-exported from `./refine` and `./refine/valibot` for convenience) | same named exports |

**TypeBox note:** TypeBox has no issue objects; the plan ships *artifact* generators (§7) but not `errorsOf` (parity §3.4 — keys with no runtime issue are simply absent).

### 4.1 `predictedKeys` (runtime, Zod)

```ts
export interface PredictedIssue {
  keys: readonly string[];   // ordered, deduped, core-first
  meta: Record<string, Record<string, unknown> | undefined>;
  coreType: {
    type?: string; format?: string;
    sizedOrigin: boolean; intCheck: boolean;
    isEnum: boolean; isObject: boolean; isUnion: boolean;
  };
}

export function predictedKeys(
  field: z.ZodTypeAny,
  options?: { includeCore?: boolean; includeChecks?: boolean },
): PredictedIssue;
```

- Defaults: both core and checks, deduped.
- `includeCore:false` → only check-derived keys (the "which message keys could `.setError` style" view).
- Never throws for unknown defs: unknown cores contribute the full fallback set (mirroring `AnyCoreErrorKeys`), so the API is total and under-prediction is impossible.

### 4.2 `PredictedErrorKeys<TField>` (type, Zod)

```ts
export type PredictedErrorKeys<TField extends z.ZodTypeAny> =
  CoreKeysOf<DeepUnwrap<TField>>   // reuses the FieldErrorMapForCore branch switch
  | CheckKeysOf<TField>;           // sound superset from wrappers/builders (§3.5)
```

Guarantee: `keyof FieldErrorMap ⊇ PredictedErrorKeys<TField>` always holds, so a `SchemaErrorMap`-shaped literal typed against these keys is assignable. Catches typos at compile time and documents the full error surface.

### 4.3 `errorsOf` (runtime, structured results)

```ts
export interface FieldErrorRecord {
  field: string | (string | number)[];
  kind: string;                 // guaranteed ∈ predictedKeys(field).keys
  message: string;
  ctx?: Record<string, unknown>;
  path?: PropertyKey[];
  input?: unknown;
}

export function errorsOf(
  schema: z.ZodObject<any>,
  input: unknown,
  options?: {
    sparse?: boolean;    // first issue per field only (form-style)
    nested?: boolean;    // recurse into object errors (default true)
    errorMap?: unknown;  // optional: honor an existing SchemaErrorMap
  },
): FieldErrorRecord[];
```

**Behavior contract:**
- Runs `safeParse`; for each issue resolves the **winning key** via `candidateKeys(issue, site)` (the same logic already selecting the mapped message);
- emits one record per issue (unless `sparse`);
- `kind` is always in the *predicted* set for that field — asserted by the inverse-property tests (§10.2);
- plain, JSON-serializable output for 422 bodies.

---

### 4.4 Valibot / TypeBox mirrors

- `predictedVKeys(schema, opts?)` — walker over `pipe` actions using `SPECIFIC_FORMAT_ACTIONS` + `pipe.slice(1)`.
- `errorsOfV(schema, input, opts?)` — maps valibot `issues` via `candidateVKeys`, returns the same `FieldErrorRecord[]`.
- **TypeBox:** `predictedTKeys(schema)` from `[Kind]` + `options` (+ `value` for enums). No `errorsOfT`. §3.4 key-absence rule applies.

---

## 5. Exact Key-Set Semantics (the non-trivial core)

Pins the **exact** prediction for the edge cases that already make the runtime dispatch subtle. These are **golden rules**; each becomes a test (§10).

### 5.1 `int` vs `invalid_type` (Zod finding #5, already in the engine)

- A `number` field with format `safeint`/`int` (`.int()` or `z.int()`) predicts `["int"]` — **never** `invalid_type`, despite Zod emitting `code:"invalid_type", format:"safeint"` for non-integers. Reproduce `siteOf(...).intCheck`.

### 5.2 Sized-origin (`min`/`max` vs `min_length`/`max_length`)

- Core `string`/`array`/`set`, or check origins `string/array/set`, predict `min_length`+`min` for `too_small`, `max_length`+`max` for `too_big`.
- Number/date/bigint predict only `min`+`too_small` / `max`+`too_big`.
- `length_equals` / `.length(n)` predicts `["length","too_small","too_big"]`.
- Mirror `sizedOrigin` exactly (`check∈min_length|max_length|length_equals || type∈string|array|set`).

### 5.3 Format parents and specific-format keys

- `uuidv4`/`uuidv6`/`uuidv7` also predict `uuid` (`FORMAT_PARENT`); `httpUrl` → `url`.
- Any specific format key (`email`, `url`, …) also predicts `["<key>","format","invalid_format"]`.
- A plain `z.string()` with **no** format check predicts **no** `invalid_format` — it guards `invalid_type` only. This is the most-commonly-wrong manual guess; dedicated test.

### 5.4 Presence keys are core-only and wrapper-aware

- `required`/`null` predict only when the **final** (post-refinement) core is still a required / non-nullable path.
- `.optional()` → drop `required`; `.nullable()` → drop `null`; `.nullish()` → drop both. Matches how runtime dispatches `required`/`null`.

### 5.5 Enum / object / union

- enum/picklist/literal cores → `["invalid_value","invalid_type"]`.
- union/variant cores → `["invalid_union","invalid_type"]`.
- strict object → `["unrecognized_keys"]` (only when strict / `stripUnknown=false`).

### 5.6 Custom / check actions

- `.check(pred)` / `.superRefine` / `.refine` → `["custom"]`.
- Valibot `.check` / `.raw_check` / `.partial_check` → `["custom"]`.

### 5.7 Dedup and ordering

- Dedupe while preserving **core-first, then check-appearance order**; deterministic and snapshot-friendly.
- A key the core yields and a check re-issues still appears once (set semantics); ordering is best-effort but stable across runs.

### 5.8 Wildcards and unknown cores

- Unknown/opaque cores contribute the **full fallback set** (all documented keys) — mirroring `AnyCoreErrorKeys`; keeps the API total and never under-predicts.

---

## 6. Type-Level Design

### 6.1 Core extraction

```ts
type CoreKeysOf<T> =
  [T] extends [ZodString | ZodStringFormat] ? CoreStringKeys
  : [T] extends [ZodNumber]                 ? CoreNumberKeys
  : [T] extends [ZodBigInt]                 ? CoreBigIntKeys
  : [T] extends [ZodDate]                   ? CoreDateKeys
  : [T] extends [ZodBoolean]                ? CommonKeys
  : [T] extends [ZodArray<any> | ZodSet<any>] ? SizedContainerKeys
  : [T] extends [ZodEnum<any> | ZodLiteral<any>] ? ChoiceKeys
  : [T] extends [ZodObject<any>]            ? ObjectKeys
  : AnyCoreKeys;
```

Theme: **reuse `FieldErrorMapForCore`'s branches verbatim** so dispatch and prediction can never drift — share the branch table via one `CoreKeySet` mapping.

### 6.2 Check contribution (superset, sound)

Because Zod 4 types do not encode per-check constraints, `CheckKeysOf<T>` is a **documented superset** gated on the refinement the type reveals:

```
PredictedErrorKeys<T> =
    CoreKeysOf<DeepUnwrap<T>>
  | CheckProbeKeys<T>   // min/max/length/format/not_multiple_of/regex …
                        // widest for concrete types; generic superset for inferred ones
```

`CheckProbeKeys` narrows for concrete builder results when the type can carry the info, and defaults to the generic superset for context-sensitive/inferred fields. The type-level result is used **only to validate** map literals and handler exhaustiveness; the runtime `predictedKeys` is exact.

### 6.3 Interaction with existing error-map types

- Keep `FieldErrorMapForCore` and `SchemaErrorMap` untouched (back-compat).
- Add an **opt-in** marker `{ predictions: true }` on the 3-arg `refineZSchema` / `refineVSchema` form that switches the map type to `PredictedErrorKeys`-narrowed. Default behavior unchanged (G0).

---

## 7. Build-Time Artifact (optional, `dv predict`)

A new CLI/plugin capability that **emits a JSON description of the predicted error surface** per table:

```jsonc
// {outputPath}/errors.json or the virtual module below
{
  "schemaHash": "sha256:…",
  "tables": {
    "users": {
      "insertSchema": {
        "email": { "keys": ["required","invalid_type","email","format","invalid_format"], "meta": { "email": { "format": "email" } } },
        "age":   { "keys": ["required","invalid_type","int","too_small","min"], "meta": { "too_small": { "minimum": 18 } } }
      }
    }
  }
}
```

- Reuses `schema-generator.ts` walk + `cache.ts` (target/key versioning; `CACHE_VERSION` bump).
- Served as virtual module `virtual:drizzle-validators/errors` (dev) and writable to `outputPath` (build) — mirroring the existing generated-schema flow.
- Drives: client-side *adaptive* hints, exhaustive form errors without re-parsing, docs, API error-contracts.
- Opt-in (`emitErrors: true`), off by default, tree-shakable.
- TS types for the artifact emitted in lock-step via `dts-builder.ts`.

---

## 8. Implementation Plan (phased)

### M0 — Shared core model (no behavior change)
1. `src/predictions/core.ts`: `PredictedIssue`, `FieldErrorRecord`, `ErrorRecordCtx` types, plus the **single source-of-truth** `PREDICTED_KEYSETS` table that maps `(coreType | checkKind) → keys` by reusing `siteOf` / `sizedOrigin` / `intCheck` / `SPECIFIC_FORMAT_*` / `resolveStringFormatName`. **Extract** the branch tables out of `error-map.ts` / `valibot-error-map.ts` as *pure data* so dispatch and prediction share one table (no drift). Public exports of `error-map.ts` stay unchanged.
2. `src/predictions/types.ts`: `PredictedErrorKeys<T>`, reusing the `FieldErrorMapForCore` branch switch.
3. **Accept:** existing suite green; zero diff in generated output.

### M1 — Zod runtime walker
4. `predictedKeys(field, opts?)` in `src/predictions/zod.ts` (`unwrapAll`, `getZodDef`, `siteOf`, `checkCandidateKeys` enumeration).
5. `errorsOf(schema, input, opts?)` — `safeParse` → per-issue key resolution → `FieldErrorRecord[]`.
6. Subpath `src/predictions/index.ts` + `package.json` (`./predictions`) + `build.ts` entrypoint.
7. **Tests:** `predictions-zod.test.ts` (edge cases §5), `errors-of.test.ts`.

### M2 — Valibot walker + errorsOfV
8. `predictedVKeys` / `errorsOfV` in `src/predictions/valibot.ts` (mirror M1, using `pipe.slice(1)`, `SPECIFIC_FORMAT_ACTIONS`).
9. Subpath `./predictions/valibot` + `build.ts` entrypoint.
10. **Tests:** `predictions-valibot.test.ts` (mirror matrix).

### M3 — Type-level extraction + refine opt-in
11. `PredictedErrorKeys<T>` + the opt-in marker (§6.3).
12. 3-arg `refineZSchema` / `refineVSchema` narrows map types when `{ predictions: true }`.
13. **Tests:** `predicted-keys-types.test.ts` (expect-error + assignability, context-sensitive superset path).

### M4 — TypeBox artifact + `dv predict` + virtual module
14. `predictedTKeys` in `src/predictions/typebox.ts`.
15. CLI `dv predict [--json]` + artifact writer + `virtual:drizzle-validators/errors`; `emitErrors` option.
16. `dts-builder.ts` emits `errors.d.ts` types in lock-step.
17. **Tests:** `predictions-typebox.test.ts`, CLI artifact golden snapshot.

### M5 — Dogfood + docs
18. Consume `errorsOf` in the RHF / TanStack playgrounds (render by `kind`, not string).
19. README `## 🧠 Error Predictions` section + `errorsOf` example.
20. **Accept:** full suite green; playgrounds render predicted-key-driven errors.

### Deferred — explicitly NOT in scope
- Auto-message *generation* from `meta` (a UI feature, not a library concern).
- Per-key rule weighting / "which key fires first" arena.
- ArkType target (no adapters yet).
- Any default-signature change to `refineZSchema`/`refineVSchema` beyond the opt-in marker.

---

## 9. Phase 0 Probes (de-risk before M1)

Quick throwaway scripts (existing `tmp-out` pattern, gitignored):

- **P0-01** `def.checks` access for `.min/.max/.email/.multipleOf` across Zod `^4.4.x` — confirm `getZodDef(check).check` key strings are stable. (Expect pass — the error-map engine already relies on it.)
- **P0-02** Valibot `pipe` = `[baseSchema, ...actions]`, action `.type`/`.kind`, `SPECIFIC_FORMAT_ACTIONS` completeness. (Expect pass, per `adapters/valibot.ts`.)
- **P0-03** TypeBox `[Kind]`/`options`/`value` introspection for Object/Union/Array/Enum/String constraints. (Expect pass.)
- **P0-04** Zod 4.6 `def.error` fallback on check issues — confirm the **winning** key for a check issue is `checkCandidateKeys`-resolved, not the core's (mirror in `errorsOf`). (Expect pass.)

If any probe fails, the affected section falls back to a documented **superset** (§5.8) rather than blocking the feature.

---

## 10. Test & Parity Strategy

Extend the `bug-repro/` convention with a `tests/predictions/` suite:

1. **Golden key-set snapshots** — a fixed matrix (reuse `tests/fixtures/complex-schemas.ts`, `adapter-table.ts`) asserting `predictedKeys(...).keys` per §5 edge case.
2. **Inverse-property test** — for a corpus of inputs, `errorsOf` every `kind ∈ predictedKeys(field)`; assert **no** emitted `kind` outside the predicted set (soundness) and that every predicted key fires at least once across adversarial inputs (completeness). The strongest guarantee in this plan.
3. **Cross-target parity** — Zod vs Valibot on the same fixture produce the *same* key set **modulo** target-absent keys; TypeBox keys ⊆ the union.
4. **Type-level tests** — `expect-error` on an unmapped key literal; assignability of a known-valid literal; the context-sensitive superset path compiles.
5. **Regression** — existing suite remains green (G0 proof).

Success metric: `bun test` green; inverse property holds with **zero** `kind`-leaks; `bun check` passes.

---

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
| :--- | :--- | :--- |
| `def.checks` key-string drift across Zod minors (P0-01) | wrong key set | Phase 0 probe; assert key strings; fallback to superset |
| Type-level cannot see checks → false confidence | type escapes runtime (G2 weakened) | document superset; runtime authoritative; strict-mode option |
| Valibot action taxonomy incomplete | missed keys | probe + `SPECIFIC_FORMAT_ACTIONS` audit; superset fallback |
| `errorsOf` message resolution racing check/core fallback (P0-04) | wrong kind/message pairing | P0-04 probe + mirror rule; dedicated sparse tests |
| Scope creep into message-generation | bloat | explicit Deferred list (§8) |
| Serializer/artifact format coupling | cache churn | reuse `cache.ts` target/key + `CACHE_VERSION` bump |

---

## 12. Acceptance Criteria

1. **G0:** existing `bun test` (269/269) and `bun check` still pass with **zero** behavior diff.
2. **G1:** the inverse-property test (§10.2) passes — no `kind`-leaks and complete firing for the corpus.
3. **G2/G3:** parity matrix green; `PredictedErrorKeys` compiles against valid maps and flags invalid ones.
4. **G4:** `errorsOf` returns plain JSON-serializable records; RHF + TanStack playgrounds consume by `kind`.
5. **G5:** `predictions` is a separate subpath; importing it does not pull the other validator's namespace (asserted by an import-graph test like the existing `refine-treeshaking.test.ts`).
6. **Docs:** README + a `predictions/` example page; `todos.txt` `Error Types Predictions` item marked done.

---

## 13. Suggested File Map (new/changed only)

```
src/predictions/core.ts        # shared types + single PREDICTED_KEYSETS table
src/predictions/types.ts       # PredictedErrorKeys<T> (shares FieldErrorMapForCore switch)
src/predictions/zod.ts         # predictedKeys, errorsOf
src/predictions/valibot.ts     # predictedVKeys, errorsOfV
src/predictions/typebox.ts     # predictedTKeys (+ artifact shape)
src/predictions/index.ts       # subpath barrel
src/predictions/valibot/…      # valibot subpath barrel
src/cli.ts, src/plugin.ts, src/artifacts.ts, src/dts-builder.ts, src/types.ts
                               # dv predict, emitErrors, virtual:…/errors, errors.d.ts
package.json, build.ts         # ./predictions(+ /valibot) subpaths + entrypoints
tests/predictions/*.test.ts    # golden, inverse, parity, types, tree-shaking
playgrounds/rhf-zod, playgrounds/tanstack-form   # errorsOf-by-kind consumption
suggestions/error-handling/    # this plan (winner) placed here
```

---

## 14. Open Questions for the Review Board

1. **Scope of `errorsOf` `ctx` hints:** derive them from schema defs (no parse, recommended) or also accept runtime issue `ctx` (Zod check `ctx`, valibot issue payloads) for richer hints? Recommendation: schema-def hints only, keeping prediction pure and reproducible.
2. **Opt-in shape on `refineZSchema`:** a `{ predictions?: boolean }` marker on the 3-arg form (recommended, ergonomic) *and* a standalone `SchemaErrorMapPredicted` helper type for library authors?
3. **Artifact granularity:** per-table JSON (recommended), one aggregate `errors.json`, or both via `splitByTable`?
4. **`errorsOf` + middleware:** should `errorsOf` run the roadmap `Middleware` presets (empty-string normalization) before parsing? Recommendation: **no** coupling now — expose `preprocess` hooks later so prediction and normalization stay independent.

---

## Appendix A — Relationship to Existing Code (quick index)

| Concern | Existing | This plan |
| :--- | :--- | :--- |
| Forward issue→keys | `error-map.ts` `candidateKeys`/`checkCandidateKeys`; `valibot-error-map.ts` `candidateVKeys` | reused verbatim (the winning key in `errorsOf`) |
| Schema unwrap / wrappers | `refine.ts` `unwrapAll`/`applyWrappers`; `refine/valibot` `unwrapAllV` | reused by the walker |
| Type per-core keys | `refine.ts` `FieldErrorMapForCore` | new `PredictedErrorKeys` sharing its branch table |
| Introspection | `zod-compat.ts` `getZodDef`/`cloneSchemaWithDef`; `constants.ts` `STRING_FORMAT_NAMES` | reused |
| Artifact/build/cache | `schema-generator.ts`, `cache.ts`, `artifacts.ts`, `dts-builder.ts` | `dv predict` + `virtual:…/errors` reuse the same flow |
| No-mutation invariant | C1 across the error-map engine | carried into every prediction function |

---
