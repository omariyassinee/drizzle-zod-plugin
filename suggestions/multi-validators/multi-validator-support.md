# Multi-Validator Support: TypeBox & Valibot (low-risk scope)

> Status: **implemented** on `feature/multi-validator` (M0 seam, M1 TypeBox, M2 Valibot,
> CLI `--target`, per-target d.ts naming, cache integration, test suites).
> Big-risk / strategic-mismatch items remain explicitly deferred (§6).

## 0. Executive summary

Extend `@vacuus/drizzle-validators` so it can emit schemas for drizzle's other
validation ecosystems — **Valibot** and **TypeBox** — via a new `target` option, with Zod
staying the default. The pipeline is already mostly validator-agnostic; the real work is
one **serializer per target** plus threading `target` through options/CLI/cache and
decoupling the Zod-branded bits (`refineSchema`, `import * as z from 'zod'`,
module-id and d.ts defaults).

Milestones: M0 adapter-seam refactor (no behavior change) → M1 TypeBox → M2 Valibot.
Each ships independently.

## 1. Verified ground truth

- drizzle-orm `1.0.0-rc.4` ships subpath exports `./zod`, `./valibot`, `./typebox`
  (plus `./typebox-legacy`), `./arktype`. **All expose the identical trio**
  `createInsertSchema` / `createSelectSchema` / `createUpdateSchema` (plus
  `createSchemaFactory`, `jsonSchema`, `literalSchema`, and per-target helpers such as
  `bufferSchema`, `bigintStringModeSchema`). Creator loading generalizes to an
  import-specifier change.
- Peer range `drizzle-orm: "^0.30.0 || ^1.0.0-0"` is wider than subpath availability:
  `/valibot` and `/typebox` don't exist in older 0.x lines. Non-Zod targets fail with an
  actionable message when the subpath is missing (no standalone-package fallbacks in
  this scope).
- The pipeline outside the serializer is validator-agnostic already: table
  bundling/discovery (`schema-generator.ts`), file writing (`file-writer.ts`), d.ts
  mechanics (`dts-builder.ts`), cache machinery (`cache.ts`), plugin/CLI plumbing.

## 2. The Zod-coupled points (the actual work)

1. `loadSchemaCreators` — `schema-generator.ts`, hardwired `drizzle-orm/zod` → `drizzle-zod`.
2. `zodTypeToCode` — `zod-serializer.ts` (~934 lines of Zod-4-internals walking:
   `_zod.def` / `_zod.traits`, string/number check handler maps, format builders,
   wrapper unwrap/apply, Buffer policy).
3. Hardcoded `import * as z from 'zod'` and `refineSchema` re-exports in generated
   barrel/submodule/single-file chunks.
4. `dts-builder.ts` — `refineSchema` type-queries against
   `@vacuus/drizzle-validators/refine`.
5. Zod-branded defaults — moduleId `virtual:drizzle-validators`, d.ts name
   `virtual-drizzle-validators.d.ts`, `@types/virtual-drizzle-validators` shim dir.

## 3. Design

### 3.1 Target option

- `types.ts`: `export type ValidatorTarget = "zod" | "valibot" | "typebox"` and
  `target?: ValidatorTarget` on `DrizzleZodVirtualOptions` (default `"zod"`).
  ArkType is intentionally **not** in the union (§6).
- `plugin.ts`: passes `options.target` into `generateSchemas`.
- `cli.ts`: `--target <name>` flag with validation mirroring `--buffer-as` + help text.

### 3.2 SerializerAdapter seam (M0)

```ts
// src/adapters/types.ts
export type ValidatorTarget = "zod" | "valibot" | "typebox";

export interface EmitContext {
  bufferAs: "throw" | "keep";
  depth: number; // recursion guard (MAX_RECURSION_DEPTH)
}

export interface SerializerAdapter {
  target: ValidatorTarget;
  /** import line emitted at the top of generated modules */
  importStatement: string; // `import * as z from "zod"` / `import * as v from "valibot"`
  defaultModuleId: string; // "virtual:drizzle-validators" / "virtual:drizzle-validators" / ...
  loadCreators(): Promise<{
    createInsertSchema: any;
    createSelectSchema: any;
    createUpdateSchema: any;
  }>;
  emit(schema: unknown, ctx: EmitContext): string; // per-target zodTypeToCode
}
```

