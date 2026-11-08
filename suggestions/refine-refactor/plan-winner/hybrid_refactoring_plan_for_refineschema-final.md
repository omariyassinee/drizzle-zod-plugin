# Hybrid Refactoring Plan: Minimalist, Type-Sound `refineSchema` Engine

> **Target Package:** `@vacuus/drizzle-validators`  
> **Primary Target File:** `packages/drizzle-validators/src/refine.ts`  
> **Cross-Referenced Modules:** `src/constants.ts`, `src/zod-serializer.ts`, `src/dts-builder.ts`, `src/schema-generator.ts`  
> **Baseline:** `zod@^4.4.3` (peer `^4.0.0`)

---

## 0. Executive Summary

The original `refineSchema` implementation attempted to impersonate every Zod prototype method through a deep `Proxy` while maintaining a hardcoded whitelist of format aliases (`asEmail`, `asUrl`, `asUuid`, `asCuid2`, `asUlid`, `.format()`). In Zod 4, formats are already top-level primitives (`z.email()`, `z.uuid()`, `z.url()`), making custom format aliases redundant boilerplate that requires four-place edits whenever Zod adds a format.

This plan refactors `refineSchema` into a **Dual-Mode Minimalist Engine** built around two explicit, composable patterns:

1. **Wrapper & Constraint-Preserving Replacement (`fields.<col>.as(newCore, opts?)`)**:
   Replaces the inner core validator with any native validator (e.g., `z.email()`, `z.int().min(18)`) while automatically preserving the Drizzle column's outer wrappers (`optional`, `nullable`, `exactOptional`, and lazy/static `default`) and transferring non-conflicting database constraints (such as `varchar(255)` max-length bounds).
2. **Direct Validator Replacement (`<col>: rawValidator`)**:
   Overwrites the column wholesale—discarding database wrappers and column checks—when the developer passes a raw Zod (or Valibot/TypeBox) schema directly.

---

## 1. Root-Cause Defects Resolved by This Architecture

| # | Defect in Current `src/refine.ts` | Root Cause | Resolution in New Architecture |
| :--- | :--- | :--- | :--- |
| **1** | **Hardcoded `as*` & `.format()` Bloat** (`refine.ts:226–270, 476–535`) | `FORMAT_BUILDERS` and five duplicate Proxy branches (`asEmail`, `asUrl`, etc.) re-implement Zod 4's own `z.email()`, `z.url()`, etc. | **Deleted.** Developers pass native Zod 4 builders directly to `.as(z.email())`. |
| **2** | **Chaining Collapse on Required Fields** (`refine.ts:537–540`) | `if (prop in target) return val.bind(target)` runs before `core` delegation. On required fields (`target === core`), calling `.positive()` or `.min()` returns an unproxied Zod schema, crashing subsequent `.setError()` calls. | **Fixed.** Standard constraints are chained directly inside `.as(z.int().positive())`, and any method delegated through the field proxy always re-wraps the output via `wrapFieldProxy`. |
| **3** | **Check Duplication & Blocked Constraint Loosening** (`refine.ts:321–358`) | `transferChecks` blindly appends all compatible source checks onto the target. Overriding `varchar(255)` with `.as(z.string().max(500))` keeps `.max(255)` active; replacing an email with `.as(z.email({ error: "New" }))` fires both old and new email checks. | **Fixed.** Target-Wins Check Deduplication skips any source check whose constraint kind already exists on `newCoreSchema`. Also adds `{ transferChecks: false }` to `.as()`. |
| **4** | **Type-vs-Runtime Wrapper Divergence** (`refine.ts:583–593`) | The return type unconditionally wraps every key in `PreserveWrapper<T["shape"][K], DeepUnwrap<R[K]>>`. Returning a raw `z.string()` on an optional column strips `optional` at runtime, but TypeScript still types the field as `string \| undefined`. | **Fixed.** Fields produced via `fields.<col>` carry a phantom symbol brand (`[REFINED_FIELD_BRAND]`). `PreserveWrapper` is only applied to branded returns; raw schema overrides infer their exact type. |
| **5** | **Silent Base Object Degradation** (`refine.ts:600–603`) | Final assembly calls `object({ ...baseSchema.shape, ...modifiedFields })`, erasing `z.strictObject()`, `z.looseObject()`, and custom `.catchall()` policies. | **Fixed.** `reconstructObjectSchema` inspects `baseDef.catchall` (matching `src/zod-serializer.ts:595–605`) and preserves strict, loose, or custom catchall behavior. |
| **6** | **$O(N)$ Eager Unwrapping & Proxy Leaks** (`refine.ts:594–603`) | `refineSchema` loops over every column in `baseSchema.shape` upfront and leaves `Proxy` instances inside the final `ZodObject.shape`. | **Fixed.** $O(1)$ lazy shape proxy unwraps only accessed columns, and `UNWRAP_PROXY` strips proxy wrappers before building the final `ZodObject`. |

