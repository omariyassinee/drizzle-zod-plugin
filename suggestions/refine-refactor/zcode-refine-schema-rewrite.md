# `refineSchema` Rewrite Plan

> Status: **proposal — no code changed.** Written after a full audit of
> `packages/drizzle-validators/src/refine.ts` (~600 lines) and its test suite.

## 0. Executive summary

The current `refineSchema` is a Proxy that impersonates Zod schemas. That design
buyed fluent DX at the cost of everything else: the method set is a hardcoded
whitelist (`asEmail`/`asUuid`/... are five duplicated trap branches), error
overrides are deep surgery on Zod 4 internals with the wrong granularity, the
wrapper model handles exactly four wrapper types (so a growing class of fields —
unions, enums, dates, `readonly`, `catch` — simply cannot be refined, P2-01),
the return types are a type-level reconstruction that must mirror the runtime or
lie, and the whole thing is Zod-only in a package that now has three targets.

The proposal: replace proxy-magic with a **descriptor-based `refine`** —
refinements are plain data, applied by a small engine with a **wrapper registry**
and a **format registry**. Method sets stop growing (new formats and wrappers
become data, not code), whole-field replacement works for *any* schema kind,
error handling gets correct granularity, and the descriptor core is
library-agnostic — the only route to `refineSchema` for Valibot/TypeBox.

Phased: Phase 1 ships the descriptor engine for Zod alongside the current API;
Phase 2 deprecates the proxy; Phase 3 (gated) adds non-Zod appliers.

## 1. Verified problems in the current design

Everything below is grounded in `src/refine.ts` as of today:

| # | Problem | Where | Consequence |
|---|---|---|---|
| 1 | **Proxy impersonation** — every field access is trapped; unknown methods are re-bound via `(...args) => core[prop](...args)` + re-wrap | `wrapFieldProxy` :447-556 | Unbounded, untestable surface. Breaks on methods returning non-schemas (`.pick()`, `.extend()`), getters, symbol keys, and any Zod internal change. `has` (:451-466) hardcodes the capability list. |
| 2 | **Closed method set** — `asEmail/asUrl/asUuid/asCuid2/asUlid` are five copies of the same branch; `format(name)` (:476) already does all of them generically | :492-535 | The "workaround" feeling: a hardcoded whitelist where a registry belongs. Every new format = new trap branch + new type member + new docs. |
| 3 | **`setError` is deep internals surgery with wrong granularity** — clones every check via its constructor, re-instances the schema via `_zod.constr`, re-attaches default getters (P2-04) — and one message overrides **all** existing checks on the field | `setErrorOnField` :162-224 | Maximally version-coupled (P2-04 existed precisely because of a def-getter detail). You cannot target a single check; "override the email check's message" is impossible without nuking the rest. |
| 4 | **Invisible check-transfer heuristic** — a core swap silently decides which existing checks survive via `CHECK_CORE_COMPAT` | :293-306, `transferChecks` :321-358 | Surprising lossiness: `.min(5)` survives an email→uuid swap, transforms are dropped, and each surprise becomes a bug report (P2-03, P2-18). |
| 5 | **Four-wrapper-only model** — `unwrapAll`/`applyWrappers` and the `DeepUnwrap`/`PreserveWrapper` types handle optional/nullable/exactOptional/default and nothing else | :54-148, :403-426 | `z.readonly()`, `z.catch()`, `z.brand()`, pipes/transforms are invisible at runtime *and* in the types — hence P2-01's blanket fail-loud on refining union/enum/date/record/tuple fields. Honest, but the "can't refine" class grows with every Zod release. |
| 6 | **Types are a reconstruction, not a derivation** — `PreserveWrapper` re-derives the wrapper stack by conditional-type pattern matching, duplicating the runtime logic | :414-426 | The types must mirror `applyWrappers` exactly or they lie. Each new wrapper type means extending both. Already 4-deep nested conditionals; TS performance degrades on big schemas. |
| 7 | **Zod-only by construction** — everything above duck-types `_zod.def`/`_zod.traits` | whole file | The package's multi-target story (Zod/Valibot/TypeBox) has no refinement story and this architecture cannot provide one. |

**Root cause:** the API is *method-shaped but mutation-based*. It promises
"fields are still Zod schemas" (so you can chain anything), while actually
reconstructing them through internals. The more faithfully the proxy impersonates
Zod, the larger the trap surface — it cannot be made both fluent and robust.

## 2. Design space