- `src/adapters/zod.ts` wraps the existing `zod-serializer.ts` **unchanged**.
- Registry `src/adapters/index.ts` resolves target → adapter with **lazy dynamic
  imports** following the `esbuild-loader.ts` pattern (P2-11): a missing optional peer
  throws an actionable "install <lib>" message, never a raw module-not-found stack.
- `generateSchemas` replaces `loadSchemaCreators` with `adapter.loadCreators()` and all
  hardcoded chunk lines with adapter values.

### 3.3 Guarded, minimal creator resolution

Each adapter tries only `drizzle-orm/<target>`. If absent (old drizzle-orm), throw the
existing actionable-error pattern — no standalone-package fallbacks in this scope.
`package.json`: `valibot` + `@sinclair/typebox` added as **optional** peers
(`peerDependenciesMeta.*.optional: true`).

### 3.4 Generated-code shape

- Import line from `adapter.importStatement`; keep `/* @__PURE__ */` annotations
  (tree-shaking contract).
- `refineSchema` re-export emitted **only for `target: "zod"`**; non-zod
  barrels/submodules omit it, and the `dts-builder.ts` refine lines are conditional.
  README documents `refineSchema` as Zod-only.
- `GENERATED_HEADER` (`file-writer.ts`) stays byte-identical across targets — the
  stale-file reconciliation pass matches on it; a per-target header would orphan files
  when switching targets.
- Internal rename `TableCodeData.zodCodes` → `codes`; bump `CACHE_VERSION`.

### 3.5 Cache

- `computeCacheKey` adds `target` to the hashed fields.
- `dependencyFingerprint` parameterized per adapter: `drizzle-orm` + the target library
  (`valibot` / `@sinclair/typebox`; zod keeps `drizzle-zod` + `zod`).
- `CACHE_VERSION` bump at M0 and per milestone that changes output.

### 3.6 Naming (additive only, no back-compat change)

- Zod defaults unchanged: `virtual:drizzle-validators`, `virtual-drizzle-validators.d.ts`.
- Non-zod defaults: `virtual:drizzle-<target>` moduleId and
  `virtual-drizzle-<target>.d.ts` + matching `@types/virtual-drizzle-<target>` shim dir.
  Parameterize the hardcoded sites in `paths.ts` and `file-writer.ts`.

## 4. Per-target serializers

### 4.1 TypeBox (M1 — implemented)

**Spike findings (verified against drizzle-orm@1.0.0-rc.4 + typebox@1.1.0):**
- The CURRENT `drizzle-orm/typebox` entry imports the bare **`typebox`** package
  (TypeBox v1) — NOT `@sinclair/typebox` (that is the `typebox-legacy` entry).
- It does **not** hand back TSchema instances: the output is **plain JSON Schema**
  (no `[Kind]` symbols anywhere — even buffer-mode blob columns surface as `{}`/Any).
- drizzle-orm's typebox entry is compiled against early typebox 1.x (it extends
  `Type.Base`, which was removed in later 1.x) — a drizzle↔typebox version
  constraint, not ours; the emitted code only uses core builders, stable across
  0.34+ and 1.x.

Emission (`src/adapters/typebox.ts`) maps JSON Schema → `t.*` builder calls
(`import * as t from 'typebox'`):
- `{}` → `t.Any()`; `{type:"null"}` → `t.Null()`; `anyOf` → `t.Union([...])`;
  `enum` → union of `t.Literal(...)` (single → bare literal).
