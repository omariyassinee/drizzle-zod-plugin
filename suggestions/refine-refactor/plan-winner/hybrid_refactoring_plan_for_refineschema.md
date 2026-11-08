# Hybrid Refactoring Plan: High-Reliability, Type-Sound `refineSchema` Engine

> **Target Package:** `@vacuus/drizzle-validators`  
> **Primary Target File:** `packages/drizzle-validators/src/refine.ts`  
> **Cross-Referenced Modules:** `src/constants.ts`, `src/zod-serializer.ts`, `src/dts-builder.ts`  
> **Baseline:** `zod@^4.4.3` (peer `^4.0.0`)  

---

## 0. Executive Summary & Why a Hybrid Strategy Wins

Each of the four previously reviewed proposals solved a distinct piece of the puzzle while leaving blind spots elsewhere:
- **`kilo`** nailed the **Zod 4 internals isolation boundary** (`zod-compat.ts`), check-instance cloning, and fail-loud semantics, but missed the required-field chaining collapse and check-collision bugs.
- **`antigravity`** uncovered the **three critical runtime/type bugs** (premature `target` unbinding on required fields, constraint duplication in `transferChecks`, and type-vs-runtime wrapper divergence) and introduced the **$O(1)$ lazy shape proxy**, but relied on hallucinated Zod 4 internals (`def.unknownKeys` instead of `def.catchall`) and bloated the scope with a mutable static class.
- **`zcode`** contributed **explicit check-transfer policies** (`keep: "compatible" | "all" | "none"`) and **granular per-check error relabeling**, but proposed throwing away the fluent API in favor of a breaking descriptor syntax that could not statically infer preserved wrappers without `PreserveWrapper`.

### The Hybrid Architecture
This plan unites the best elements of all three into a single, cohesive, non-breaking architecture:
1. **100% Fluent API Continuity:** Preserves the ergonomic `refineSchema(base, (f) => ({ ... }))` callback API with zero breaking changes for existing callers.
2. **Universal Proxy Interception + Final Unwrapping:** Fixes required-field chaining and wrapper-method chaining (`f.age.positive().setError(...)`, `f.bio.nullable().min(2)`), and strips `Proxy` wrappers via an internal symbol before building the final `ZodObject` so zero proxy overhead leaks into runtime parsing or serialization.
3. **Deduplicating, Policy-Driven Check Transfer:** Clones transferred checks, prevents duplicate format/bound validations (target check wins on collision), and adds explicit transfer controls (`{ keepChecks?: "compatible" | "all" | "none" }`) plus targeted error overrides (`setError(msg | CheckErrorMap)`).
4. **Branded Type-System Soundness:** Introduces a phantom brand (`[REFINED_BRAND]`) on `RefinedField<T, TWrappers>` so TypeScript accurately distinguishes between a proxied field chain (which preserves/updates wrappers) and a raw schema override (`bio: z.string()`, which replaces the field wholesale without lying in `z.infer`).
5. **Isolated Zod 4 Compatibility Layer (`src/zod-compat.ts`):** Centralizes every `_zod.def`, `_zod.constr`, `_zod.traits`, `defaultValue` getter, and `def.catchall` inspection in one version-guarded module aligned with `src/zod-serializer.ts`.
6. **$O(1)$ Lazy Shape Proxy:** Wraps `baseSchema.shape` on demand so refining $K$ fields on an $N$-column table costs $O(K)$ instead of $O(N)$.

---

## 1. Verified Root-Cause Audit (Grounded in `src/`)

Every defect below is verified directly against `packages/drizzle-validators/src/refine.ts` and `packages/drizzle-validators/src/zod-serializer.ts`.

### Defect B1 — Premature Target Unbinding (Chaining Collapse on Required & Wrapper Methods)
- **Location:** `src/refine.ts:537–551`
  ```ts
  if (prop in target) {
      const val = Reflect.get(target, prop, receiver);
      if (typeof val === "function") return val.bind(target);
  }
  if (typeof prop === "string" && typeof (core as any)[prop] === "function") {
      return (...args: any[]) => {
          const coreResult = (core as any)[prop](...args);
          const wrappedResult = applyWrappers(coreResult, wrappers);
          return wrapFieldProxy(wrappedResult);
      };
  }
  ```
- **Mechanism:**
  1. **Required (Unwrapped) Fields:** When a column is `notNull()` without a default, `unwrapAll(field)` returns `wrappers = []` and `core === target`. When the user calls `fields.age.min(18)`, `'min' in target` evaluates to `true` at line 537! The proxy executes `val.bind(target)`, returning a **raw, unproxied `ZodNumber`**. Chaining `.setError("...")` or `.as(...)` immediately throws `TypeError: fields.age.min(...).setError is not a function`.
  2. **Wrapper-Level Methods on Wrapped Fields:** When a column is `ZodOptional<ZodString>`, calling `fields.bio.nullable()` or `fields.bio.default("N/A")` hits `'nullable' in target` at line 537 and again returns an **unproxied** Zod schema, breaking any subsequent `.min(5)` or `.asEmail()` call in the chain.

### Defect B2 — Constraint Duplication, Bound Resurrection & Shared Check References
- **Location:** `src/refine.ts:321–358` (`transferChecks`)
- **Mechanisms:**
  1. **Duplicate Format Validation:**
     ```ts
     if (checkDef.check === "string_format") {
         const fmt = checkDef.format;
         const isConstraint = CONSTRAINT_STRING_FORMATS.has(fmt);
         if (!isConstraint && targetFormat && fmt !== targetFormat) {
             continue;
         }
     }
     ```
     When a column is already `z.email()` (or `z.string().email()`) and the user calls `fields.email.asEmail({ error: "Invalid work email" })`, both `fmt` and `targetFormat` are `"email"`. Because `fmt !== targetFormat` is `false`, `transferChecks` copies the *old* email check onto the *new* `z.email()` schema. Invalid inputs trigger **two** email errors: `["Invalid work email", "Invalid email address"]`.
  2. **Bound Resurrection (Blocked Constraint Loosening):** If a Drizzle column is `varchar(100)` (`max_length: 100`) and the user calls `fields.bio.as(z.string().max(500))`, `transferChecks` appends the old `max_length: 100` check onto the new schema. Any string between 101 and 500 characters fails validation because the old bound was resurrected alongside the new bound.
  3. **Shared Check Instances & Unclassified Checks:** `result = result.check(check)` grafts the exact same check object reference onto the new schema and transfers unknown check kinds unconditionally (`if (compat && ...)` passes whenever `CHECK_CORE_COMPAT[checkDef.check]` is `undefined`).

### Defect B3 — Loss of Object-Level `catchall` / Strictness & Proxy Leakage into `ZodObject.shape`
- **Location:** `src/refine.ts:600–603` (`return object({ ...baseSchema.shape, ...modifiedFields })`)
- **Mechanisms:**
  1. **Erased `catchall` / Strictness / Description:** As verified in `src/zod-serializer.ts:595–605`, Zod 4 encodes `z.strictObject()` via `def.catchall` with `catchallDef.type === "never"`, `z.looseObject()` via `catchallDef.type === "unknown"`, and custom catchalls via `def.catchall`. Rebuilding with bare `object({...})` silently resets strict, loose, and catchall objects back to strip mode, and drops object-level `description` and `checks`.
  2. **Permanent Proxy Leakage:** Every modified field returned from `wrapFieldProxy` is a `Proxy`. Spreading `modifiedFields` directly into `object({...})` embeds those `Proxy` instances inside the final `ZodObject.shape`. Downstream calls to `zodTypeToCode(refinedSchema)`, `.shape.email`, or internal Zod parsing continuously traverse the proxy traps unnecessarily.