| Option | Idea | Verdict |
|---|---|---|
| A. Keep the proxy, patch gaps | Extend traps, add more wrapper cases | Rejected: surface grows without bound; stays Zod-only; every problem in §1 recurs. |
| B. **Descriptor-based `refine` (recommended)** | Refinements are plain data — one engine, two registries, per-target appliers | Accepted. Removes the Proxy entirely; scales by data; library-agnostic core. |
| C. Codegen-time refinement | Hook drizzle's own per-field override callbacks at generation time | Complementary but a different product surface (generation vs post-hoc refinement). Deferred — see §7. |
| D. Fluent builder objects (no Proxy) | `f.email.min(18)` on real builder objects | Good DX, but keeps the surface method-shaped and per-target. Considered as optional sugar in Phase 3, gated on user feedback. |

## 3. Recommended design: descriptor-based `refine`

```ts
import { insertSchema } from "virtual:drizzle-validators/usersTable";
import { refine } from "@vacuus/drizzle-validators/refine";
import { z } from "zod";

const refined = refine(insertSchema, {
  // format from a registry — replaces the whole as* family
  email: { format: "email", error: "Please enter a valid email address" },

  // new checks, construction-time error (correct granularity)
  age: { check: z.number().min(18), error: "Must be 18 or older" },

  // whole-field replacement — works for ANY schema kind, wrappers preserved
  role: { replace: z.enum(["admin", "user", "superadmin"]) },

  // constraint-only patches on the existing core
  bio: { maxLength: 200, optional: true },

  // explicit relabeling of EXISTING checks — scoped, opt-in, deep operation
  url: { format: "url", relabelAll: "Please provide a valid link" },

  // escape hatch: full control, you get the raw field, you return a raw schema
  meta: (field) => myCustomFieldSchema,
});
```

### 3.1 The engine

- **No Proxy.** `f.email` is a plain value in a plain object literal. Keys are
  real, autocomplete is real, a typo is a TS error instead of a silent pass-through.
- **Wrapper registry** — replaces `unwrapAll`/`applyWrappers`/`PreserveWrapper`:

  ```ts
  interface WrapperRecipe<TIn, TOut> {
    /** Detect this wrapper on a schema (def.type / traits / kind). */
    detect(schema: unknown): boolean;
    /** Rebuild this wrapper around a new inner schema, preserving def data. */
    rewrap(inner: Schema, original: Schema): Schema;
  }
  const WRAPPERS: WrapperRecipe[] = [optional, nullable, default, exactOptional, readonly, catch_];
  ```

  New wrapper support is **data**, not a rewrite. `PreserveWrapper` types die —
  see §3.3.
- **Format registry** — one function keyed by `STRING_FORMAT_NAMES`
  (`src/constants.ts`), shared with the serializer so the lists cannot drift
  (same pattern as `KNOWN_FORMATS`). `format: "email"` and `format: someZodSchema`
  are the same parameter (accept a name *or* a schema). The `as[Format]` family
  disappears because `format: "email"` *is* the API.
- **Explicit check-transfer policy** — replaces the invisible heuristic:

  ```ts
  { format: "uuid", keep: "compatible" }  // default: type-compatible checks (today's behavior, now visible)
  { format: "uuid", keep: "all" }         // force-transfer everything
  { format: "uuid", keep: "none" }        // clean core
  ```

  The `CHECK_CORE_COMPAT` map survives, but as an implementation detail of the
  documented `"compatible"` policy — not an un-asked-for decision.
- **Error handling, split by granularity:**
  - `error` — applied **at construction** of the checks the descriptor itself
    introduces. Version-proof (public API, no internals).
  - `relabelAll` / `relabel: { gte: "...", format: "..." }` — the only paths
    that touch existing checks. The P2-04 deep-clone machinery survives, but
    confined to ONE audited function (`relabelChecks`) that is explicitly
    documented as the single internals-coupled spot. Granularity by check kind
    (gte/lte/regex/format/...) instead of "everything at once".

### 3.2 What this fixes immediately

- **P2-01 fail-louds become supported operations**: `{ replace: ... }` swaps the
  core of a union/enum/date/tuple/record field wholesale — no unwrapping of
  foreign kinds needed, wrappers re-applied by the registry.
- **`setError`'s all-checks override** is no longer the only option; the default
  (`error` at construction) touches nothing existing.
- **The as* workaround** collapses into one registry entry per format.
- **Scalability**: new format → registry entry. New wrapper → registry entry.
  New capability → descriptor field. No trap branches, no type additions.

### 3.3 Type-level design