---

## 2. Public API & Syntax Specification

### 2.1 Ergonomic Usage (Zod 4)

```typescript
import { z } from "zod";
import { insertSchema as baseUsersInsert } from "virtual:drizzle-validators/users";
import { refineSchema } from "@vacuus/drizzle-validators/refine";

export const usersInsertSchema = refineSchema(baseUsersInsert, (fields) => ({
  // 1. Format specialization via native Zod 4 primitive + .as()
  // Preserves DB wrappers (optional/nullable/default) AND varchar(255) max_length!
  email: fields.email.as(z.email({ error: "Please enter a valid email address" })),

  // 2. Numeric refinement via .as() (target checks supersede DB checks of the same kind)
  age: fields.age.as(
    z.int().min(18, { error: "Must be 18 or older" }).max(120),
  ),

  // 3. Opting out of DB column check transfer while keeping DB wrappers
  // Discards DB's .min(10).max(500), applies .min(2), keeps .optional() / .nullable()
  bio: fields.bio.as(z.string().min(2), { transferChecks: false }),

  // 4. Relabeling existing DB check errors in-place without changing types
  username: fields.username.setError("Username must be between 3 and 32 characters"),

  // 5. Explicit wrapper manipulation (.required(), .nonnullable(), .unwrap())
  // Drops .optional() while keeping .nullable(), then swaps core to z.url()
  avatarUrl: fields.avatarUrl.required().as(z.url()),

  // 6. Direct Replacement (No .as())
  // Drops all DB wrappers and DB constraints. Inferred type is strictly z.ZodEnum<...>
  role: z.enum(["admin", "member", "guest"]),

  // 7. Adding virtual/form-only fields not in the database table
  confirmPassword: z.string().min(8),
}));
```

### 2.2 `RefinedField<T>` Surface

By removing `asEmail`, `asUrl`, `asUuid`, `asCuid2`, `asUlid`, and `.format()`, the `RefinedField` interface becomes minimal, orthogonal, and impervious to Zod format churn:

```typescript
export declare const REFINED_FIELD_BRAND: unique symbol;

export interface AsOptions {
  /**
   * When true (default), compatible validation checks from the database column
   * (such as `varchar(n)` max-length bounds) that do not conflict with checks
   * already defined on `newCoreSchema` are transferred onto `newCoreSchema`.
   *
   * Set to `false` to use `newCoreSchema` with zero inherited column checks
   * while still preserving outer wrappers (`optional`, `nullable`, `default`).
   *
   * @default true
   */
  transferChecks?: boolean;
}

export type RefinedField<T extends z.ZodTypeAny, TOriginalWrapper = T> = T & {
  readonly [REFINED_FIELD_BRAND]: TOriginalWrapper;

  /**
   * Replaces the inner core schema with `newCoreSchema` while automatically
   * preserving outer wrappers (`optional`, `nullable`, `default`, `exactOptional`)
   * and non-conflicting column constraints.
   */
  as<U extends z.ZodTypeAny>(
    newCoreSchema: U,
    options?: AsOptions,
  ): RefinedField<U, PreserveWrapper<TOriginalWrapper, DeepUnwrap<U>>>;

  /**
   * Immutably overrides the error message on all existing checks of this field.
   */
  setError(message: string): RefinedField<T, TOriginalWrapper>;

  /**
   * Alias for `setError`.
   */
  withError(message: string): RefinedField<T, TOriginalWrapper>;

  /**
   * Strips all outer wrappers (`optional`, `nullable`, `default`, `exactOptional`),
   * returning the raw inner core schema.
   */
  unwrap(): RefinedField<DeepUnwrap<T>, DeepUnwrap<TOriginalWrapper>>;

  /**
   * Removes `optional` and `exactOptional` wrappers while preserving `nullable` and `default`.
   */
  required(): RefinedField<T, RemoveOptional<TOriginalWrapper>>;

  /**
   * Removes `nullable` wrappers while preserving `optional`, `exactOptional`, and `default`.
   */
  nonnullable(): RefinedField<T, RemoveNullable<TOriginalWrapper>>;
};
```