### Defect B4 — Type-vs-Runtime Wrapper Divergence & Missing Wrapper Controls
- **Location:** `src/refine.ts:583–593`
  ```ts
  [K in keyof R]: K extends keyof T["shape"]
      ? R[K] extends z.ZodTypeAny
          ? PreserveWrapper<T["shape"][K], DeepUnwrap<R[K]>>
          : T["shape"][K]
  ```
- **Mechanisms:**
  1. **Raw Override Desynchronization:** If `baseSchema.shape.bio` is `ZodOptional<ZodString>` and a user overrides it with a raw schema:
     ```ts
     const refined = refineSchema(base, () => ({ bio: z.string().min(1) }));
     ```
     At **runtime**, `refined.shape.bio` is `z.string().min(1)` (strictly required). At **compile time**, `PreserveWrapper<T["shape"]["bio"], DeepUnwrap<ZodString>>` evaluates to `ZodOptional<ZodString>`! `z.infer<typeof refined>` claims `bio?: string | undefined`, allowing `{}` at compile time while failing at runtime.
  2. **No Explicit `.required()` / `.unwrap()` API:** Users have no fluent method on `fields.bio` to intentionally strip `optional` or `nullable` wrappers (e.g., making an optional database column required on a specific form) while keeping both runtime and static types synchronized.
  3. **Stale Format Return Types:** `.asEmail()`, `.asUuid()`, `.asUrl()`, `.asCuid2()`, and `.asUlid()` return `RefinedField<T>` instead of updating the inner core type to the corresponding Zod 4 format schema (`z.ZodEmail`, `z.ZodUUID`, etc.).

### Defect B5 — Hardcoded Dispatch Hub & 4-Way Format Duplication
- **Location:** `src/refine.ts:226–253, 360–401, 451–535`
- **Mechanism:** Adding or maintaining format helpers requires updating `STRING_FORMAT_NAMES` (`src/constants.ts`), `FORMAT_BUILDERS`, `RefinedField` interface methods, the `has` trap allowlist, and individual `if (prop === "as...")` blocks in the `get` trap. Furthermore, `unwrapAll` only handles 4 wrappers (`optional`, `nullable`, `exactOptional`, `default`) and silently treats `readonly`, `catch`, or `brand` as the innermost core schema.

### Defect B6 — Incomplete `setErrorOnField` Traversal & Coarse Error Granularity
- **Location:** `src/refine.ts:162–224`
- **Mechanisms:**
  1. `setErrorOnField` only recurses on `fieldDef.innerType`, ignoring `element` (arrays) and failing silently if a check lacks `_zod.constr`.
  2. Calling `.setError("msg")` overwrites the error function on **every** check on the field (`min_length`, `max_length`, `regex`, `string_format`) simultaneously. Users cannot target just one check kind (e.g. overriding the format error while keeping the max-length error intact) when chaining on pre-existing Drizzle column checks.

### Defect B7 — $O(N)$ Eager Shape Unwrapping & Unvalidated Callback Output
- **Location:** `src/refine.ts:594–603`
- **Mechanisms:**
  1. `for (const [key, field] of Object.entries(baseSchema.shape))` runs `unwrapAll` and allocates a `Proxy` for all $N$ columns in the table before calling `refinementFn`, even if only $K = 1$ field is accessed.
  2. If `refinementFn` returns `null`, a primitive, or an object with non-Zod values (or `undefined` properties), `refineSchema` spreads them blindly into `object({...})` without an actionable error message.

---

## 2. Target Architecture

We will organize the refinement internals cleanly into five logical layers (either within `src/refine/` submodules re-exported by `src/refine.ts`, or cleanly sectioned inside `src/refine.ts` + `src/zod-compat.ts` so bundle entrypoints remain unchanged):

```
packages/drizzle-validators/src/
├── zod-compat.ts          # Layer 1: Single Zod 4 internals boundary (_zod, def, constr, traits, catchall, checks)
└── refine.ts              # Layers 2–5:
                           #   - Layer 2: Wrapper Stack & Check Transfer/Deduplication Engine
                           #   - Layer 3: Declarative Format & Operation Registry
                           #   - Layer 4: Universal Field Proxy (with UNWRAP_PROXY) & O(1) Lazy Shape Proxy
                           #   - Layer 5: Branded Type System (RefinedField<TCore, TWrapped>)
```

---

## 3. Detailed Technical Specifications

### 3.1 Layer 1: Zod 4 Compatibility Boundary (`src/zod-compat.ts`)

All direct reads and reconstructions of `_zod`, `_def`, `_zod.constr`, `_zod.traits`, `defaultValue` getters, check cloning, and object `catchall` policies are isolated in `src/zod-compat.ts`. Neither `refine.ts` nor `zod-serializer.ts` needs duplicate ad-hoc probing.

