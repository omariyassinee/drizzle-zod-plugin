# Plan: Make `refineSchema` Scalable and Robust

## Goal

Refactor `refineSchema` so its field API is easier to extend, its schema
transformations are isolated and predictable, and its reliance on Zod internals
is contained behind well-defined compatibility helpers. Preserve the current
public behavior unless a behavior change is explicitly documented and tested.

Primary implementation areas:

- `packages/drizzle-validators/src/refine.ts`
- `packages/drizzle-validators/tests/refine-schema.test.ts`
- `packages/drizzle-validators/tests/wrapper-edge-cases.test.ts`
- New focused tests for unsupported schemas, wrapper preservation, and
  compatibility behavior

## Current risks and scaling problems

1. **The Proxy handler is becoming a dispatch hub.** Format helpers such as
   `asEmail`, `asUrl`, `asUuid`, `asCuid2`, and `asUlid` repeat the same
   unwrap/replace/re-wrap flow. Adding another helper requires changes in
   multiple type declarations, `has`, and `get` branches.
2. **Field methods depend on undocumented Zod internals.** `_zod`, `_def`,
   `_zod.constr`, `traits`, and internal check definitions are read and rebuilt
   directly throughout the module. Zod 4 changes can therefore cause silent
   loss of checks, wrapper metadata, defaults, or error behavior.
3. **The implementation uses broad `any` casts and permissive fallbacks.**
   Missing definitions, constructors, checks, or methods can return the
   original schema or an unmodified check, making unsupported shapes look
   successful instead of failing clearly.
4. **Wrapper handling is encoded in parallel runtime and type-level logic.**
   `unwrapAll`/`applyWrappers` and `DeepUnwrap`/`PreserveWrapper` can drift apart,
   especially for nested defaults, exact optional fields, future wrapper types,
   or wrappers carrying metadata beyond `innerType`.
5. **Check transfer is heuristic and incomplete.** A string-based compatibility
   table can miss new Zod checks, incorrectly transfer a check, or silently drop
   one when a schema is replaced with `.as(...)` or `.format(...)`.
6. **The callback result is merged directly into the object shape.** There is no
   explicit validation that callback values are schemas, that a field key is
   intentional, or that a malformed callback result is reported with an
   actionable error.
7. **The work is repeated for each field and each chained operation.** Proxy
   creation, wrapper extraction, and method adaptation can become expensive for
   large generated schemas or long refinement chains.

## Proposed design

### 1. Define an internal transformation model

Introduce small internal types and helpers for:

- a schema definition accessor (`getSchemaDef`)
- a schema constructor accessor (`getSchemaConstructor`)
- wrapper descriptors
- check descriptors
- field operation results

Keep all direct Zod-internal access in these helpers. Each helper should either
return a validated result or throw an error that identifies the unsupported
schema kind and the operation being attempted. Do not silently return the
original schema when a requested transformation could not be applied.

### 2. Replace repeated Proxy branches with an operation registry

Create a registry of field operations with a shared implementation shape:

- operation name
- runtime handler
- type-level declaration
- whether it replaces the core schema or applies a method to it

Use one `replaceCore(formatName, params)` path for `format` and all named
format aliases. Keep aliases as compatibility conveniences, but make them
thin delegates to the registry. This should make adding a format a single
registration change rather than edits in several Proxy branches.

The generic Proxy fallback should remain limited to supported Zod schema
methods. It should preserve method chaining while avoiding accidental exposure
of internal properties or non-schema functions.

### 3. Make wrapper preservation explicit and safe

Centralize wrapper extraction and reconstruction in a wrapper adapter layer.

- Preserve ordering for arbitrarily nested optional, nullable, default, and
  exact-optional wrappers.
- Preserve lazy defaults without evaluating them during refinement.
- Detect wrappers by stable runtime evidence available in the supported Zod
  version, with a clear compatibility error for unknown wrapper definitions.
- Ensure replacement operations preserve wrapper semantics while `setError`
  preserves the complete field structure.
- Keep the runtime wrapper model and TypeScript conditional types aligned with
  shared documentation/tests for every supported wrapper combination.

If a wrapper cannot be reconstructed without losing semantics, fail loudly
instead of returning a partially transformed schema.

### 4. Isolate check cloning and transfer policy

Split check behavior into focused helpers:

- clone checks while replacing error messages
- classify checks by source/target core compatibility
- decide whether a format check conflicts with a replacement format
- transfer checks while preserving order and avoiding duplicates