---

## 3. Core Internal Modules & Technical Design

### 3.1 `src/zod-compat.ts` — Isolated Zod 4 Internals Boundary

All reads and reconstructions of `_zod.def`, `_zod.constr`, `_zod.traits`, and `defaultValue` property descriptors are isolated in `src/zod-compat.ts`. `src/refine.ts` performs zero raw `_zod` accesses.

```typescript
import type { z } from "zod";

export const UNWRAP_PROXY = Symbol.for("drizzle-validators.unwrap-proxy");

export type WrapperLayer =
  | { type: "optional" }
  | { type: "exactOptional" }
  | { type: "nullable" }
  | {
      type: "default";
      defaultValue?: unknown;
      defaultValueGetterDef?: Record<string, unknown>;
      constr?: new (def: any) => z.ZodTypeAny;
    };

export function getZodDef(schema: unknown): Record<string, any> | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  return (schema as any)._zod?.def ?? (schema as any)._def ?? (schema as any).def;
}

export function getZodConstructor(
  schema: unknown,
): (new (def: any) => any) | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const constr = (schema as any)._zod?.constr;
  return typeof constr === "function" ? constr : undefined;
}

export function isZodSchema(value: unknown): value is z.ZodTypeAny {
  const def = getZodDef(value);
  return def !== undefined && typeof def.type === "string";
}

export function isExactOptional(schema: unknown): boolean {
  const traits = (schema as any)?._zod?.traits as Set<string> | undefined;
  return traits instanceof Set && traits.has("ZodExactOptional");
}

export function hasLazyDefaultGetter(def: Record<string, any>): boolean {
  return (
    Object.getOwnPropertyDescriptor(def, "defaultValue")?.get !== undefined
  );
}
```

### 3.2 Target-Wins Check Deduplication (`transferChecks`)

When `fields.email.as(z.email())` or `fields.bio.as(z.string().max(100))` is called, `transferChecks` inspects the checks already present on `target` (`newCoreSchema`) before transferring checks from `source` (`core`):

1. **Opt-Out Short Circuit:** If `options?.transferChecks === false`, return `target` immediately.
2. **Collect Target Signatures:** Build a `Set<string>` of check signatures already defined on `target`:
   * For constraint checks (`min_length`, `max_length`, `length_equals`, `greater_than`, `less_than`, `multiple_of`, `number_format`), the signature is `checkDef.check` (e.g., `"max_length"`).
   * For `string_format` checks:
     * If `CONSTRAINT_STRING_FORMATS.has(fmt)` (`regex`, `starts_with`, `ends_with`, `includes`), track by `string_format:${fmt}` so an explicit `.regex()` on `target` overrides the column's `.regex()`.
     * If it is a primary format (`email`, `uuid`, `url`, etc.) or `targetDef.format` is defined, mark `"primary_string_format"` as present on `target`.
3. **Transfer Non-Colliding Source Checks:**
   * Skip any source check incompatible with `targetDef.type` via `CHECK_CORE_COMPAT`.
   * Skip any source check whose signature is already in the target's signature set (**Target Wins**).
   * Clone each surviving check via `new checkConstr({ ...checkDef })` so check instances are never shared by reference across schemas.