```ts
// packages/drizzle-validators/src/zod-compat.ts
import { looseObject, object, strictObject, type z } from "zod";

export interface InternalZodDef {
	type: string;
	checks?: any[];
	innerType?: z.ZodTypeAny;
	element?: z.ZodTypeAny;
	catchall?: z.ZodTypeAny;
	shape?: Record<string, z.ZodTypeAny>;
	format?: string;
	error?: () => string;
	[key: string]: unknown;
}

/** Validates that a value is a Zod 4 schema instance. */
export function isZodSchema(value: unknown): value is z.ZodTypeAny {
	if (typeof value !== "object" || value === null) return false;
	const v = value as any;
	return typeof (v._zod?.def?.type ?? v._def?.type ?? v.def?.type) === "string";
}

/** Reads the internal definition object from a Zod 4 schema or check. */
export function getZodDef(schemaOrCheck: unknown): InternalZodDef | undefined {
	if (typeof schemaOrCheck !== "object" || schemaOrCheck === null) {
		return undefined;
	}
	const s = schemaOrCheck as any;
	return s._zod?.def ?? s._def ?? s.def;
}

/** Reads the internal $constructor of a Zod 4 schema or check, throwing if missing when required. */
export function getZodConstructor(
	instance: unknown,
	context: string,
): new (def: any) => any {
	const constr = (instance as any)?._zod?.constr;
	if (typeof constr !== "function") {
		const def = getZodDef(instance);
		throw new Error(
			`[drizzle-validators] Cannot reconstruct Zod ${def?.type ?? "unknown"} during ${context}: ` +
				`missing internal _zod.constr constructor (unsupported Zod version or custom object).`,
		);
	}
	return constr;
}

/** Detects ZodExactOptional via _zod.traits (Zod 4 sets def.type = "optional" on both). */
export function isExactOptionalSchema(schema: unknown): boolean {
	const traits = (schema as any)?._zod?.traits;
	return traits instanceof Set && traits.has("ZodExactOptional");
}

/** Detects whether a default wrapper stores its defaultValue as a lazy getter (finding P2-04). */
export function hasLazyDefaultGetter(def: InternalZodDef): boolean {
	return (
		Object.getOwnPropertyDescriptor(def, "defaultValue")?.get !== undefined
	);
}

/**
 * Clones a single Zod 4 check instance, optionally overriding its error message.
 * Never shares the check reference or mutates the source check in place.
 */
export function cloneZodCheck(check: any, errorOverride?: string): any {
	const checkDef = getZodDef(check);
	if (!checkDef) {
		throw new Error(
			`[drizzle-validators] Encountered a malformed Zod check without a definition object.`,
		);
	}
	const constr = getZodConstructor(check, "check cloning");
	const nextDef =
		errorOverride !== undefined
			? { ...checkDef, error: () => errorOverride }
			: { ...checkDef };
	return new constr(nextDef);
}

/**
 * Clones a Zod 4 schema with an updated def while preserving lazy defaultValue getters (P2-04)
 * and schema-level description/metadata.
 */
export function cloneSchemaWithDef<T extends z.ZodTypeAny>(
	schema: T,
	overrides: Partial<InternalZodDef>,
	context: string,
): T {
	const fieldDef = getZodDef(schema);
	if (!fieldDef) {
		throw new Error(
			`[drizzle-validators] Cannot clone schema during ${context}: missing definition.`,
		);
	}
	const constr = getZodConstructor(schema, context);
	const defaultAccessor = Object.getOwnPropertyDescriptor(
		fieldDef,
		"defaultValue",
	);
	const spreadDef: Record<string, unknown> = { ...fieldDef };
	if (defaultAccessor?.get !== undefined) {
		Reflect.deleteProperty(spreadDef, "defaultValue");
	}

	const newDef: Record<string, unknown> = {
		...spreadDef,
		...overrides,
	};

	if (defaultAccessor?.get !== undefined && !("defaultValue" in overrides)) {
		Object.defineProperty(newDef, "defaultValue", {
			get() {
				return (fieldDef as any).defaultValue;
			},
			configurable: true,
		});
	}

	return new constr(newDef) as T;
}

/**
 * Reconstructs a ZodObject with a new shape while preserving Zod 4's catchall/strict/loose
 * configuration, object-level checks (.refine), and description.
 * Aligns with src/zod-serializer.ts:595-605.
 */
export function rebuildZodObject(
	baseSchema: z.ZodObject<any>,
	newShape: Record<string, z.ZodTypeAny>,
): z.ZodObject<any> {
	const baseDef = getZodDef(baseSchema);
	const catchallDef = baseDef?.catchall
		? getZodDef(baseDef.catchall)
		: undefined;

	let rebuilt: z.ZodObject<any>;
	if (catchallDef?.type === "never") {
		rebuilt = strictObject(newShape);
	} else if (catchallDef?.type === "unknown") {
		rebuilt = looseObject(newShape);
	} else if (baseDef?.catchall) {
		rebuilt = object(newShape).catchall(baseDef.catchall);
	} else {
		rebuilt = object(newShape);
	}

	// Preserve object-level checks (e.g. .refine() / .superRefine() on the base object)
	if (Array.isArray(baseDef?.checks) && baseDef.checks.length > 0) {
		for (const chk of baseDef.checks) {
			if (typeof (rebuilt as any).check === "function") {
				rebuilt = (rebuilt as any).check(cloneZodCheck(chk));
			}
		}
	}

	// Preserve .describe() metadata if present
	if (typeof (baseSchema as any).description === "string") {
		rebuilt = rebuilt.describe((baseSchema as any).description);
	}

	return rebuilt;
}
```

---

### 3.2 Layer 2: Wrapper Stack & Policy-Driven Check Engine

#### 3.2.1 Extended Wrapper Stack (`WrapperDef`)
We expand `unwrapAll` and `applyWrappers` from 4 wrappers to cover **all 6 non-transforming Zod 4 wrapper layers**:
1. `optional`
2. `exactOptional` (detected via `isExactOptionalSchema`)
3. `nullable`
4. `default` (preserving lazy `defaultValue` getters via `hasLazyDefaultGetter`)
5. `readonly` (`def.type === "readonly"`, re-applied via `.readonly()`)
6. `catch` (`def.type === "catch"`, preserving `def.catchValue` getter/value via constructor just like `default`)

Furthermore, `unwrapAll` exposes stack-manipulation helpers for the fluent proxy:
- `removeOptionalWrappers(wrappers)` $\rightarrow$ strips `optional` and `exactOptional` entries.
- `removeNullableWrappers(wrappers)` $\rightarrow$ strips `nullable` entries.
- `clearAllWrappers()` $\rightarrow$ returns `[]` for `.unwrap()`.

#### 3.2.2 Check Deduplication & Transfer Policy (`transferChecks`)
When replacing a core schema via `.format()`, `.asEmail()`, or `.as()`, `transferChecks` now accepts an explicit policy:
```ts
export type KeepChecksPolicy = "compatible" | "all" | "none";

export interface ReplaceCoreOptions {
	/**
	 * Controls how existing checks on the base column are transferred to the replacement schema:
	 * - "compatible" (default): transfers core-compatible checks that do not conflict with checks already defined on the target schema.
	 * - "none": discards all pre-existing column checks (clean replacement while preserving outer wrappers).
	 * - "all": forces transfer of all checks onto the target schema.
	 */
	keepChecks?: KeepChecksPolicy;
	/** Alias for `keepChecks: false ? "none" : "compatible"` for convenience. */
	transferChecks?: boolean;
}
```

**Deduplication & Collision Rules under `"compatible"` (Fixing Defect B2):**
1. **Format Collision Guard:** When `checkDef.check === "string_format"` and `!CONSTRAINT_STRING_FORMATS.has(checkDef.format)`:
   - If the `target` schema *already* has a format on its top-level `targetDef.format` (e.g., `z.email()`, `z.uuid()`) OR already contains a non-constraint `string_format` check in `targetDef.checks`, **skip** the source format check unconditionally (even if `fmt === targetFormat`!). This eliminates duplicate `["New email error", "Old email error"]` issues.
2. **Bound Override Precedence (Target Wins):**
   - Inspect `targetDef.checks` first and collect a set of existing bound keys:
     - `min_length`
     - `max_length`
     - `length_equals`
     - `greater_than`
     - `less_than`
     - `multiple_of`
     - `number_format`
   - If the target schema *already* defines a check of that exact bound kind (for instance, the user wrote `.as(z.string().min(2))` on a column that originally had `.min(5)`, or `.as(z.string().max(500))` on a `varchar(100)` column), the **target check takes precedence** and the source check of the same kind is skipped.
3. **Unknown Check Fail-Loud Guard:**
   - Instead of defaulting to `true` when `CHECK_CORE_COMPAT[checkDef.check]` is `undefined`, explicitly handle `"custom"` (runtime `.refine()` check, which is type-agnostic when source and target share the same `coreType`) and throw an actionable error if an unrecognized internal Zod check type is encountered.