- `type:"object"` with `properties`/`required` → `t.Object({...})` with
  `t.Optional(...)` for non-required members; `patternProperties` (match-all,
  drizzle's JSON-value encoding) → `t.Record(t.String(), value)`; single-key
  non-match-all patterns keep `t.String({ pattern })` as the key schema.
- Primitives → `t.String`/`t.Integer`/`t.Number`/`t.Boolean`/`t.BigInt` with
  `minLength/maxLength/pattern/format` and
  `minimum/maximum/exclusive*/multipleOf`; bigint bounds serialize as `n` literals.
- Metadata keys (`title`, `description`, `default`, …) are dropped; unrecognized
  constraint keys and symbol-bearing (custom-factory TSchema) nodes fail loud
  with an actionable message.
- `bufferAs` P2-02 parity: a `TBuffer` instance (custom factories only) throws
  under the default `"throw"` policy and emits `t.Unknown()` under `"keep"`.

### 4.2 Valibot (M2 — implemented)

**Spike findings (verified against drizzle-orm@1.0.0-rc.4 + valibot@1.5.0):**
- `drizzle-orm/valibot` hands back REAL valibot schema instances: `type`
  discriminator, `wrapped` for wrappers, `pipe = [baseSchema, ...actions]`
  (base entries have `kind: "schema"`, actions `kind: "validation"/"transformation"`),
  `entries` for objects, `item` for arrays, `enum`/`options` for enums,
  `key`/`value` for records.
- drizzle attaches **no default values** (`default` always undefined) — no
  P2-04-style getter problem exists for this target.
- Buffer columns surface as `unknown` — `v.instance(Buffer)` only possible via
  custom schema factories.

Emission (`src/adapters/valibot.ts`) rebuilds `v.*` code
(`import * as v from 'valibot'`):
- Wrappers → `v.optional/v.nullable/v.nullish/v.exactOptional/v.readonly(inner)`.
- Constraints → `v.pipe(base, v.<action>()...)` with the action chain preserved
  (`minValue/maxValue/minLength/maxLength/length/integer/uuid/email/url/ipv4/
  ipv6/regex/value`); metadata actions skipped; unknown actions fail loud.
- Containers → `v.object({...})` (2-space indent, quoted keys),
  `v.array(item)`, `v.record(key, value)`, `v.union([...])`, `v.enum({...})`,
  `v.picklist([...])`, `v.literal(...)`.
- `bufferAs` P2-02 parity: `instance` schemas throw by default; `"keep"` emits
  `v.instance(<Ctor>)`.

## 5. Testing & milestones

Per target (pg matrix mirroring existing suites):

1. **Golden snapshots** (pattern of `tests/complex-schemas.test.ts`).
2. **Behavioral parity**: eval emitted code (data-URI helper in
   `tests/bug-repro/phase-2/_helpers.ts`) → parse valid/invalid fixtures with the
   target library (`Value.Check` for TypeBox, `safeParse` for Valibot).
3. **Adapter edges**: unknown format, recursion depth, `bufferAs` throw/keep,
   table-name identifier validation, refine-line omission.
4. **Cache**: target present in key; no cross-target entries.
5. **CLI**: `--target` flag, validation errors, help text.
6. **d.ts**: per-target filename, no `refineSchema` line for non-zod.
7. **Virtual-module serving** per target (plugin load paths).

- **M0 — Adapter seam, zod-only.** Accept: existing test suite green with zero output diffs.
- **M1 — TypeBox.** Accept: golden + behavioral tests pass; `--target typebox` works on
  the demo schema.
- **M2 — Valibot.** Same acceptance shape.

## 6. Explicitly deferred — NOT implemented

| Item | Why dropped |
|---|---|
| ArkType target (any form — full serializer *and* passthrough mode) | Full serializer = high-risk RE of opaque internals; passthrough emits drizzle imports into bundles, breaking the package's core zero-drizzle guarantee. Revisit only after M1/M2. |
| `refineSchema` analogs for Valibot/TypeBox | Large scope, uncertain API design; `refineSchema` stays Zod-only and is omitted from non-zod barrels. |
| Standalone-package fallbacks (`drizzle-valibot`, `drizzle-typebox`) | Extra resolution surface; require `drizzle-orm/<target>` and fail actionable otherwise. |
| Making `zod` an optional peer | Entangled with the `./refine` entry; major-version decision. |
| Branding/rename (package name, dropping zod from defaults) | Strategic; revisit at a major version. |
| mysql/sqlite column matrices for new targets | pg-first keeps risk down; zod coverage unchanged. |