Use a typed policy table or explicit strategy functions rather than spreading
check-name assumptions across the Proxy implementation. Add a compatibility
policy for unknown checks: either preserve them through a verified constructor
path or report that the requested replacement is unsupported. The policy must
not silently create a schema with fewer validations.

### 5. Validate callback output and preserve object behavior

Before merging the refinement callback result:

- verify every non-`undefined` value is a Zod schema
- provide an operation-specific error for invalid callback values
- preserve existing keys not returned by the callback
- retain support for adding new fields
- define and test the behavior for callback keys whose value is `undefined`

Use the repository’s existing Zod object-shape conventions and preserve the
base object schema behavior where possible. If object-level refinements,
unknown-key policy, catchall behavior, or metadata are not preserved by the
current reconstruction, explicitly inspect and preserve them or document the
intentional limitation before implementation.

### 6. Improve type safety and public API clarity

Reduce `any` to narrow compatibility casts at the Zod boundary. In
particular:

- type format parameters according to the supported Zod format builders
- type internal wrapper/check descriptors
- type the operation registry and Proxy result paths
- keep `RefinedField`, `RefinableShape`, and result inference behavior
  compatible with existing consumers

Document which operations return a replacement core versus applying a method,
which operations preserve existing checks, and which schema kinds are supported.

### 7. Add diagnostics and compatibility tests

Add regression coverage before or alongside each refactor stage:

- all existing `refineSchema` and wrapper-edge tests remain green
- nested and repeated wrappers, including lazy defaults, preserve behavior
- `setError` does not mutate the base schema or sibling refinements
- chained operations do not duplicate checks
- replacement from number to string does not transfer incompatible checks
- compatible length, regex, prefix, suffix, and transform checks remain
- conflicting format checks are excluded intentionally
- all registered format aliases behave identically to `format`
- malformed callback output throws an actionable error
- unsupported or incomplete Zod internals do not silently fall back
- object-level behavior and newly added fields remain intact
- large shapes and repeated operations do not introduce avoidable
  per-operation recomputation

Where practical, assert both runtime parsing and inferred TypeScript types.
Use the installed Zod version as the compatibility baseline and isolate
version-specific probes in one test/helper area.

## Suggested implementation phases

### Phase 0: Characterize current behavior

- Inventory the public `refineSchema` API and supported field methods.
- Add missing tests for current guarantees and identify intentional edge-case
  behavior before changing internals.
- Record the supported Zod version range and the exact internal structures used.

### Phase 1: Extract compatibility and wrapper helpers

- Introduce typed internal accessors for definitions, constructors, checks, and
  wrapper descriptors.
- Move `unwrapAll`, `applyWrappers`, and lazy-default handling behind the
  wrapper adapter.
- Preserve behavior with the existing test suite before changing dispatch.

### Phase 2: Introduce the operation registry

- Consolidate format aliases and replacement operations.
- Keep the existing public names and TypeScript inference.
- Remove duplicated Proxy branches and add registry-driven tests.

### Phase 3: Harden check policy and callback validation

- Extract check cloning/transfer policy.
- Replace silent fallbacks with explicit errors where transformation safety
  cannot be guaranteed.
- Validate callback output and verify object-level schema preservation.

### Phase 4: Optimize and document

- Cache immutable metadata only where profiling or targeted tests show value.
- Avoid caching mutable schema instances or lazy default results.
- Update the package README/API documentation with supported operations,
  limitations, and failure behavior.
- Run focused tests, type-check/build, and the relevant full package suite.

## Acceptance criteria

- No unrelated behavior changes to generated schemas or existing consumers.
- Existing tests pass, including contamination, tree-shaking, async refinement,
  wrapper, and modifier regression suites.
- New tests cover every supported wrapper and operation combination listed
  above.
- Unsupported Zod shapes fail explicitly with actionable diagnostics.
- The Proxy implementation no longer contains one bespoke branch per format
  alias.
- Direct Zod-internal access is localized to compatibility helpers.
- Public TypeScript inference remains correct for replaced, wrapped, optional,
  nullable, defaulted, and newly added fields.
- Documentation accurately describes the supported Zod compatibility boundary.

## Out of scope

- Supporting non-Zod validator targets through `refineSchema`.
- Changing the public name or semantics of `refineSchema`.
- Rewriting generated schema serialization unrelated to field refinement.
- Upgrading Zod solely for this refactor without a separate compatibility
  decision.