4. **Always Clone Transferred Checks:**
   - Every transferred check is cloned via `cloneZodCheck(check)` so source and target schemas never share mutable check references.

#### 3.2.3 Granular Error Overrides (`setErrorOnField`)
We enhance `setError` / `withError` to accept either a flat `string` (100% backward-compatible) or a targeted `CheckErrorMap`:
```ts
export type CheckErrorKey =
	| "min"          // matches min_length or greater_than
	| "max"          // matches max_length or less_than
	| "length"       // matches length_equals
	| "format"       // matches string_format (email, uuid, url, etc.) or top-level format def
	| "regex"        // matches string_format with format === "regex"
	| "startsWith"   // matches string_format with format === "starts_with"
	| "endsWith"     // matches string_format with format === "ends_with"
	| "includes"     // matches string_format with format === "includes"
	| "multipleOf"   // matches multiple_of
	| "int"          // matches number_format (safeint)
	| "custom"       // matches custom refine checks
	| "type";        // overrides only the schema-level base error (invalid_type / required), leaving check errors untouched

export type ErrorOverrideInput = string | Partial<Record<CheckErrorKey, string>>;
```
Additionally, `setErrorOnField` now recurses through `innerType` **and** `element` (for `z.array()`), using `cloneSchemaWithDef` and `cloneZodCheck` from `src/zod-compat.ts`.

---

### 3.3 Layer 3: Declarative Format & Operation Registry

Instead of hardcoding `asEmail`, `asUrl`, `asUuid`, `asCuid2`, and `asUlid` across four places in `src/refine.ts`, we drive all format creation and `as*` aliases from a single registry table derived from `STRING_FORMAT_NAMES` (`src/constants.ts`):

```ts
const FORMAT_ALIAS_MAP = {
	asEmail: "email",
	asUrl: "url",
	asHttpUrl: "httpUrl",
	asUuid: "uuid",
	asUuidv4: "uuidv4",
	asUuidv6: "uuidv6",
	asUuidv7: "uuidv7",
	asGuid: "guid",
	asCuid: "cuid",
	asCuid2: "cuid2",
	asUlid: "ulid",
	asNanoid: "nanoid",
	asJwt: "jwt",
	asIpv4: "ipv4",
	asIpv6: "ipv6",
	asCidrv4: "cidrv4",
	asCidrv6: "cidrv6",
	asBase64: "base64",
	asBase64url: "base64url",
	asE164: "e164",
	asEmoji: "emoji",
	asKsuid: "ksuid",
	asXid: "xid",
} as const satisfies Record<string, StringFormat>;
```

Every alias in `FORMAT_ALIAS_MAP` routes to a single 4-line helper:
```ts
function applyFormatReplacement(
	core: z.ZodTypeAny,
	wrappers: WrapperDef[],
	formatName: StringFormat,
	params?: FormatParams,
	options?: ReplaceCoreOptions,
): z.ZodTypeAny {
	const rawCore = createFormatSchema(formatName, params);
	const newCore = transferChecks(core, rawCore, options);
	const wrapped = applyWrappers(newCore, wrappers);
	return wrapFieldProxy(wrapped);
}
```
And the `has` trap checks `prop in FORMAT_ALIAS_MAP || CUSTOM_PROXY_METHODS.has(prop)`, eliminating all duplicated branches.

---

### 3.4 Layer 4: Universal Field Proxy, `UNWRAP_PROXY`, and $O(1)$ Lazy Shape Proxy

#### 3.4.1 Fixing Defect B1 & B3 in `wrapFieldProxy`
1. **Internal Unwrap Symbol (`UNWRAP_PROXY`):**
   ```ts
   export const UNWRAP_PROXY = Symbol.for("drizzle-validators.unwrapProxy");
   export const REFINED_FIELD_BRAND = Symbol.for("drizzle-validators.refinedField");
   ```
   When `prop === UNWRAP_PROXY`, the proxy returns the underlying unproxied `target` (`z.ZodTypeAny`). When `refineSchema` collects the return value of `refinementFn`, it unwraps every proxied field via `(val as any)[UNWRAP_PROXY] ?? val` before passing the shape to `rebuildZodObject`. Zero `Proxy` objects ever enter the final `ZodObject.shape`.
2. **Wrapper Control Methods (`.unwrap()`, `.required()`, `.nonnullable()`):**
   - `field.unwrap()`: returns `wrapFieldProxy(core)` (all wrappers removed).
   - `field.required()`: removes `optional` and `exactOptional` from `wrappers`, rebuilds `applyWrappers(core, remainingWrappers)`, and returns `wrapFieldProxy(...)`.
   - `field.nonnullable()`: removes `nullable` from `wrappers`, rebuilds `applyWrappers(core, remainingWrappers)`, and returns `wrapFieldProxy(...)`.
3. **Correct Method Resolution Order (Fixing Defect B1):**
   Instead of checking `if (prop in target)` *before* `core` delegation:
   - **Step 1:** Handle `[UNWRAP_PROXY]` and `[REFINED_FIELD_BRAND]`.
   - **Step 2:** Handle custom refinement methods (`setError`, `withError`, `format`, `as`, `unwrap`, `required`, `nonnullable`) and `FORMAT_ALIAS_MAP` (`asEmail`, `asUuid`, ...).
   - **Step 3:** Handle explicit wrapper-adding methods called by the user (`.optional()`, `.exactOptional()`, `.nullable()`, `.nullish()`, `.default()`, `.readonly()`, `.catch()`): execute them on `target` and **re-wrap the returned schema in `wrapFieldProxy(...)`** so chaining continues seamlessly!
   - **Step 4:** If `typeof prop === "string" && typeof (core as any)[prop] === "function"` **and** `prop` is not a core parsing/execution method (`parse`, `safeParse`, `parseAsync`, `safeParseAsync`, `spa`, `isOptional`, `isNullable`, `~standard`):
     - Invoke `const result = (core as any)[prop](...args)`.
     - Check `if (isZodSchema(result))`: if it returned a new core schema (e.g., `.min()`, `.max()`, `.positive()`, `.trim()`, `.regex()`, `.refine()`), re-apply `applyWrappers(result, wrappers)` and return `wrapFieldProxy(wrappedResult)`!
     - If `result` is not a Zod schema, return `result` directly.
     - Note: Because this runs *before* falling back to `Reflect.get(target, prop)`, required fields (`target === core`, `wrappers = []`) now have their `.min()`, `.positive()`, `.trim()` results properly re-wrapped in `wrapFieldProxy`!
   - **Step 5:** Fallback to `Reflect.get(target, prop, receiver)` (binding functions to `target` for `.parse()`, `.safeParse()`, etc.).

