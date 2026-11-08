# Architecture & Design Analysis: React Hook Form Empty-String Mismatch & Schema Middleware

> **Target Package:** `@vacuus/drizzle-validators`
> **Affected Subsystems:** `src/refine.ts`, `src/zod-compat.ts`, `src/zod-serializer.ts`
> **Context:** Bridging HTML DOM / React Hook Form (`""`) semantics with Drizzle ORM / Zod (`undefined` | `null`) column constraints.

---

## 1. Diagnosis: Are You Right About React Hook Form?

**Yes — your diagnosis of the React + React Hook Form (RHF) + Zod triangle is spot on.** Here is the exact mechanical breakdown of what happens under the hood:

1. **The React DOM Controlled Input Rule**:
   An HTML `<input type="text">` has no concept of `undefined` or `null` in the DOM—its `element.value` is strictly a `DOMString` (defaulting to `""`). If you pass `value={undefined}` to a React `<input>` (e.g., via RHF's `<Controller>` or `useController`) and the user types a character, the prop transitions from `undefined` $\rightarrow$ `"a"`. React immediately logs:
   > *Warning: A component is changing an uncontrolled input to be controlled.*
   Furthermore, if `defaultValues` has `bio: undefined`, calling `form.reset()` in RHF fails to clear Controlled inputs back to empty unless they are initialized with `""`.

2. **The Drizzle / Zod Validation Conflict**:
   To satisfy React and RHF, developers initialize optional/nullable string fields with `""` (`defaultValues: { bio: "" }`).
   - However, your Drizzle schema generated:
     ```ts
     bio: z.string().min(3).max(500).nullable().optional()
     ```
   - To Zod, `""` **is a valid, defined string of length 0**.
   - Instead of short-circuiting through `.optional()` or `.nullable()`, Zod enters the `z.string()` validator and fails on `.min(3)` (or `z.email()`, `z.uuid()`, `z.url()`)—even though the user left the optional field completely blank!

3. **The Database Pollution Problem**:
   Even if there is *no* `.min(3)` check on `bio`, submitting `""` writes an empty string `""` into your database column instead of `NULL`, breaking SQL `WHERE bio IS NULL` queries and `UNIQUE` indexes on nullable columns (where PostgreSQL allows multiple `NULL`s, but only one `""`).

---

## 2. Why Plugin-Level (Build-Time) Middleware Is a Trap

You mentioned passing a middleware or coercion prop to **both** the Vite plugin options (`drizzleValidators("zod", { ... })`) and `refineSchema`.

Let's look at why putting arbitrary middleware in the **Vite Plugin / CLI options** conflicts with the core architecture of `@vacuus/drizzle-validators`:

1. **Static Code Serialization Boundary (`P2-01` & `P2-18`)**:
   The Vite plugin and CLI serialize runtime schemas into **static source code** (`zod-serializer.ts`). As proven by findings `P2-01` and `P2-18` in your codebase, arbitrary JavaScript closures (like custom `.transform(fn)` or `.preprocess(fn)` callbacks) **cannot safely round-trip to static code** via `.toString()`.
2. **Select vs. Insert/Update Corruption**:
   Plugin options apply globally to code generation. You *never* want `selectSchema` (data coming *out* of the database) to have form-input preprocessors attached, nor do you want non-form server-to-server RPC endpoints to pay the overhead of DOM string coercion.
3. **Type Inference Fragility**:
   If a build-time option wraps fields in `z.preprocess(...)` or `z.pipe(...)`, the emitted root types change from `z.ZodOptional<z.ZodString>` to `z.ZodPipe<...>`, which would break `refineSchema`'s `unwrapAll` and `DeepUnwrap<T>` unless `refine.ts` is taught to unwrap pipes as well.

**Verdict on Where It Belongs:**
- **Not in Vite Plugin Options:** Keep codegen 100% faithful to the Drizzle DDL.
- **Yes in `refineSchema` (Runtime):** `refineSchema` runs at application runtime (where closures and transforms are completely legal and zero-cost to serialize) and is already where you adapt database schemas into form/API schemas.

---

## 3. Evaluating Your Two Proposed Solutions in `refineSchema`

### Approach A: Hardcoded Prop (`emptyStringAsUndefined` / `coerceEmpty`)
*How it looks:* `refineSchema(insertSchema, (f) => ({ ... }), { emptyToNullish: true })`
- **Pros:** Zero boilerplate for the 90% RHF use case.
- **Cons:** As you noted, it feels hardcoded. What if a user wants to trim whitespace *before* checking if it's empty? What if they want `""` $\rightarrow$ `null` on nullable columns, `""` $\rightarrow$ `undefined` on optional columns, or `NaN` $\rightarrow$ `undefined` on number inputs (`valueAsNumber`)? A boolean flag quickly turns into 5 boolean flags.

### Approach B: Schema / Field Middleware (`beforeParse` / Field Interceptors)
*How it looks:* A composable **Field Interceptor (Middleware)** hook in `refineSchema` (plus a built-in preset for RHF so you get a 1-liner *and* infinite flexibility).
- **Pros:**
  1. **Solves RHF Empty Strings Intelligently:** A middleware can inspect the field's extracted `WrapperDef[]` stack and its `core` type!
     - If `core` is `"string"` and `wrappers` includes `"nullable"`, convert `""` $\rightarrow$ `null`.
     - If `core` is `"string"` and `wrappers` includes `"optional"`, convert `""` $\rightarrow$ `undefined`.
     - If `core` is `"string"` and required (no `optional`/`nullable`), leave `""` alone so `.min(1, "Required")` triggers properly!
  2. **Unlocks Other Real-World Form Edge Cases:**
     - **HTML Number Inputs (`valueAsNumber`):** `<input type="number">` in RHF produces `NaN` when cleared. A middleware can convert `Number.isNaN(val) ? undefined : val` on optional number fields.
     - **Global String Sanitization:** Automatically `.trim()` all string fields across a 40-column table without writing `f.col.trim()` 40 times.
     - **`FormData` Boolean / JSON Coercion:** Parse `"true"` / `"false"` or comma-separated arrays before validation.

---

## 4. Recommended Hybrid Design: `refineSchema` Middleware + Built-in Form Presets

We can extend `refineSchema` with an optional 3rd parameter (`options?: RefineSchemaOptions`) that accepts **Field Middlewares**, while shipping a first-class, tree-shakeable `emptyToNullish()` (or `formInputMiddleware()`) helper out of `@vacuus/drizzle-validators/refine`.

### 4.1 The Middleware Contract

During `refineSchema`, every field in the final shape already has a known `{ core, wrappers }` state (from `unwrapAll`). A `FieldMiddleware` receives the field's metadata and can transform the schema or wrap it in a preprocessor:

```ts
export interface FieldMiddlewareContext {
	/** Column / field key in the object schema (e.g. "bio", "email") */
	key: string;
	/** The innermost unwrapped Zod schema (e.g. ZodString, ZodNumber) */
	core: z.ZodTypeAny;
	/** Core type string from def.type ("string", "number", "date", etc.) */
	coreType: string;
	/** Outer wrappers ordered outermost-to-innermost */
	wrappers: ReadonlyArray<{
		type: "optional" | "nullable" | "exactOptional" | "default" | "readonly" | "catch";
	}>;
	/** Helper flags derived from wrappers */
	isOptional: boolean;
	isNullable: boolean;
}

export type FieldMiddleware = (
	schema: z.ZodTypeAny,
	ctx: FieldMiddlewareContext,
) => z.ZodTypeAny;

export interface RefineSchemaOptions {
	/**
	 * Field-level middlewares applied to every field in the resulting object schema
	 * after field refinements have been evaluated.
	 */
	middleware?: FieldMiddleware | FieldMiddleware[];
}
```

### 4.2 How the RHF Empty-String Middleware Works Under the Hood

In Zod 4, `z.preprocess(fn, schema)` wraps `schema` in a `ZodPipe` (`ZodTransform` $\rightarrow$ `schema`).
 critically, if `input` is typed as `string` on the inner schema, `z.infer<typeof schema>` (both `z.input` and `z.output` when properly typed) **remains `string | undefined` or `string | null`**—so React Hook Form's `useForm<z.infer<typeof schema>>()` still accepts `defaultValues: { bio: "" }`!

Here is the exact logic for the built-in `normalizeEmptyStrings` middleware:

```ts
import { preprocess, type z } from "zod";
import type { FieldMiddleware } from "./refine";

export interface NormalizeEmptyOptions {
	/** Trim whitespace before checking for empty string (e.g. "   " -> undefined). @default true */
	trim?: boolean;
	/** Also convert NaN (from RHF valueAsNumber on empty <input type="number">) to nullish. @default true */
	nanToNullish?: boolean;
}

/**
 * Middleware that normalizes empty HTML form values ("" and optionally NaN)
 * into `undefined` or `null` ONLY on optional/nullable fields:
 *  - If field is optional (or has a default), "" -> undefined (triggers default or skips checks)
 *  - If field is nullable (and not optional), "" -> null
 *  - If field is strictly required, "" is untouched so required/min checks fire normally.
 */
export function normalizeFormInputs(
	opts: NormalizeEmptyOptions = {},
): FieldMiddleware {
	const shouldTrim = opts.trim ?? true;
	const nanToNullish = opts.nanToNullish ?? true;

	return (fieldSchema, ctx) => {
		if (!ctx.isOptional && !ctx.isNullable) {
			return fieldSchema;
		}

		// Prefer `undefined` when optional/defaulted (so .default() or .optional() short-circuits);
		// otherwise use `null` for strictly nullable DB columns.
		const fallback = ctx.isOptional ? undefined : null;

		if (ctx.coreType === "string") {
			return preprocess((val) => {
				if (typeof val === "string") {
					const normalized = shouldTrim ? val.trim() : val;
					if (normalized === "") return fallback;
				}
				return val;
			}, fieldSchema);
		}

		if (nanToNullish && ctx.coreType === "number") {
			return preprocess((val) => {
				if (typeof val === "number" && Number.isNaN(val)) {
					return fallback;
				}
				return val;
			}, fieldSchema);
		}

		return fieldSchema;
	};
}
```

---

## 5. Developer Experience (DX) Examples

### Example 1: One-Liner React Hook Form Fix on Any Table
```ts
import { z } from "zod";
import {
	insertSchema as baseUsersInsert,
	refineSchema,
	normalizeFormInputs,
} from "virtual:drizzle-validators/users";

export const userFormSchema = refineSchema(
	baseUsersInsert,
	(f) => ({
		// DB column is: varchar("bio", { length: 500 }) (nullable & optional in insertSchema)
		// Even with .min(10), an empty "" from React Hook Form becomes `undefined` and passes!
		// If the user types "hi" (2 chars), it is not empty, so .min(10) catches it!
		bio: f.bio.min(10, { error: "Bio must be at least 10 characters if provided" }),

		// Optional email field: "" -> undefined (passes), "bad" -> fails email check
		secondaryEmail: f.secondaryEmail.as(z.email({ error: "Invalid email" })),

		// Required field: normalizeFormInputs leaves it untouched, so "" fails .min(2)
		name: f.name.min(2, { error: "Name is required" }),
	}),
	{
		middleware: normalizeFormInputs(),
	},
);
```

### Example 2: Reusable App-Wide Preset (Zero Repetition Across Forms)
If you don't want to pass `{ middleware: normalizeFormInputs() }` to every `refineSchema` call, we can expose a tiny factory `createRefineSchema(defaultOptions)` (or let `refineSchema` work with curried presets):

```ts
// src/lib/refine-form.ts
import { createRefineSchema, normalizeFormInputs } from "@vacuus/drizzle-validators/refine";

export const refineFormSchema = createRefineSchema({
	middleware: [
		normalizeFormInputs({ trim: true, nanToNullish: true }),
	],
});
```

Then in any form across your app:
```ts
import { insertSchema } from "virtual:drizzle-validators/appointments";
import { refineFormSchema } from "@/lib/refine-form";

export const appointmentFormSchema = refineFormSchema(insertSchema, (f) => ({
	notes: f.notes.min(5), // "" in RHF automatically becomes undefined!
}));
```

### Example 3: Custom User-Defined Middleware (Unlocking Other Use Cases)
Because `middleware` is just a function `(schema, ctx) => schema`, you can write custom middlewares for anything:

```ts
import type { FieldMiddleware } from "@vacuus/drizzle-validators/refine";

// Automatically trim all required and optional string columns across the table
const autoTrimStrings: FieldMiddleware = (schema, ctx) => {
	if (ctx.coreType === "string") {
		// Or attach a check/transform
	}
	return schema;
};
```

---

## 6. Critical Edge Case to Handle: Chained `refineSchema` Calls

What happens if someone runs `refineSchema` with `normalizeFormInputs()`, and then passes *that* schema into a **second** `refineSchema` call?
- If the first call wrapped `bio` in `z.preprocess(fn, ZodOptional<ZodString>)` (which is a `ZodPipe` in Zod 4, `def.type === "pipe"`), then a second `refineSchema` call inspecting `baseSchema.shape.bio` needs `unwrapAll` in `src/refine.ts` to look inside `ZodPipe` if it was created by a middleware, **or** store the middleware on the object symbol and apply it at the boundary.
- **Cleanest Solution:** Tag middleware-created `preprocess` pipes with an internal symbol (`MIDDLEWARE_PIPE_BRAND`) in `src/zod-compat.ts` so `unwrapAll` can unwrap and re-apply `preprocess` wrappers just like `optional`, `nullable`, and `default`!

---

## 7. Summary Recommendation

| Question | Answer |
| :--- | :--- |
| **Is RHF really treating `undefined` as uncontrolled?** | **Yes.** React `<input>` requires `""` to stay controlled and reset cleanly, while Zod treats `""` as a non-empty string and runs `.min()` / `.email()` checks on it. |
| **Should this be in the Vite Plugin options?** | **No.** Build-time static codegen should emit pure DDL validators (`selectSchema`, server RPCs shouldn't have DOM form preprocessors baked in, and closures can't serialize to static code). |
| **Should we use a hardcoded prop or middleware in `refineSchema`?** | **Middleware in `refineSchema` + a built-in `normalizeFormInputs()` preset.** It avoids hardcoding form opinions into the core while giving you a 1-line solution for RHF (`""` $\rightarrow$ `undefined`/`null` and `NaN` $\rightarrow$ `undefined`/`null`). |