```typescript
export function transferChecks(
  source: z.ZodTypeAny,
  target: z.ZodTypeAny,
  options?: AsOptions,
): z.ZodTypeAny {
  if (options?.transferChecks === false) return target;

  const sourceDef = getZodDef(source);
  if (!sourceDef || !Array.isArray(sourceDef.checks) || sourceDef.checks.length === 0) {
    return target;
  }

  const targetDef = getZodDef(target);
  if (!targetDef) return target;

  const targetCoreType = targetDef.type as string | undefined;
  const occupiedKinds = collectOccupiedCheckKinds(targetDef);

  let result: any = target;
  for (const check of sourceDef.checks) {
    const checkDef = getZodDef(check);
    if (!checkDef) continue;

    // 1. Verify core-type compatibility (e.g. never graft greater_than onto string)
    const compat = CHECK_CORE_COMPAT[checkDef.check];
    if (compat && targetCoreType && !compat(targetCoreType, checkDef)) {
      continue;
    }

    // 2. Target-Wins Deduplication: if target already defines this check kind, skip source check
    const signature = getCheckSignature(checkDef);
    if (signature && occupiedKinds.has(signature)) {
      continue;
    }

    // 3. Clone check instance to prevent cross-schema reference sharing
    const clonedCheck = cloneCheckInstance(check, checkDef);
    if (typeof result.check === "function") {
      result = result.check(clonedCheck);
    }
  }

  return result;
}

function getCheckSignature(checkDef: Record<string, any>): string | undefined {
  const kind = checkDef.check as string | undefined;
  if (!kind) return undefined;

  if (kind === "string_format") {
    const fmt = checkDef.format as string | undefined;
    if (fmt && CONSTRAINT_STRING_FORMATS.has(fmt)) {
      return `string_format:${fmt}`;
    }
    return "string_format:__primary__";
  }

  return kind;
}

function collectOccupiedCheckKinds(targetDef: Record<string, any>): Set<string> {
  const occupied = new Set<string>();
  if (typeof targetDef.format === "string" && !CONSTRAINT_STRING_FORMATS.has(targetDef.format)) {
    occupied.add("string_format:__primary__");
  }
  if (Array.isArray(targetDef.checks)) {
    for (const check of targetDef.checks) {
      const d = getZodDef(check);
      if (!d) continue;
      const sig = getCheckSignature(d);
      if (sig) occupied.add(sig);
    }
  }
  return occupied;
}
```

### 3.3 Fixing Required-Field Chaining & Proxy Unwrapping

In `wrapFieldProxy`, any method call on the field must route through `core` (or re-wrap `target` if it is a wrapper modifier like `.optional()` / `.nullable()`) and return a newly proxied field. Furthermore, accessing `[UNWRAP_PROXY]` returns the raw underlying `z.ZodTypeAny` so `refineSchema` never leaks `Proxy` instances into the final `ZodObject.shape`:

```typescript
function wrapFieldProxy(
  field: z.ZodTypeAny,
  explicitState?: { core: z.ZodTypeAny; wrappers: WrapperLayer[] },
): any {
  const { core, wrappers } = explicitState ?? unwrapAll(field);

  return new Proxy(field, {
    has(target, prop) {
      if (
        prop === UNWRAP_PROXY ||
        prop === REFINED_FIELD_BRAND ||
        prop === "as" ||
        prop === "setError" ||
        prop === "withError" ||
        prop === "unwrap" ||
        prop === "required" ||
        prop === "nonnullable"
      ) {
        return true;
      }
      return prop in target || prop in core;
    },
    get(target, prop, receiver) {
      if (prop === UNWRAP_PROXY) return target;

      if (prop === "as") {
        return (newCoreSchema: z.ZodTypeAny, options?: AsOptions) => {
          if (!isZodSchema(newCoreSchema)) {
            throw new Error(
              `[drizzle-validators] .as() expects a valid Zod schema, got ${typeof newCoreSchema}.`,
            );
          }
          const innerTarget = unwrapProxy(newCoreSchema);
          const mergedCore = transferChecks(core, innerTarget, options);
          const rewrapped = applyWrappers(mergedCore, wrappers);
          return wrapFieldProxy(rewrapped, { core: mergedCore, wrappers });
        };
      }

      if (prop === "setError" || prop === "withError") {
        return (msg: string) => {
          const updated = setErrorOnField(target, msg);
          return wrapFieldProxy(updated);
        };
      }

      if (prop === "unwrap") {
        return () => wrapFieldProxy(core, { core, wrappers: [] });
      }

      if (prop === "required") {
        return () => {
          const filtered = wrappers.filter(
            (w) => w.type !== "optional" && w.type !== "exactOptional",
          );
          const rebuilt = applyWrappers(core, filtered);
          return wrapFieldProxy(rebuilt, { core, wrappers: filtered });
        };
      }

      if (prop === "nonnullable") {
        return () => {
          const filtered = wrappers.filter((w) => w.type !== "nullable");
          const rebuilt = applyWrappers(core, filtered);
          return wrapFieldProxy(rebuilt, { core, wrappers: filtered });
        };
      }

      // Wrapper-adding methods (.optional(), .nullable(), .default())
      if (
        prop === "optional" ||
        prop === "exactOptional" ||
        prop === "nullable" ||
        prop === "default"
      ) {
        const fn = Reflect.get(target, prop, receiver);
        if (typeof fn === "function") {
          return (...args: unknown[]) => {
            const nextSchema = fn.apply(target, args);
            return wrapFieldProxy(nextSchema);
          };
        }
      }

      // Core constraint methods (.min(), .max(), .positive(), .trim(), .refine(), etc.)
      // Checked BEFORE raw target properties so required fields (target === core)
      // return a re-proxied schema instead of an unproxied Zod instance!
      if (
        typeof prop === "string" &&
        !prop.startsWith("_") &&
        typeof (core as any)[prop] === "function"
      ) {
        return (...args: unknown[]) => {
          const res = (core as any)[prop](...args);
          if (isZodSchema(res)) {
            const rewrapped = applyWrappers(res, wrappers);
            return wrapFieldProxy(rewrapped, { core: res, wrappers });
          }
          return res;
        };
      }

      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? val.bind(target) : val;
    },
  });
}
```