#### 3.4.2 $O(1)$ Lazy Shape Proxy (`createLazyShapeProxy`)
Instead of eagerly looping over all columns in `baseSchema.shape`:
```ts
function createLazyShapeProxy<TShape extends Record<string, z.ZodTypeAny>>(
	baseShape: TShape,
): RefinableShape<TShape> {
	const proxyCache = new Map<string, any>();

	return new Proxy(baseShape, {
		get(target, prop, receiver) {
			if (typeof prop !== "string" || !Object.prototype.hasOwnProperty.call(target, prop)) {
				return Reflect.get(target, prop, receiver);
			}
			let cached = proxyCache.get(prop);
			if (cached === undefined) {
				cached = wrapFieldProxy(target[prop]!);
				proxyCache.set(prop, cached);
			}
			return cached;
		},
	}) as unknown as RefinableShape<TShape>;
}
```
On a 100-column Drizzle table where a user refines 2 columns, `unwrapAll` and `new Proxy` run only $2$ times instead of $100$ times ($O(K)$ vs $O(N)$).

---

### 3.5 Layer 5: Sound Type System (`RefinedField<TCore, TOriginalWrapper>`)

To solve **Defect B4** (where returning a raw `z.string()` on an optional field caused `PreserveWrapper` to falsely type the field as optional, and where `.required()` / `.unwrap()` could not alter wrapper types), we attach a phantom type parameter `TWrapperCarrier` to `RefinedField`:

```ts
declare const REFINED_BRAND: unique symbol;

export type RemoveOptional<T extends z.ZodTypeAny> =
	T extends z.ZodOptional<infer Inner extends z.ZodTypeAny>
		? RemoveOptional<Inner>
		: T extends z.ZodExactOptional<infer Inner extends z.ZodTypeAny>
			? RemoveOptional<Inner>
			: T extends z.ZodNullable<infer Inner extends z.ZodTypeAny>
				? z.ZodNullable<RemoveOptional<Inner>>
				: T extends z.ZodDefault<infer Inner extends z.ZodTypeAny>
					? z.ZodDefault<RemoveOptional<Inner>>
					: T;

export type RemoveNullable<T extends z.ZodTypeAny> =
	T extends z.ZodNullable<infer Inner extends z.ZodTypeAny>
		? RemoveNullable<Inner>
		: T extends z.ZodOptional<infer Inner extends z.ZodTypeAny>
			? z.ZodOptional<RemoveNullable<Inner>>
			: T extends z.ZodExactOptional<infer Inner extends z.ZodTypeAny>
				? z.ZodExactOptional<RemoveNullable<Inner>>
				: T extends z.ZodDefault<infer Inner extends z.ZodTypeAny>
					? z.ZodDefault<RemoveNullable<Inner>>
					: T;

export type RefinedField<
	TCore extends z.ZodTypeAny,
	TWrapperCarrier extends z.ZodTypeAny = TCore,
> = TCore & {
	readonly [REFINED_BRAND]: TWrapperCarrier;

	setError(message: ErrorOverrideInput): RefinedField<TCore, TWrapperCarrier>;
	withError(message: ErrorOverrideInput): RefinedField<TCore, TWrapperCarrier>;

	format<F extends StringFormat>(
		formatName: F,
		params?: FormatParams,
		options?: ReplaceCoreOptions,
	): RefinedField<TCore, TWrapperCarrier>;

	asEmail(params?: FormatParams, options?: ReplaceCoreOptions): RefinedField<z.ZodEmail, TWrapperCarrier>;
	asUrl(params?: FormatParams, options?: ReplaceCoreOptions): RefinedField<z.ZodURL, TWrapperCarrier>;
	asUuid(params?: FormatParams, options?: ReplaceCoreOptions): RefinedField<z.ZodUUID, TWrapperCarrier>;
	asCuid2(params?: FormatParams, options?: ReplaceCoreOptions): RefinedField<z.ZodCUID2, TWrapperCarrier>;
	asUlid(params?: FormatParams, options?: ReplaceCoreOptions): RefinedField<z.ZodULID, TWrapperCarrier>;

	as<U extends z.ZodTypeAny>(
		newCoreSchema: U,
		options?: ReplaceCoreOptions,
	): RefinedField<DeepUnwrap<U>, TWrapperCarrier>;

	/** Strips all outer wrappers (optional, nullable, default), making the field strictly required. */
	unwrap(): RefinedField<TCore, TCore>;
	/** Removes optional/exactOptional wrappers while preserving nullable/default wrappers. */
	required(): RefinedField<TCore, RemoveOptional<TWrapperCarrier>>;
	/** Removes nullable wrappers while preserving optional/default wrappers. */
	nonnullable(): RefinedField<TCore, RemoveNullable<TWrapperCarrier>>;
};
```

Now look at how `refineSchema`'s return type resolves each key `K in keyof R`:
```ts
type ResolveRefinedField<
	TOriginal extends z.ZodTypeAny,
	TResult,
> = TResult extends { readonly [REFINED_BRAND]: infer TCarrier extends z.ZodTypeAny }
	? TResult extends RefinedField<infer TNewCore extends z.ZodTypeAny, any>
		? PreserveWrapper<TCarrier, DeepUnwrap<TNewCore>>
		: PreserveWrapper<TOriginal, DeepUnwrap<TResult & z.ZodTypeAny>>
	: TResult extends z.ZodTypeAny
		? // If the user chained a native Zod method on `fields.x` (e.g. `fields.age.min(18)`),
		  // TypeScript sees the return type of `ZodNumber.min()` which is `ZodNumber` (unbranded in TS types,
		  // even though proxied at runtime). Wait: how do we distinguish `fields.age.min(18)` from raw `z.number()`?
```

Let's examine that TypeScript subtlety carefully!
When `RefinedField<TCore, TWrapperCarrier>` intersects `TCore & { ... }`, calling a native Zod method like `fields.age.min(18)` resolves to `ZodNumber['min']`, whose TypeScript return signature in `"zod"` is `ZodNumber` (not `RefinedField<ZodNumber>`).
- If a user writes `age: fields.age.min(18)` on an optional column `age?: number`, they expect `PreserveWrapper<T["shape"]["age"], ZodNumber>` (`ZodOptional<ZodNumber>`).
- What if a user wants to strip optionality? With `.unwrap()` and `.required()` on `RefinedField`:
  - If we intersect common chainable methods or provide `.unwrap()` / `.required()`, what happens if someone writes `fields.bio.required().min(5)`?
  - If `.required()` returns `RefinedField<TCore, RemoveOptional<TWrapperCarrier>>`, and then they call `.min(5)` after `.required()`, `ZodString.min(5)` returns raw `ZodString` in TypeScript unless either:
    1. `.required()` / `.unwrap()` is called at the end of the chain (or we override key chainable methods / mapped return types), **OR**
    2. Even cleaner: `PreserveWrapper` is applied by default to `T["shape"][K]`, **unless** `R[K]` carries an explicit wrapper-override brand (from `.unwrap()`, `.required()`, `.nonnullable()`, or `.as(schema, { preserveWrappers: false })`)!