- **No reconstruction.** The output schema's type is derived from what the
  applier constructs (a plain `z.ZodObject<...>` built at runtime and typed via
  the engine's return type) — `PreserveWrapper`/`DeepUnwrap` are deleted.
- **Descriptor keys are constrained by the input shape**: for each `K in keyof
  T["shape"]`, the descriptor is narrowed by the field's inferred kind
  (`format` only offered on string cores; `min`/`max` only on numeric cores).
  Wrong-kind usage is a compile error, not a runtime surprise.
- **Escape-hatch callbacks** (`meta: (field) => ...`) are typed loosely on
  purpose — full control, full responsibility.

### 3.4 Multi-validator path (the real scalability win)

Descriptors are library-agnostic. The engine lowers them per target:

```
refine(schema, descriptors)
  └─ applier for the schema's target
       ├─ applierZod      (Phase 1)
       ├─ applierValibot  (Phase 3, gated)
       └─ applierTypebox  (Phase 3, gated)
```

The proxy architecture can never do this — `unwrapAll` is Zod-duck-typing to its
core. The descriptor architecture makes Valibot/TypeBox refinement a new applier,
not a rewrite. (Note: descriptors referencing Zod schemas in `check`/`replace`
are Zod-specific sugar; those keys become per-target at Phase 3 — e.g. Valibot
appliers accept `v.*` actions. The registry/`format`-by-name path is already
target-agnostic.)

## 4. Naming & compatibility

- New API exports as **`refine`** from `@vacuus/drizzle-validators/refine`.
- The current proxy implementation ships alongside as
  `refineSchema` (unchanged, deprecated in docs — see Phase 2) so nothing
  breaks on upgrade.
- Generated barrels keep re-exporting whatever the target supports; for zod they
  export BOTH `refineSchema` (legacy) and `refine` until the major that removes
  the legacy one.

## 5. Phased plan (risk-triaged)

### Phase 1 — descriptor engine for Zod (the core, low risk)
1. `src/refine-v2/` package-internal: descriptor types, wrapper registry
   (4 current + `readonly` + `catch`), format registry (from
   `STRING_FORMAT_NAMES`), check-transfer policy, `relabelChecks` (the single
   internals-coupled function, ported from `setErrorOnField` with P2-04's
   getter preservation).
2. `refine()` entry + `refineSchema` kept untouched as legacy alias.
3. Parity: port the existing behavioral matrix — `tests/refine-schema.test.ts`,
   `composition-chains`, `modifiers-and-wrappers`, `wrapper-edge-cases`,
   `complex-types`, `async-refinements`, and `bug-repro` P2-01…P2-04/P2-18 —
   expressed as descriptors, asserting identical parse behavior.
4. New edge tests: `readonly`/`catch` wrappers preserved, union/enum `replace`,
   `relabel` granularity, `keep` policies, descriptor-vs-kind type errors.

### Phase 2 — deprecation & docs
1. Mark legacy `refineSchema` `@deprecated` (JSDoc + README banner); no runtime
   behavior change.
2. README: new "Refining schemas" section built around descriptors; migration
   table (`asEmail()` → `format: "email"`, `setError()` → `relabelAll`,
   `.as(x)` → `replace`); demo switches to `refine`.

### Phase 3 — gated, only on user signal
- Valibot / TypeBox appliers.
- Optional fluent builder sugar over descriptors (Option D) if the descriptor
  DX is judged too heavy for form code.

## 6. Testing strategy

- **Behavioral parity** (highest value): for every existing refine test, run the
  old and new APIs against the same inputs and assert identical
  `parse`/`safeParse` outcomes — this is what catches subtle engine drift.
- Golden error-output tests for `relabel` (message maps, fallbacks).
- Type-level compile tests: descriptor keys rejected per field kind; wrapper
  types preserved without reconstruction.
- Internals-coupling canary: a test that runs `relabelChecks` against a matrix
  of wrapper/check shapes so a Zod patch surfaces as a precise failure, not a
  user bug report.

## 7. Explicitly deferred — NOT part of this rewrite

| Item | Why |
|---|---|
| Removing legacy `refineSchema` | Breaking; keep through at least one major with deprecation notices. |
| Valibot / TypeBox appliers | Gated on Phase 1 landing and user signal (consistent with the repo's triage). |
| Fluent builder sugar | Phase 3, only if descriptors feel heavy in real form code. |
| Codegen-time refinement hooks (Option C) | Different product surface; revisit only if post-hoc refinement proves insufficient. |
| Per-check positional relabeling (e.g. "the 2nd check") | Kind-keyed `relabel` covers the real use cases; positional is brittle by nature. |
| Async refinements / transformations as first-class descriptors | The escape-hatch callback covers them; adding structure here is speculative. |

## 8. Honest limits

- Any operation that *rewrites existing checks* (`relabelChecks`) remains
  Zod-internals-coupled no matter the architecture — Zod 4 has no public API for
  it. The rewrite shrinks that surface from "every method call on every field"
  to one named function with a canary test.
- Descriptors trade chainable DX for explicitness. The escape-hatch callback
  keeps full power available, but simple things become slightly more verbose
  (`{ maxLength: 200 }` vs `.max(200)` — arguably clearer, still a tradeoff).
- `keep: "compatible"` remains a policy over a compatibility map — it is now
  documented and optional, but it is still a judgment call, not a theorem.