### 3.4 $O(1)$ Lazy Shape Proxy & Object Policy Reconstruction

Instead of looping over all columns in `baseSchema.shape` on every `refineSchema` call, a lazy proxy initializes field proxies only when accessed inside `refinementFn`. Afterward, `reconstructObjectSchema` preserves `strictObject`, `looseObject`, or custom `catchall` configurations using the exact `def.catchall` inspection verified in `src/zod-serializer.ts:595–605`:

```typescript
function createLazyShapeProxy(
  shape: Record<string, z.ZodTypeAny>,
): Record<string, any> {
  const cache = new Map<string | symbol, any>();
  return new Proxy(shape, {
    get(target, prop, receiver) {
      if (typeof prop !== "string" || !(prop in target)) {
        return Reflect.get(target, prop, receiver);
      }
      let proxied = cache.get(prop);
      if (!proxied) {
        proxied = wrapFieldProxy(target[prop]!);
        cache.set(prop, proxied);
      }
      return proxied;
    },
  });
}

function reconstructObjectSchema(
  baseSchema: z.ZodObject<any>,
  mergedShape: Record<string, z.ZodTypeAny>,
): z.ZodObject<any> {
  const baseDef = getZodDef(baseSchema);
  const catchall = baseDef?.catchall as z.ZodTypeAny | undefined;
  const catchallDef = getZodDef(catchall);

  let built: z.ZodObject<any>;
  if (catchallDef?.type === "never") {
    built = strictObject(mergedShape);
  } else if (catchallDef?.type === "unknown") {
    built = looseObject(mergedShape);
  } else if (catchall) {
    built = object(mergedShape).catchall(catchall);
  } else {
    built = object(mergedShape);
  }

  return built;
}
```

### 3.5 Type-Sound Return Signature (Branded vs. Raw Override)

By checking whether `R[K]` carries `REFINED_FIELD_BRAND`, TypeScript accurately distinguishes between:
* `fields.bio.as(z.string().min(2))` $\rightarrow$ preserves `baseSchema`'s `ZodOptional` wrapper (`REFINED_FIELD_BRAND` is present).
* `fields.bio.required().as(z.string().min(2))` $\rightarrow$ strips `ZodOptional` (`REFINED_FIELD_BRAND` carries `RemoveOptional<Original>`).
* `bio: z.string().min(2)` $\rightarrow$ raw replacement; does **not** carry `REFINED_FIELD_BRAND`, so `z.ZodString` is emitted directly without falsely re-wrapping it in `ZodOptional`.

```typescript
type ResolveRefinedField<
  TOriginal extends z.ZodTypeAny,
  TReturned,
> = TReturned extends { readonly [REFINED_FIELD_BRAND]: infer TWrapper extends z.ZodTypeAny }
  ? TReturned extends RefinedField<infer TCore, any>
    ? PreserveWrapper<TWrapper, DeepUnwrap<TCore>>
    : TOriginal
  : TReturned extends z.ZodTypeAny
    ? TReturned
    : TOriginal;

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
      : R[K] extends z.ZodTypeAny
        ? R[K]
        : never;
  }
> {
  if (typeof refinementFn !== "function") {
    throw new Error(
      "[drizzle-validators] refineSchema expects a refinement callback function as its second argument.",
    );
  }

  const lazyFields = createLazyShapeProxy(baseSchema.shape);
  const rawResult = refinementFn(lazyFields as any);

  if (!rawResult || typeof rawResult !== "object") {
    throw new Error(
      "[drizzle-validators] refineSchema callback must return an object mapping field names to schemas.",
    );
  }

  const nextShape: Record<string, z.ZodTypeAny> = { ...baseSchema.shape };

  for (const [key, val] of Object.entries(rawResult)) {
    if (val === undefined) continue;
    const unwrapped = unwrapProxy(val);
    if (!isZodSchema(unwrapped)) {
      throw new Error(
        `[drizzle-validators] Invalid refinement for field "${key}": expected a Zod schema instance, received ${typeof val}.`,
      );
    }
    nextShape[key] = unwrapped;
  }

  return reconstructObjectSchema(baseSchema, nextShape) as any;
}
```