Let's verify that!
Why did people write `refineSchema(base, () => ({ bio: z.string() }))` in the first place? Either:
1. They wanted to replace the core type (which `.as(z.string())` does while preserving wrappers), OR
2. They wanted to make an optional field required (which `fields.bio.required()` or `fields.bio.unwrap()` now does explicitly!).
And what if someone calls `fields.bio.min(5).required()` vs `fields.bio.required()`?
If we also wrap the return types of standard core methods on `RefinedField`:
```ts
type RewrapMethods<TCore extends z.ZodTypeAny, TCarrier extends z.ZodTypeAny> = {
	[K in keyof TCore]: TCore[K] extends (...args: infer A) => infer R
		? R extends z.ZodOptional<any>
			? (...args: A) => RefinedField<TCore, z.ZodOptional<TCarrier>>
			: R extends z.ZodNullable<any>
				? (...args: A) => RefinedField<TCore, z.ZodNullable<TCarrier>>
				: R extends z.ZodDefault<any>
					? (...args: A) => RefinedField<TCore, z.ZodDefault<TCarrier>>
					: R extends z.ZodTypeAny
						? (...args: A) => RefinedField<DeepUnwrap<R>, TCarrier>
						: TCore[K]
		: TCore[K];
};
```
Look at what `RewrapMethods<TCore, TCarrier>` achieves:
1. Every method on `TCore` that returns a `z.ZodTypeAny` (like `.min()`, `.max()`, `.positive()`, `.int()`, `.trim()`, `.regex()`, `.refine()`) is automatically mapped at the type level to return `RefinedField<DeepUnwrap<R>, TCarrier>`!
2. That means **in TypeScript**, `fields.age.positive().setError("...")` and `fields.bio.required().min(5).setError("...")` are 100% type-valid in any order! Previously, `fields.age.positive().setError("...")` was not only a runtime crash on required fields, it was also a **TypeScript compile error** because `ZodNumber.positive()` returned `ZodNumber` (losing `RefinedField`'s `.setError()` type)!
3. Furthermore, because every chain starting from `fields.<col>` now preserves `RefinedField<..., TCarrier>` through every method call (`.min()`, `.max()`, `.trim()`, `.asEmail()`, `.required()`, `.unwrap()`, `.nullable()`, `.optional()`), TypeScript can **unambiguously distinguish**:
   - **Case A:** Any expression starting from `fields.<col>...` $\rightarrow$ has type `RefinedField<TNewCore, TCarrier>`, so the output field type is `PreserveWrapper<TCarrier, TNewCore>`.
   - **Case B:** A raw Zod schema expression *not* starting from `fields.<col>` (e.g., `bio: z.string().min(5)`) $\rightarrow$ does **not** have `REFINED_BRAND`, so the output field type is `R[K]` directly (honoring the exact raw schema the user provided without falsely re-wrapping it in `ZodOptional`)!

Let's double-check that!
- If the user writes `bio: fields.bio.min(5)` on an optional `bio` column:
  - `fields.bio` is `RefinedField<ZodString, ZodOptional<ZodString>>`.
  - `.min(5)` (via `RewrapMethods`) returns `RefinedField<ZodString, ZodOptional<ZodString>>`.
  - `ResolveRefinedField` sees `REFINED_BRAND` with carrier `ZodOptional<ZodString>` and core `ZodString`, producing `ZodOptional<ZodString>`.
- If the user writes `bio: fields.bio.required().min(5)` (or `fields.bio.min(5).required()`):
  - `.required()` updates `TCarrier` from `ZodOptional<ZodString>` to `ZodString` (and strips the optional wrapper at runtime!).
  - `.min(5)` preserves `TCarrier = ZodString`.
  - `ResolveRefinedField` produces `ZodString` (required at both compile-time and runtime!).
- If the user writes `bio: z.string().min(5)` (raw schema override without `fields.bio`):
  - At runtime, `modifiedFields.bio` is `z.string().min(5)` (required).
  - At compile time, `z.string().min(5)` does NOT have `REFINED_BRAND`, so `ResolveRefinedField` produces `ZodString` (required at both compile-time and runtime!).

This completely resolves both the TypeScript chaining loss on `.min().setError()` AND the Type-vs-Runtime divergence bug (Defect B4)!

---

## 4. Complete Blueprint of the Refactored `refine.ts`

Below is the exact structural blueprint of the refactored `src/refine.ts` working in tandem with `src/zod-compat.ts`:

```ts
// packages/drizzle-validators/src/refine.ts
import {
	base64,
	base64url,
	cidrv4,
	cidrv6,
	cuid,
	cuid2,
	e164,
	email,
	emoji,
	guid,
	httpUrl,
	ipv4,
	ipv6,
	jwt,
	ksuid,
	nanoid,
	string,
	ulid,
	url,
	uuid,
	uuidv4,
	uuidv6,
	uuidv7,
	xid,
	type z,
} from "zod";
import type { STRING_FORMAT_NAMES } from "./constants";
import {
	cloneSchemaWithDef,
	cloneZodCheck,
	getZodConstructor,
	getZodDef,
	hasLazyDefaultGetter,
	isExactOptionalSchema,
	isZodSchema,
	rebuildZodObject,
} from "./zod-compat";

export const UNWRAP_PROXY = Symbol.for("drizzle-validators.unwrapProxy");
declare const REFINED_BRAND: unique symbol;

export type StringFormat = (typeof STRING_FORMAT_NAMES)[number];
export type FormatParams = string | Record<string, any>;

export type KeepChecksPolicy = "compatible" | "all" | "none";

export interface ReplaceCoreOptions {
	keepChecks?: KeepChecksPolicy;
	transferChecks?: boolean;
}

export type CheckErrorKey =
	| "min"
	| "max"
	| "length"
	| "format"
	| "regex"
	| "startsWith"
	| "endsWith"
	| "includes"
	| "multipleOf"
	| "int"
	| "custom"
	| "type";

export type ErrorOverrideInput =
	| string
	| Partial<Record<CheckErrorKey, string>>;

export type WrapperDef = {
	type:
		| "optional"
		| "nullable"
		| "exactOptional"
		| "default"
		| "readonly"
		| "catch";
	defaultValue?: any;
	defaultValueRef?: unknown;
	catchValue?: any;
	catchValueRef?: unknown;
	constr?: unknown;
};
```

### 4.1 Wrapper Extraction & Reconstruction (`unwrapAll` & `applyWrappers`)
```ts
export function unwrapAll(field: z.ZodTypeAny): {
	core: z.ZodTypeAny;
	wrappers: WrapperDef[];
} {
	const wrappers: WrapperDef[] = [];
	let current: any = field;

	while (current) {
		const def = getZodDef(current);
		if (!def) break;

		if (def.type === "optional") {
			const isExact = isExactOptionalSchema(current);
			wrappers.push({ type: isExact ? "exactOptional" : "optional" });
			current = def.innerType;
		} else if (def.type === "nullable") {
			wrappers.push({ type: "nullable" });
			current = def.innerType;
		} else if (def.type === "readonly") {
			wrappers.push({ type: "readonly" });
			current = def.innerType;
		} else if (def.type === "default") {
			if (hasLazyDefaultGetter(def)) {
				wrappers.push({
					type: "default",
					defaultValueRef: def,
					constr: getZodConstructor(current, "lazy default unwrap"),
				});
			} else {
				wrappers.push({ type: "default", defaultValue: def.defaultValue });
			}
			current = def.innerType;
		} else if (def.type === "catch") {
			const hasGetter =
				Object.getOwnPropertyDescriptor(def, "catchValue")?.get !== undefined;
			if (hasGetter) {
				wrappers.push({
					type: "catch",
					catchValueRef: def,
					constr: getZodConstructor(current, "lazy catch unwrap"),
				});
			} else {
				wrappers.push({ type: "catch", catchValue: def.catchValue });
			}
			current = def.innerType;
		} else {
			break;
		}
	}

	return { core: current, wrappers };
}

export function applyWrappers(
	core: z.ZodTypeAny,
	wrappers: WrapperDef[],
): z.ZodTypeAny {
	let current: any = core;
	for (let i = wrappers.length - 1; i >= 0; i--) {
		const w = wrappers[i];
		if (!w) continue;
		switch (w.type) {
			case "optional":
				current = current.optional();
				break;
			case "nullable":
				current = current.nullable();
				break;
			case "exactOptional":
				current =
					typeof current.exactOptional === "function"
						? current.exactOptional()
						: current.optional();
				break;
			case "readonly":
				current = current.readonly();
				break;
			case "default":
				if (w.defaultValueRef !== undefined && w.constr) {
					const ref = w.defaultValueRef as any;
					current = new (w.constr as any)({
						type: "default",
						innerType: current,
						get defaultValue() {
							return ref.defaultValue;
						},
					});
				} else {
					current = current.default(w.defaultValue);
				}
				break;
			case "catch":
				if (w.catchValueRef !== undefined && w.constr) {
					const ref = w.catchValueRef as any;
					current = new (w.constr as any)({
						type: "catch",
						innerType: current,
						get catchValue() {
							return ref.catchValue;
						},
					});
				} else {
					current = current.catch(w.catchValue);
				}
				break;
		}
	}
	return current;
}
```

### 4.2 Check Classification, Deduplication & Cloning (`transferChecks`)
```ts
const CONSTRAINT_STRING_FORMATS = new Set([
	"regex",
	"starts_with",
	"ends_with",
	"includes",
]);

const OVERRIDABLE_BOUND_CHECKS = new Set([
	"min_length",
	"max_length",
	"length_equals",
	"greater_than",
	"less_than",
	"multiple_of",
	"number_format",
]);

const CHECK_CORE_COMPAT: Record<string, (coreType: string) => boolean> = {
	greater_than: (t) => t === "number" || t === "bigint" || t === "date",
	less_than: (t) => t === "number" || t === "bigint" || t === "date",
	multiple_of: (t) => t === "number" || t === "bigint",
	number_format: (t) => t === "number",
	overwrite: (t) => t === "string",
	min_length: (t) => t === "string" || t === "array" || t === "set",
	max_length: (t) => t === "string" || t === "array" || t === "set",
	length_equals: (t) => t === "string" || t === "array" || t === "set",
	string_format: (t) => t === "string",
	custom: () => true,
};

function hasTargetFormat(targetDef: InternalZodDef): boolean {
	if (typeof targetDef.format === "string" && targetDef.format.length > 0) {
		return true;
	}
	if (Array.isArray(targetDef.checks)) {
		for (const chk of targetDef.checks) {
			const d = getZodDef(chk);
			if (
				d?.check === "string_format" &&
				typeof d.format === "string" &&
				!CONSTRAINT_STRING_FORMATS.has(d.format)
			) {
				return true;
			}
		}
	}
	return false;
}

function collectTargetBoundKinds(targetDef: InternalZodDef): Set<string> {
	const kinds = new Set<string>();
	if (typeof targetDef.format === "string" && targetDef.format === "safeint") {
		kinds.add("number_format");
	}
	for (const chk of targetDef.checks ?? []) {
		const d = getZodDef(chk);
		if (d && typeof d.check === "string" && OVERRIDABLE_BOUND_CHECKS.has(d.check)) {
			kinds.add(d.check);
		}
	}
	return kinds;
}

export function transferChecks(
	source: z.ZodTypeAny,
	target: z.ZodTypeAny,
	options?: ReplaceCoreOptions,
): z.ZodTypeAny {
	const policy: KeepChecksPolicy =
		options?.keepChecks ??
		(options?.transferChecks === false ? "none" : "compatible");

	if (policy === "none") return target;

	const sourceDef = getZodDef(source);
	if (!sourceDef || !Array.isArray(sourceDef.checks) || sourceDef.checks.length === 0) {
		return target;
	}

	const targetDef = getZodDef(target);
	if (!targetDef) return target;

	const targetCoreType = targetDef.type;
	const targetAlreadyHasFormat = hasTargetFormat(targetDef);
	const targetBoundKinds = collectTargetBoundKinds(targetDef);

	let result: any = target;
	for (const check of sourceDef.checks) {
		const checkDef = getZodDef(check);
		if (!checkDef || typeof checkDef.check !== "string") continue;

		if (policy === "compatible") {
			const compat = CHECK_CORE_COMPAT[checkDef.check];
			if (!compat) {
				throw new Error(
					`[drizzle-validators] Unknown Zod check type "${checkDef.check}" encountered during check transfer. ` +
						`Pass { keepChecks: "none" } or { keepChecks: "all" } to .as() to disambiguate.`,
				);
			}
			// Custom (.refine) checks are only safe to transfer if the core type did not change
			if (checkDef.check === "custom" && sourceDef.type !== targetCoreType) {
				continue;
			}
			if (!compat(targetCoreType)) {
				continue;
			}

			// 1. Format deduplication: if target already defines a primary format (e.g. email, uuid),
			//    never transfer ANY non-constraint string_format from source (even if same format).
			if (checkDef.check === "string_format") {
				const fmt = String(checkDef.format ?? "");
				const isConstraint = CONSTRAINT_STRING_FORMATS.has(fmt);
				if (!isConstraint && targetAlreadyHasFormat) {
					continue;
				}
			}

			// 2. Bound deduplication: if target explicitly defines the same bound kind (e.g. min_length),
			//    the target's new bound wins instead of stacking both checks.
			if (
				OVERRIDABLE_BOUND_CHECKS.has(checkDef.check) &&
				targetBoundKinds.has(checkDef.check)
			) {
				continue;
			}
		}

		if (typeof result.check === "function") {
			result = result.check(cloneZodCheck(check));
		}
	}
	return result;
}
```

### 4.3 Callback Validation & Proxy Unwrapping in `refineSchema`
```ts
export function refineSchema<
	T extends z.ZodObject<any>,
	R extends RefinementCallbackResult<T["shape"]>,
>(
	baseSchema: T,
	refinementFn: (fields: RefinableShape<T["shape"]>) => R,
): z.ZodObject<
	Omit<T["shape"], keyof R> & {
		[K in keyof R]: K extends keyof T["shape"]
			? ResolveRefinedField<T["shape"][K], R[K]>
			: R[K] extends RefinedField<infer TCore, infer TCarrier>
				? PreserveWrapper<TCarrier, TCore>
				: R[K] extends z.ZodTypeAny
					? R[K]
					: never;
	}
> {
	if (!isZodSchema(baseSchema) || getZodDef(baseSchema)?.type !== "object") {
		throw new Error(
			`[drizzle-validators] refineSchema() expects a ZodObject as its first argument.`,
		);
	}
	if (typeof refinementFn !== "function") {
		throw new Error(
			`[drizzle-validators] refineSchema() expects a callback function as its second argument.`,
		);
	}

	const lazyShape = createLazyShapeProxy(baseSchema.shape);
	const modifiedFields = refinementFn(lazyShape);

	if (typeof modifiedFields !== "object" || modifiedFields === null || Array.isArray(modifiedFields)) {
		throw new Error(
			`[drizzle-validators] refineSchema() callback must return a plain object of field schemas, ` +
				`got ${modifiedFields === null ? "null" : typeof modifiedFields}.`,
		);
	}

	const mergedShape: Record<string, z.ZodTypeAny> = { ...baseSchema.shape };

	for (const [key, rawVal] of Object.entries(modifiedFields)) {
		if (rawVal === undefined) {
			// Treat undefined callback entries as a no-op (keep original field if present)
			continue;
		}
		// Unwrap our field proxy if present so raw Zod instances are stored in .shape
		const unwrapped = (rawVal as any)?.[UNWRAP_PROXY] ?? rawVal;
		if (!isZodSchema(unwrapped)) {
			throw new Error(
				`[drizzle-validators] Invalid refinement for field "${key}": expected a Zod schema, ` +
					`received ${unwrapped === null ? "null" : typeof unwrapped}.`,
			);
		}
		mergedShape[key] = unwrapped;
	}

	return rebuildZodObject(baseSchema, mergedShape) as any;
}
```

---

## 5. Phased Implementation Roadmap

### Phase 0 — Regression & Bug-Reproduction Suite
Before touching `src/refine.ts`, add a dedicated test file `packages/drizzle-validators/tests/refine-bugs-repro.test.ts` that pins the 7 defects:
1. Required field chaining: `f.age.positive().setError("Must be > 0")` and `f.email.min(3).asEmail()`.
2. Wrapper method chaining on proxied field: `f.name.nullable().min(2).setError("Too short")`.
3. Duplicate email check issue: refining an already-email field with `.asEmail({ error: "Custom" })` emits exactly $1$ issue on invalid input, not $2$.
4. Bound override loosening: refining a `z.string().min(5).max(10)` column via `.as(z.string().min(2).max(50))` accepts a 3-character and a 25-character string.
5. Explicit check discard: `.as(z.string(), { keepChecks: "none" })` drops all previous length/regex constraints while keeping `optional`/`nullable`/`default` wrappers.
6. Object-level preservation: `z.strictObject(...)`, `z.looseObject(...)`, `.catchall(...)`, and `.describe(...)` survive `refineSchema`.
7. Proxy unwrapping & type soundness: `refined.shape.email` is a native Zod instance (not a Proxy trap), `.required()` / `.unwrap()` removes optionality at both runtime and type level, and raw `bio: z.string()` overrides do not lie in `z.infer`.

### Phase 1 — Extract `src/zod-compat.ts`
1. Create `packages/drizzle-validators/src/zod-compat.ts` housing `isZodSchema`, `getZodDef`, `getZodConstructor`, `isExactOptionalSchema`, `hasLazyDefaultGetter`, `cloneZodCheck`, `cloneSchemaWithDef`, and `rebuildZodObject`.
2. Add a canary unit test `tests/zod-compat-canary.test.ts` verifying each helper against `zod@^4.4.3` primitives, wrappers, lazy defaults, checks, and strict/loose/catchall objects.

### Phase 2 — Upgrade Wrapper Stack, Check Engine & Granular `setError`
1. Extend `unwrapAll` and `applyWrappers` to support `readonly` and `catch` wrappers alongside `optional`, `exactOptional`, `nullable`, and `default`.
2. Update `transferChecks` with `KeepChecksPolicy` (`"compatible" | "all" | "none"`), format collision suppression, same-bound override deduplication, and `cloneZodCheck`.
3. Upgrade `setErrorOnField` to use `cloneSchemaWithDef` + `cloneZodCheck`, recurse into `element` (arrays), and accept both `string` and `Partial<Record<CheckErrorKey, string>>`.

### Phase 3 — Operation Registry, Universal Proxy & $O(1)$ Lazy Shape
1. Replace the 5 hardcoded `as*` proxy branches with `FORMAT_ALIAS_MAP` covering all 23 formats in `STRING_FORMAT_NAMES`.
2. Fix the method resolution order in `wrapFieldProxy` so core schema methods and wrapper methods always return re-proxied schemas (`wrapFieldProxy`), and implement `.unwrap()`, `.required()`, and `.nonnullable()`.
3. Add `[UNWRAP_PROXY]` and `createLazyShapeProxy` so `refineSchema` initializes in $O(1)$ time and strips proxies before calling `rebuildZodObject`.
4. Add runtime validation of `refinementFn`'s return value.

### Phase 4 — Branded Type System & Method Return Mapping (`RewrapMethods`)
1. Update `RefinedField<TCore, TWrapperCarrier>` with `REFINED_BRAND` and `RewrapMethods<TCore, TWrapperCarrier>`.
2. Update `refineSchema`'s return type to use `ResolveRefinedField` so chained methods (`.min(5).setError(...)`), wrapper mutations (`.required()`, `.unwrap()`, `.nullable()`), and raw schema overrides (`bio: z.string()`) infer exact, truthful types.
3. Verify with `tsc --noEmit` across the entire test suite.

---

## 6. Verification & Acceptance Criteria Matrix

| Category | Verification Check | Expected Outcome |
| :--- | :--- | :--- |
| **Chaining (B1)** | `f.age.positive().int().setError("Bad")` on required `z.number()` | Compiles cleanly in TS and parses/formats errors at runtime without `TypeError`. |
| **Deduplication (B2)** | `f.email.asEmail({ error: "New" })` on `z.email()` base field | `safeParse("bad").error.issues` has length `1` with message `"New"`. |
| **Bound Override (B2)** | `f.code.as(z.string().min(2))` on `z.string().min(5)` base field | `safeParse("abc").success === true` (old `min(5)` is replaced, not stacked). |
| **Object Policy (B3)** | `refineSchema(z.strictObject({ a: z.string() }), ...)` | `safeParse({ a: "ok", extra: 1 }).success === false` (`unrecognized_keys`). |
| **Serializer Round-Trip (B3)** | `zodTypeToCode(refineSchema(base, ...))` | Emits clean `z.object(...)` / `z.strictObject(...)` code with zero Proxy trap overhead. |
| **Wrapper Removal (B4)** | `f.bio.required().min(2)` on `z.string().optional()` | Rejects `undefined` at runtime AND `z.infer` types `bio: string` (not `string \| undefined`). |
| **Raw Override Soundness (B4)** | `refineSchema(base, () => ({ bio: z.string() }))` on optional `bio` | Rejects `undefined` at runtime AND `z.infer` types `bio: string`. |
| **Lazy Performance (B7)** | `refineSchema` on a 100-column `ZodObject` touching 1 column | Only 1 field is unwrapped/proxied; remaining 99 columns are never inspected. |
| **Existing Suite** | `bun test` & `tsc --noEmit` | 100% pass rate on all existing `refine-schema`, `wrapper-edge-cases`, `modifiers-and-wrappers`, `composition-chains`, `complex-types`, and `zod4-error-formatting` tests. |