---

## 4. Multi-Target Extensibility (Valibot & TypeBox)

Because `.as(newCore, opts?)` and direct validator assignment do not rely on Zod method names, the exact same dual-mode contract extends cleanly to `valibot` and `typebox` whenever you choose to enable `refineSchema` for non-Zod targets:

| Operation | Zod (`zod`) | Valibot (`valibot`) | TypeBox (`typebox`) |
| :--- | :--- | :--- | :--- |
| **Unwrap Containers** | `def.type` (`optional`, `nullable`, `default`) | `schema.type` (`optional`, `nullable`, `nullish`, `exact_optional`) via `schema.wrapped` | `t.Optional` symbol/property & `anyOf: [..., { type: "null" }]` |
| **Transfer Column Checks** | Clone non-colliding `def.checks` (`max_length`, `greater_than`, `less_than`) | Copy non-colliding actions from `source.pipe` (`max_length`, `min_value`, `max_value`) into `v.pipe(newCore, ...)` | Copy non-colliding JSON Schema keys (`maxLength`, `minLength`, `minimum`, `maximum`) onto `newCore` |
| **Direct Override** | `email: z.email()` | `email: v.pipe(v.string(), v.email())` | `email: t.String({ format: "email" })` |

---

## 5. Phased Implementation Plan

### Phase 1: Isolate Zod 4 Internals (`src/zod-compat.ts`)
1. Extract `getZodDef`, `getZodConstructor`, `isZodSchema`, `isExactOptional`, `hasLazyDefaultGetter`, `unwrapAll`, and `applyWrappers` into `src/zod-compat.ts`.
2. Add `UNWRAP_PROXY` symbol handling so proxied fields always unwrap cleanly before entering `z.object()`.

### Phase 2: Refactor `src/refine.ts` to Dual-Mode `.as()` Engine
1. Remove `FORMAT_BUILDERS`, `createFormatSchema`, `.format()`, and `asEmail` / `asUrl` / `asUuid` / `asCuid2` / `asUlid`.
2. Implement `transferChecks` with Target-Wins Check Deduplication and `{ transferChecks?: boolean }`.
3. Add `.unwrap()`, `.required()`, and `.nonnullable()` wrapper modifiers to `wrapFieldProxy`.
4. Fix the required-field method delegation order in `wrapFieldProxy` so `core` methods are wrapped before falling back to `Reflect.get(target)`.
5. Replace eager `baseSchema.shape` iteration with `createLazyShapeProxy` and reconstruct the output object via `reconstructObjectSchema`.
6. Update `RefinedField` and `refineSchema` type signatures with `REFINED_FIELD_BRAND` so direct replacements and `.as()` replacements infer distinct, sound wrapper types.

### Phase 3: Test Suite Migration & Regression Coverage
1. Update existing tests that called `.asEmail(...)` / `.asUuid(...)` / `.format(...)` to use `.as(z.email(...))` / `.as(z.uuid(...))`.
2. Add focused regression tests covering:
   * **Required-field chaining:** `f.age.positive().max(120).setError("...")` on non-optional columns.
   * **Constraint deduplication:** `.as(z.email({ error: "Custom" }))` emits a single error issue; `.as(z.string().max(500))` overrides a column's `.max(255)`; `.as(z.email())` preserves a column's `.max(255)`.
   * **Check transfer opt-out:** `.as(z.string(), { transferChecks: false })` drops column length checks while retaining `.optional()` / `.nullable()`.
   * **Type & runtime wrapper parity:** Direct override (`bio: z.string()`) makes an optional column required in both runtime parsing and `z.infer`, whereas `f.bio.as(z.string())` preserves optionality in both.
   * **Object policy survival:** `z.strictObject`, `z.looseObject`, and `.catchall()` survive `refineSchema`.