# Final Hybrid Architecture & Implementation Plan: Declarative Error Mapping for `refineSchema`

> **Target Package:** `@vacuus/drizzle-validators` (`v0.1.32`)  
> **Target Files:** `src/constants.ts`, `src/format-names.ts` *(new)*, `src/zod-compat.ts`, `src/error-map.ts` *(new)*, `src/refine.ts`, `README.md`  
> **Supported Baseline:** `zod@^4.0.0-0` (verified across `4.0.17`, `4.4.3`, and `4.6.7`) · TypeScript `>=5.0` (verified across `5.9.3` and `7.0.2`)  
> **Status:** Final Implementation-Ready Specification  
> **Core Invariants:** C1 Non-Contamination · Tree-Shaking Purity (< 120 KB) · Inline-First Precedence · Multi-Stage Map Cascading

---

## 0. Executive Summary & Synthesis Verdict

This specification merges six competing error-mapping proposals (`refine-schema-error-mapping-plan`, `error_handling_implementation_plan`, `error-map-architecture`, `declarative-error-handling-architecture`, `hybrid-error-map-plan`, and the two Claude verification audits) into a single, conflict-free architecture grounded in `package.txt`.

### 0.1 Crucial Technical Reconciliations Across the Plans

| # | Conflict / Blind Spot in Earlier Plans | Verified Reality in `@vacuus/drizzle-validators` & Zod 4 | Final Hybrid Resolution |
| :-: | :--- | :--- | :--- |
| **1** | **Zod 4.0–4.4 vs. Zod 4.6+ Fallback Split** | In Zod $\le 4.4.3$, `core._zod.def.error` is **only** invoked for issues raised by the core schema itself; checks require their own `check._zod.def.error`. In Zod $\ge 4.6.0$, `core._zod.def.error` *also* acts as a fallback when a check's `error` returns `undefined`. | Clone checks **and** guard the core handler with `if (isCheck(issue.inst)) return undefined;` so check issues never double-fire or misdispatch on the core def in Zod 4.6+. |
| **2** | **Chained `refineSchema` Map Erasure** | With a boolean `FALLBACK` symbol (`claude-2`), a second `refineSchema(step1, map2)` overwrites the entire fallback closure from `step1`, erasing keys `map2` did not touch. Without a symbol (`hybrid`), `step1`'s fallback looks like an authored inline error and blocks `map2` completely. | Attach `[MAP_ERROR]: NormalizedMap` (`claude-1`) to every installed handler. A subsequent `refineSchema` pass merges `{ ...prevMap, ...nextMap }` per key while never overriding authored inline errors. |
| **3** | **`.as(z.email())` Loses String Keys in TypeScript** | In Zod 4, `z.email()`, `z.uuid()`, and `z.url()` return `ZodEmail`, `ZodUUID`, and `ZodURL`, which extend `z.ZodStringFormat`, **not** `z.ZodString` (`claude-2`). Furthermore, `z.ZodNativeEnum` no longer exists in Zod 4. | Match `[C] extends [z.ZodString \| z.ZodStringFormat]` (or `_zod.def.type === "string"`) and remove all references to `z.ZodNativeEnum`. |
| **4** | **`uuidv4` / `httpUrl` Dead Format Keys** | Zod 4 stores `z.uuidv4()` as `{ format: "uuid", version: "v4" }` and `z.httpUrl()` as `{ format: "url", protocol }` (Finding H2 in `zod-serializer.ts`). | Extract `resolveStringFormatName(def)` from `zod-serializer.ts` into `src/format-names.ts` (`claude-1`). All 23 `STRING_FORMAT_NAMES` work as exact keys, and `uuidv4` $\rightarrow$ `uuid` / `httpUrl` $\rightarrow$ `url` cascade as parent fallbacks. |
| **5** | **`.int()` / `z.int()` Decimal Failures** | Both `.int()` (`number_format` check) and `z.int()` emit `code: "invalid_type"` with `format: "safeint"` when given a float (`15.5`), whereas `z.int32()` range overflow emits `too_big`/`too_small`. | Dispatch on `issue.code` + `site.intCheck` / `issue.format === "safeint"`. A float (`15.5`) resolves `map.int ?? map.default` (never `map.invalid_type`), while range overflow (`3e9`) resolves `map.max ?? map.too_big ?? map.default`. |
| **6** | **Callback 2nd Argument `(fields, z)` Tree-Shaking Regression** | `hybrid-error-map-plan` proposed passing `z` as the 2nd callback argument. `tests/refine-schema.test.ts:289` and `tests/bug-repro/refine-treeshaking.test.ts` explicitly forbid this because materializing `z` pulls ~454 KB of Zod into client bundles. | Keep `refinementFn: (fields) => R` (1 argument). Update the stale example in `README.md` to match the codebase. |
| **7** | **`setErrorOnField` Array Element Bleed** | `error_handling_implementation_plan` re-added `def.element` recursion to `setErrorOnField`, which violates `tests/refine-schema.test.ts:369` (Audit 5b: array element type failures must not report the outer array's custom message). | Never recurse into `def.element` in either `setErrorOnField` or `applyErrorMapToCore`. |
| **8** | **Index Signature Destroying Typo Detection** | `refine-schema-error-mapping-plan` added `[field: string]: ...` to `SchemaErrorMap`, which silently disables TypeScript excess-property checks on misspelled field names. | `SchemaErrorMap<TShape>` is strictly `{ [K in keyof TShape]?: FieldErrorEntry<TShape[K]> }` with `NoInferShim` protecting `R`. |

---

## 1. Public API & Overload Specification

### 1.1 Function Overloads (`src/refine.ts`)

```ts
/** Blocks reverse type inference from the 3rd argument into R. */
type NoInferShim<T> = [T][T extends any ? 0 : never];

// Overload 1 (Callback first): Rules callback + optional fallback error map
export function refineSchema<
	T extends z.ZodObject<any>,
	R extends RefinementCallbackResult<T["shape"]>,
>(
	baseSchema: T,
	refinementFn: (fields: RefinableShape<T["shape"]>) => R,
	errorMap?: SchemaErrorMap<NoInferShim<RefinedShape<T["shape"], R>>>,
): z.ZodObject<RefinedShape<T["shape"], R>>;

// Overload 2 (Map only): Declarative fallback error map over the base shape
export function refineSchema<T extends z.ZodObject<any>>(
	baseSchema: T,
	errorMap: SchemaErrorMap<T["shape"]>,
): z.ZodObject<T["shape"]>;
```

#### Why Overload 1 (Callback) Comes Before Overload 2 (Map-Only)
1. **Backwards Compatibility:** Existing 2-argument `refineSchema(base, (fields) => ({ ... }))` calls resolve immediately against Overload 1 without TypeScript evaluating `SchemaErrorMap<T["shape"]>`.
2. **Table Column Collision Immunity:** Even if a Drizzle table has columns named `name` or `length` (properties that exist on `Function.prototype`), placing the function overload first guarantees a callback is never matched against `SchemaErrorMap`.
3. **Left-to-Right `R` Contextualization:** In the 3-argument call `refineSchema(base, callback, errorMap)`, TypeScript infers `R` from `callback` first, computes `RefinedShape<T["shape"], R>` (including newly added virtual fields and `.as()` type replacements), and then type-checks `errorMap` against that exact final shape. `NoInferShim` guarantees an invalid key in `errorMap` is flagged on `errorMap` rather than widening `R`.

---

### 1.2 Ergonomic Usage Patterns

```ts
import { email, string } from "zod";
import {
	insertSchema as baseUsersInsert,
	refineSchema,
} from "virtual:drizzle-validators/users";

// ── Pattern 1: Error Map Only (2 arguments) ──────────────────────────────
export const createUserSchema = refineSchema(baseUsersInsert, {
	// String shorthand -> { default: "Username is mandatory" }
	username: "Username is mandatory",

	// Granular field map (type-checked against string core)
	email: {
		required: "Corporate email is required",
		null: "Email cannot be null",
		email: "Please enter a valid email address",
		max: "Email cannot exceed 255 characters", // styles inherited varchar(255)
	},

	// Dynamic issue callbacks (typed with Zod 4 raw issue properties)
	age: {
		required: "Age is required",
		int: "Age must be a whole number",
		min: (issue) => `Minimum age is ${issue.minimum} (received ${issue.input})`,
	},

	// Enum / literal core
	role: {
		invalid_value: "Selected role is not permitted",
	},
});

// ── Pattern 2: Rules Callback + Fallback Error Map (3 arguments) ─────────
export const registerUserSchema = refineSchema(
	baseUsersInsert,
	(fields) => ({
		// Swaps core to z.email(), preserves DB wrappers + varchar(255) max check
		email: fields.email.as(email()),

		// Inline error on .min(21) -> Tier 1 (ALWAYS wins over errorMap.age.min)
		age: fields.age.min(21, { error: "VIP registration requires age 21+" }),

		// Brand-new virtual field -> immediately visible to the 3rd-arg errorMap
		confirmPassword: string().min(8),
	}),
	{
		email: {
			required: "Email is required",
			email: "Please enter a valid work email",
			max: "Email must be 255 characters or fewer",
		},
		age: {
			required: "Age is required",
			int: "Age must be an integer",
			min: "Fallback min age (ignored because inline .min(21) error wins)",
		},
		confirmPassword: {
			required: "Please confirm your password",
			min: "Password confirmation requires at least 8 characters",
		},
	},
);

// ── Pattern 3: Multi-Stage Chained Cascade ───────────────────────────────
// Layer 2 overrides `required` while preserving Layer 1's `email` and `max` messages!
export const onboardingUserSchema = refineSchema(createUserSchema, {
	email: {
		required: "We need your email to send your invite link",
	},
});
```

---

## 2. Complete Key Vocabulary & Dispatch Rules

### 2.1 Key Reference Table

Every field map supports **specific check/domain keys**, **canonical Zod 4 issue-code keys** (as coarse fallbacks), and **`default`**.

| Key | Target Issue / Check | Allowed Core Types | Resolution Priority (Specific $\rightarrow$ Coarse $\rightarrow$ Default) |
| :--- | :--- | :--- | :--- |
| `required` | `invalid_type` when `issue.input === undefined` | All cores | `required` $\rightarrow$ `invalid_type` $\rightarrow$ `default` |
| `null` | `invalid_type` when `issue.input === null` | All cores | `null` $\rightarrow$ `invalid_type` $\rightarrow$ `default` |
| `invalid_type` | `invalid_type` (wrong JS runtime type, excluding float on `.int()`) | All cores | `invalid_type` $\rightarrow$ `default` |
| `invalid_value` | `invalid_value` (`z.enum`, `z.literal`) | `enum`, `literal`, generic | `invalid_value` $\rightarrow$ `default` |
| `min` / `min_length` | `too_small` from `min_length` or `greater_than` | `string`, `number`, `bigint`, `date`, `array`, `set` | `min_length` (if string/sized) $\rightarrow$ `min` $\rightarrow$ `too_small` $\rightarrow$ `default` |
| `max` / `max_length` | `too_big` from `max_length` or `less_than` | `string`, `number`, `bigint`, `date`, `array`, `set` | `max_length` (if string/sized) $\rightarrow$ `max` $\rightarrow$ `too_big` $\rightarrow$ `default` |
| `length` | `too_small` or `too_big` from `length_equals` (`issue.exact === true`) | `string`, `array`, `set` | `length` $\rightarrow$ `too_small` / `too_big` $\rightarrow$ `default` |
| `int` | `number_format` (`safeint`) or `z.int()` given a non-integer number | `number` | `int` $\rightarrow$ `default` *(never falls back to `invalid_type`)* |
| `multiple_of` | `not_multiple_of` from `.multipleOf()` | `number`, `bigint` | `multiple_of` $\rightarrow$ `not_multiple_of` $\rightarrow$ `default` |
| `<StringFormat>` | Specific string format (`email`, `uuid`, `uuidv4`, `url`, `httpUrl`, `ipv4`, etc.) | `string` | `<canonicalFormat>` $\rightarrow$ `<parentFormat>` (`uuid`/`url`) $\rightarrow$ `format` $\rightarrow$ `invalid_format` $\rightarrow$ `default` |
| `regex`, `starts_with`, `ends_with`, `includes` | Corresponding `string_format` constraint checks | `string` | `<constraintFormat>` $\rightarrow$ `format` $\rightarrow$ `invalid_format` $\rightarrow$ `default` |
| `format` | Any `invalid_format` issue without a specific format key | `string` | `format` $\rightarrow$ `invalid_format` $\rightarrow$ `default` |
| `custom` | `.refine()` / `z.custom()` checks without an inline message | All cores | `custom` $\rightarrow$ `default` |
| `unrecognized_keys` | Strict object unknown keys (`z.strictObject`) | `object`, generic | `unrecognized_keys` $\rightarrow$ `default` |
| `invalid_union` | Union branch failure (`z.union`, `z.discriminatedUnion`) | `union`, generic | `invalid_union` $\rightarrow$ `default` |
| `default` | Catch-all for any unmapped issue on the field | All cores | `default` $\rightarrow$ Zod 4 built-in locale message |

---

### 2.2 The 5-Tier Precedence Hierarchy

```
Tier 1 (Highest): Authored Inline Error
  ├─ Check-level inline error:  fields.age.min(18, { error: "Inline" })
  ├─ Core-level inline error:   fields.email.as(z.email({ error: "Inline" }))
  └─ Field-level .setError():   fields.name.setError("Inline")
        │ (if no authored inline error on the failing check/core)
        ▼
Tier 2: Specific Check / Format Key in errorMap (Later cascade layer beats earlier layer)
  └─ e.g. `email`, `uuidv4`, `regex`, `int`, `length`, `min_length`, `min`, `max`, `required`, `null`
        │ (if undefined or function returns undefined)
        ▼
Tier 3: Parent Format / Coarse Issue-Code Key in errorMap
  └─ e.g. `uuid` (for `uuidv4`), `url` (for `httpUrl`), `format`, `invalid_format`, `too_small`, `too_big`, `not_multiple_of`, `invalid_type`
        │ (if undefined or function returns undefined)
        ▼
Tier 4: Field `default` Key or String/Function Shorthand in errorMap
  └─ e.g. `email: "Invalid email"` or `email: { default: "Invalid email" }`
        │ (if undefined or function returns undefined)
        ▼
Tier 5 (Lowest): Native Zod 4 Fallback Chain
  └─ Parse-time error map -> z.config({ customError }) -> Zod built-in locale message
```

---

## 3. Type System Architecture

### 3.1 Core-Aware Conditional Key Mapping

In Zod 4, top-level format schemas (`z.email()`, `z.uuid()`, `z.url()`, etc.) inherit from `z.ZodStringFormat`, while standard strings inherit from `z.ZodString`. Testing `[C] extends [z.ZodString | z.ZodStringFormat]` guarantees that `.as(z.email())` retains all string and format error keys.

```ts
type IssueBase = z.core.$ZodIssueBase;
type RawIssue<I extends IssueBase = z.core.$ZodIssue> = z.core.$ZodRawIssue<I>;

export type ErrorMessage<I extends IssueBase = z.core.$ZodIssue> =
	| string
	| ((issue: RawIssue<I>) => string | undefined);

type InvalidTypeIssue = z.core.$ZodIssueInvalidType;
type TooSmallIssue = z.core.$ZodIssueTooSmall;
type TooBigIssue = z.core.$ZodIssueTooBig;
type StringFormatIssue = z.core.$ZodIssueInvalidStringFormat;
type InvalidValueIssue = z.core.$ZodIssueInvalidValue;
type NotMultipleOfIssue = z.core.$ZodIssueNotMultipleOf;
type CustomIssue = z.core.$ZodIssueCustom;

export interface CommonErrorKeys {
	default?: ErrorMessage;
	required?: ErrorMessage<InvalidTypeIssue>;
	null?: ErrorMessage<InvalidTypeIssue>;
	invalid_type?: ErrorMessage<InvalidTypeIssue>;
	custom?: ErrorMessage<CustomIssue>;
}

export interface BoundErrorKeys {
	min?: ErrorMessage<TooSmallIssue>;
	max?: ErrorMessage<TooBigIssue>;
	too_small?: ErrorMessage<TooSmallIssue>;
	too_big?: ErrorMessage<TooBigIssue>;
}

export interface SizedBoundErrorKeys extends BoundErrorKeys {
	min_length?: ErrorMessage<TooSmallIssue>;
	max_length?: ErrorMessage<TooBigIssue>;
	length?: ErrorMessage<TooSmallIssue | TooBigIssue>;
}

export type StringFormatErrorKeys = {
	[K in StringFormat]?: ErrorMessage<StringFormatIssue>;
};

export interface StringErrorKeys
	extends CommonErrorKeys,
		SizedBoundErrorKeys,
		StringFormatErrorKeys {
	format?: ErrorMessage<StringFormatIssue>;
	invalid_format?: ErrorMessage<StringFormatIssue>;
	regex?: ErrorMessage<StringFormatIssue>;
	starts_with?: ErrorMessage<StringFormatIssue>;
	ends_with?: ErrorMessage<StringFormatIssue>;
	includes?: ErrorMessage<StringFormatIssue>;
}

export interface NumberErrorKeys extends CommonErrorKeys, BoundErrorKeys {
	int?: ErrorMessage<InvalidTypeIssue | TooSmallIssue | TooBigIssue>;
	multiple_of?: ErrorMessage<NotMultipleOfIssue>;
	not_multiple_of?: ErrorMessage<NotMultipleOfIssue>;
}

export interface BigIntErrorKeys extends CommonErrorKeys, BoundErrorKeys {
	multiple_of?: ErrorMessage<NotMultipleOfIssue>;
	not_multiple_of?: ErrorMessage<NotMultipleOfIssue>;
}

export interface DateErrorKeys extends CommonErrorKeys, BoundErrorKeys {}

export interface SizedContainerErrorKeys
	extends CommonErrorKeys,
		SizedBoundErrorKeys {}

export interface ChoiceErrorKeys extends CommonErrorKeys {
	invalid_value?: ErrorMessage<InvalidValueIssue>;
}

export interface ObjectErrorKeys extends CommonErrorKeys {
	unrecognized_keys?: ErrorMessage;
}

export interface GenericErrorKeys extends CommonErrorKeys {
	invalid_value?: ErrorMessage<InvalidValueIssue>;
	invalid_union?: ErrorMessage;
	unrecognized_keys?: ErrorMessage;
}

export type FieldErrorMapForCore<TCore> = [TCore] extends [
	z.ZodString | z.ZodStringFormat,
]
	? StringErrorKeys
	: [TCore] extends [z.ZodNumber]
		? NumberErrorKeys
		: [TCore] extends [z.ZodBigInt]
			? BigIntErrorKeys
			: [TCore] extends [z.ZodDate]
				? DateErrorKeys
				: [TCore] extends [z.ZodBoolean]
					? CommonErrorKeys
					: [TCore] extends [z.ZodArray<any> | z.ZodSet<any>]
						? SizedContainerErrorKeys
						: [TCore] extends [z.ZodEnum<any> | z.ZodLiteral<any>]
							? ChoiceErrorKeys
							: [TCore] extends [z.ZodObject<any>]
								? ObjectErrorKeys
								: GenericErrorKeys;

export type FieldErrorMap = StringErrorKeys &
	NumberErrorKeys &
	ChoiceErrorKeys &
	ObjectErrorKeys &
	GenericErrorKeys;

export type FieldErrorEntry<TField extends z.ZodTypeAny> =
	| ErrorMessage
	| FieldErrorMapForCore<DeepUnwrap<TField>>;

export type SchemaErrorMap<TShape extends Record<string, z.ZodTypeAny>> = {
	[K in keyof TShape]?: FieldErrorEntry<TShape[K]>;
};
```

---

## 4. Exact File-by-File Implementation

### 4.1 `packages/drizzle-validators/src/constants.ts`

Add `export type StringFormat` directly alongside `STRING_FORMAT_NAMES`:

```ts
export const RESOLVED_PREFIX = "\0";

/**
 * Single source of truth for every string format supported by the plugin.
 *
 * `KNOWN_FORMATS` (serializer) and `StringFormat` (refine.ts / error-map.ts)
 * are both derived from this tuple, so the lists can never drift apart (finding M6).
 */
export const STRING_FORMAT_NAMES = [
	"email",
	"url",
	"httpUrl",
	"uuid",
	"uuidv4",
	"uuidv6",
	"uuidv7",
	"guid",
	"cuid",
	"cuid2",
	"ulid",
	"emoji",
	"nanoid",
	"jwt",
	"ipv4",
	"ipv6",
	"cidrv4",
	"cidrv6",
	"base64",
	"base64url",
	"xid",
	"ksuid",
	"e164",
] as const;

export type StringFormat = (typeof STRING_FORMAT_NAMES)[number];

export const KNOWN_FORMATS = new Set<string>(STRING_FORMAT_NAMES);

export const MAX_RECURSION_DEPTH = 100;
```

---

### 4.2 `packages/drizzle-validators/src/format-names.ts` *(New File)*

Extract `resolveStringFormatName` out of `zod-serializer.ts` so `error-map.ts` and `zod-serializer.ts` share it without `refine.ts` importing `zod-serializer.ts` (which imports runtime `url` from `zod`):

```ts
/**
 * Resolves the canonical builder name for a Zod 4 string format definition.
 *
 * Zod 4 collapses several builders onto shared def formats:
 *   - `z.uuidv4()` -> `{ format: "uuid", version: "v4" }`
 *   - `z.httpUrl()` -> `{ format: "url", protocol, hostname }`
 */
export function resolveStringFormatName(def: Record<string, any>): string | undefined {
	if (def.format === "uuid") {
		if (def.version === "v4") return "uuidv4";
		if (def.version === "v6") return "uuidv6";
		if (def.version === "v7") return "uuidv7";
		return "uuid";
	}
	if (def.format === "url") {
		if (def.protocol) return "httpUrl";
		return "url";
	}
	return typeof def.format === "string" ? def.format : undefined;
}
```

In `packages/drizzle-validators/src/zod-serializer.ts`, replace the local `function resolveStringFormatName` declaration with:

```ts
import { resolveStringFormatName } from "./format-names";
```

---

### 4.3 `packages/drizzle-validators/src/zod-compat.ts`

Widen `cloneZodCheck` to accept either a `string` or an error callback function `(issue: Record<string, any>) => string | undefined`, passing functions through directly so symbol metadata (`[MAP_ERROR]`) is preserved on the function reference:

```ts
export type ZodErrorOverride =
	| string
	| ((issue: Record<string, any>) => string | undefined);

export function cloneZodCheck(
	check: unknown,
	errorOverride?: ZodErrorOverride,
): z.ZodTypeAny {
	const checkDef = getZodDef(check);
	if (!checkDef) {
		throw new DrizzleValidatorsError(
			"Cannot clone a malformed Zod check without a definition.",
		);
	}
	const nextDef = { ...checkDef };
	if (errorOverride !== undefined) {
		nextDef.error =
			typeof errorOverride === "function"
				? errorOverride
				: () => errorOverride;
	}
	return new (getZodConstructor(check, "check cloning"))(nextDef);
}
```

---

### 4.4 `packages/drizzle-validators/src/error-map.ts` *(New File)*

Contains the public error-map types, key validation, cascade merging, and check/core handler installation. Uses only `import type { z } from "zod"` for zero Zod bundle overhead:

```ts
import type { z } from "zod";
import { STRING_FORMAT_NAMES, type StringFormat } from "./constants";
import { DrizzleValidatorsError } from "./errors";
import { resolveStringFormatName } from "./format-names";
import {
	cloneSchemaWithDef,
	cloneZodCheck,
	getZodDef,
	type InternalZodDef,
} from "./zod-compat";

// ───────────────────────── Public Types ─────────────────────────

type IssueBase = z.core.$ZodIssueBase;
type RawIssue<I extends IssueBase = z.core.$ZodIssue> = z.core.$ZodRawIssue<I>;

export type ErrorMessage<I extends IssueBase = z.core.$ZodIssue> =
	| string
	| ((issue: RawIssue<I>) => string | undefined);

type InvalidTypeIssue = z.core.$ZodIssueInvalidType;
type TooSmallIssue = z.core.$ZodIssueTooSmall;
type TooBigIssue = z.core.$ZodIssueTooBig;
type StringFormatIssue = z.core.$ZodIssueInvalidStringFormat;
type InvalidValueIssue = z.core.$ZodIssueInvalidValue;
type NotMultipleOfIssue = z.core.$ZodIssueNotMultipleOf;
type CustomIssue = z.core.$ZodIssueCustom;

export interface CommonErrorKeys {
	default?: ErrorMessage;
	required?: ErrorMessage<InvalidTypeIssue>;
	null?: ErrorMessage<InvalidTypeIssue>;
	invalid_type?: ErrorMessage<InvalidTypeIssue>;
	custom?: ErrorMessage<CustomIssue>;
}

export interface BoundErrorKeys {
	min?: ErrorMessage<TooSmallIssue>;
	max?: ErrorMessage<TooBigIssue>;
	too_small?: ErrorMessage<TooSmallIssue>;
	too_big?: ErrorMessage<TooBigIssue>;
}

export interface SizedBoundErrorKeys extends BoundErrorKeys {
	min_length?: ErrorMessage<TooSmallIssue>;
	max_length?: ErrorMessage<TooBigIssue>;
	length?: ErrorMessage<TooSmallIssue | TooBigIssue>;
}

export type StringFormatErrorKeys = {
	[K in StringFormat]?: ErrorMessage<StringFormatIssue>;
};

export interface StringErrorKeys
	extends CommonErrorKeys,
		SizedBoundErrorKeys,
		StringFormatErrorKeys {
	format?: ErrorMessage<StringFormatIssue>;
	invalid_format?: ErrorMessage<StringFormatIssue>;
	regex?: ErrorMessage<StringFormatIssue>;
	starts_with?: ErrorMessage<StringFormatIssue>;
	ends_with?: ErrorMessage<StringFormatIssue>;
	includes?: ErrorMessage<StringFormatIssue>;
}

export interface NumberErrorKeys extends CommonErrorKeys, BoundErrorKeys {
	int?: ErrorMessage<InvalidTypeIssue | TooSmallIssue | TooBigIssue>;
	multiple_of?: ErrorMessage<NotMultipleOfIssue>;
	not_multiple_of?: ErrorMessage<NotMultipleOfIssue>;
}

export interface BigIntErrorKeys extends CommonErrorKeys, BoundErrorKeys {
	multiple_of?: ErrorMessage<NotMultipleOfIssue>;
	not_multiple_of?: ErrorMessage<NotMultipleOfIssue>;
}

export interface DateErrorKeys extends CommonErrorKeys, BoundErrorKeys {}

export interface SizedContainerErrorKeys
	extends CommonErrorKeys,
		SizedBoundErrorKeys {}

export interface ChoiceErrorKeys extends CommonErrorKeys {
	invalid_value?: ErrorMessage<InvalidValueIssue>;
}

export interface ObjectErrorKeys extends CommonErrorKeys {
	unrecognized_keys?: ErrorMessage;
}

export interface GenericErrorKeys extends CommonErrorKeys {
	invalid_value?: ErrorMessage<InvalidValueIssue>;
	invalid_union?: ErrorMessage;
	unrecognized_keys?: ErrorMessage;
}

export type FieldErrorMap = StringErrorKeys &
	NumberErrorKeys &
	ChoiceErrorKeys &
	ObjectErrorKeys &
	GenericErrorKeys;

// ───────────────────────── Runtime Engine ─────────────────────────

/**
 * Symbol attached to every fallback error function installed by `error-map.ts`.
 * Stores the frozen NormalizedMap so:
 *  1. `isAuthored(def)` can distinguish user-authored inline errors from fallback maps.
 *  2. Multi-stage `refineSchema` calls can cascade `{ ...prevMap, ...nextMap }` per key.
 */
export const MAP_ERROR = Symbol.for("drizzle-validators.error-map");

export type NormalizedMap = Readonly<Record<string, ErrorMessage<any> | undefined>>;

type FallbackHandler = ((issue: Record<string, any>) => string | undefined) & {
	[MAP_ERROR]?: NormalizedMap;
};

const VALID_MAP_KEYS: ReadonlySet<string> = new Set<string>([
	"default",
	"required",
	"null",
	"invalid_type",
	"invalid_value",
	"min",
	"max",
	"min_length",
	"max_length",
	"length",
	"too_small",
	"too_big",
	"int",
	"multiple_of",
	"not_multiple_of",
	"format",
	"invalid_format",
	"regex",
	"starts_with",
	"ends_with",
	"includes",
	"custom",
	"unrecognized_keys",
	"invalid_union",
	...STRING_FORMAT_NAMES,
]);

const SPECIFIC_FORMAT_KEYS: ReadonlySet<string> = new Set<string>([
	"regex",
	"starts_with",
	"ends_with",
	"includes",
	...STRING_FORMAT_NAMES,
]);

/** Parent format fallback when a versioned/protocol format key is not explicitly set. */
const FORMAT_PARENT: Readonly<Record<string, string>> = {
	uuidv4: "uuid",
	uuidv6: "uuid",
	uuidv7: "uuid",
	httpUrl: "url",
};

/** Keys that only ever fire on the core schema def, never on an attached check. */
const CORE_ONLY_KEYS: ReadonlySet<string> = new Set<string>([
	"required",
	"null",
	"invalid_type",
	"invalid_value",
	"unrecognized_keys",
	"invalid_union",
]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Object.prototype.toString.call(value) === "[object Object]";
}

export function normalizeEntry(entry: unknown, field: string): NormalizedMap {
	if (typeof entry === "string" || typeof entry === "function") {
		return Object.freeze({ default: entry as ErrorMessage<any> });
	}
	if (!isPlainObject(entry)) {
		throw new DrizzleValidatorsError(
			`Invalid error map entry for field "${field}": expected a string, a function, or a plain object of messages.`,
		);
	}
	const out: Record<string, ErrorMessage<any>> = {};
	for (const [key, value] of Object.entries(entry)) {
		if (value === undefined) continue;
		if (!VALID_MAP_KEYS.has(key)) {
			throw new DrizzleValidatorsError(
				`Unknown error map key "${key}" on field "${field}".`,
			);
		}
		if (typeof value !== "string" && typeof value !== "function") {
			throw new DrizzleValidatorsError(
				`Error map entry "${field}.${key}" must be a string or a function, received ${typeof value}.`,
			);
		}
		out[key] = value as ErrorMessage<any>;
	}
	return Object.freeze(out);
}

function mapOf(errorFn: unknown): NormalizedMap | undefined {
	return typeof errorFn === "function"
		? (errorFn as FallbackHandler)[MAP_ERROR]
		: undefined;
}

/** True when `def` carries an explicit user-authored error (inline or `.setError()`). */
export function isAuthoredError(def: InternalZodDef): boolean {
	if (typeof def.error === "function") return mapOf(def.error) === undefined;
	return typeof def.error === "string" || typeof def.message === "string";
}

function cascadeMaps(
	prev: NormalizedMap | undefined,
	next: NormalizedMap,
): NormalizedMap {
	return prev ? Object.freeze({ ...prev, ...next }) : next;
}

/** True when `inst` is a Zod check instance rather than a schema node. */
function isCheckInstance(inst: unknown): boolean {
	const d = getZodDef(inst);
	return Boolean(d && typeof d.check === "string" && d.type === undefined);
}

interface SiteMeta {
	readonly isCheck: boolean;
	readonly intCheck: boolean;
	readonly sizedOrigin: boolean;
	readonly formatName: string | undefined;
}

function siteOf(def: InternalZodDef, isCheck: boolean): SiteMeta {
	const isStringFormat =
		def.check === "string_format" ||
		(def.type === "string" && typeof def.format === "string");
	const intCheck =
		(def.check === "number_format" || def.type === "number") &&
		/int/i.test(String(def.format ?? ""));
	const sizedOrigin =
		def.check === "min_length" ||
		def.check === "max_length" ||
		def.check === "length_equals" ||
		def.type === "string" ||
		def.type === "array" ||
		def.type === "set";
	return {
		isCheck,
		intCheck,
		sizedOrigin,
		formatName: isStringFormat ? resolveStringFormatName(def) : undefined,
	};
}

function candidateKeys(
	issue: Record<string, any>,
	site: SiteMeta,
): string[] {
	// Non-integer numbers on .int() or z.int() emit code: "invalid_type" with format: "safeint"
	if (
		(site.intCheck || issue.format === "safeint") &&
		typeof issue.input === "number" &&
		(issue.code === "invalid_type" || issue.code === "invalid_format")
	) {
		return ["int"];
	}

	switch (issue.code) {
		case "invalid_type":
			if (issue.input === undefined) return ["required", "invalid_type"];
			if (issue.input === null) return ["null", "invalid_type"];
			return ["invalid_type"];

		case "invalid_value":
			return ["invalid_value"];

		case "too_small":
			if (issue.exact) return ["length", "too_small"];
			return site.sizedOrigin || issue.origin === "string" || issue.origin === "array" || issue.origin === "set"
				? ["min_length", "min", "too_small"]
				: ["min", "too_small"];

		case "too_big":
			if (issue.exact) return ["length", "too_big"];
			return site.sizedOrigin || issue.origin === "string" || issue.origin === "array" || issue.origin === "set"
				? ["max_length", "max", "too_big"]
				: ["max", "too_big"];

		case "not_multiple_of":
			return ["multiple_of", "not_multiple_of"];

		case "custom":
			return ["custom"];

		case "invalid_format": {
			const rawFormat = site.formatName ?? String(issue.format ?? "");
			const keys: string[] = [];
			if (SPECIFIC_FORMAT_KEYS.has(rawFormat)) {
				keys.push(rawFormat);
				const parent = FORMAT_PARENT[rawFormat];
				if (parent) keys.push(parent);
			}
			keys.push("format", "invalid_format");
			return keys;
		}

		case "unrecognized_keys":
			return ["unrecognized_keys"];

		case "invalid_union":
			return ["invalid_union"];

		default:
			return [];
	}
}

function evaluateCandidates(
	map: NormalizedMap,
	keys: string[],
	issue: Record<string, any>,
): string | undefined {
	for (const key of [...keys, "default"]) {
		const entry = map[key];
		if (entry === undefined) continue;
		const resolved = typeof entry === "function" ? entry(issue as any) : entry;
		if (resolved !== undefined) return resolved;
	}
	return undefined;
}

function makeFallbackHandler(map: NormalizedMap, site: SiteMeta): FallbackHandler {
	const handler: FallbackHandler = (issue: Record<string, any>) => {
		// In Zod 4.6+, core def.error is also invoked as a fallback for check issues.
		// Check issues are already handled by their own check-level handler; if a check
		// had an authored error or intentionally fell through to Zod's native message,
		// the core handler must not intercept it.
		if (!site.isCheck && isCheckInstance(issue.inst)) {
			return undefined;
		}
		const keys = candidateKeys(issue, site);
		return evaluateCandidates(map, keys, issue);
	};
	Object.defineProperty(handler, MAP_ERROR, {
		value: map,
		enumerable: false,
		configurable: false,
	});
	return handler;
}

function touchesChecks(map: NormalizedMap): boolean {
	for (const key of Object.keys(map)) {
		if (!CORE_ONLY_KEYS.has(key)) return true;
	}
	return false;
}

/**
 * Applies a normalized field error map to an unwrapped core Zod schema.
 * Purely clone-based (C1 invariant): never mutates `core` or its `checks`.
 */
export function applyErrorMapToCore(
	core: z.ZodTypeAny,
	entry: NormalizedMap,
): z.ZodTypeAny {
	if (Object.keys(entry).length === 0) return core;
	const def = getZodDef(core);
	if (!def) return core;

	const overrides: Record<string, unknown> = {};

	if (Array.isArray(def.checks) && touchesChecks(entry)) {
		let checksChanged = false;
		const nextChecks = def.checks.map((check: unknown) => {
			const checkDef = getZodDef(check);
			if (
				!checkDef ||
				checkDef.check === "overwrite" ||
				isAuthoredError(checkDef)
			) {
				return check;
			}
			const merged = cascadeMaps(mapOf(checkDef.error), entry);
			checksChanged = true;
			return cloneZodCheck(
				check,
				makeFallbackHandler(merged, siteOf(checkDef, true)),
			);
		});
		if (checksChanged) overrides.checks = nextChecks;
	}

	if (!isAuthoredError(def)) {
		const merged = cascadeMaps(mapOf(def.error), entry);
		overrides.error = makeFallbackHandler(merged, siteOf(def, false));
	}

	return Object.keys(overrides).length > 0
		? cloneSchemaWithDef(core, overrides, "error map application")
		: core;
}
```

---

### 4.5 `packages/drizzle-validators/src/refine.ts`

Wire the new types, overloads, and post-callback error-map pass into `src/refine.ts`:

```ts
import type { z } from "zod";
import type { StringFormat } from "./constants";
import { DrizzleValidatorsError } from "./errors";
import {
	applyErrorMapToCore,
	isPlainObject,
	normalizeEntry,
	type ErrorMessage,
	type FieldErrorMap,
	type FieldErrorMapForCore,
} from "./error-map";
import {
	cloneSchemaWithDef,
	cloneZodCheck,
	getZodConstructor,
	getZodDef,
	hasLazyDefaultGetter,
	isExactOptionalSchema,
	isZodSchema,
	rebuildZodObject,
	UNWRAP_PROXY,
} from "./zod-compat";

export { UNWRAP_PROXY };
export type {
	ErrorMessage,
	FieldErrorMap,
	FieldErrorMapForCore,
} from "./error-map";
export type { StringFormat } from "./constants";

// ... [existing REFINED_FIELD_BRAND, AsOptions, WrapperDef, unwrapAll, applyWrappers, transferChecks, setErrorOnField unchanged] ...

export type DeepUnwrap<T extends z.ZodTypeAny> =
	T extends z.ZodOptional<infer Inner extends z.ZodTypeAny>
		? DeepUnwrap<Inner>
		: T extends z.ZodNullable<infer Inner extends z.ZodTypeAny>
			? DeepUnwrap<Inner>
			: T extends z.ZodDefault<infer Inner extends z.ZodTypeAny>
				? DeepUnwrap<Inner>
				: T extends z.ZodCatch<infer Inner extends z.ZodTypeAny>
					? DeepUnwrap<Inner>
					: T extends z.ZodReadonly<infer Inner extends z.ZodTypeAny>
						? DeepUnwrap<Inner>
						: T;

// ... [existing PreserveWrapper, RemoveOptional, RemoveNullable, RefinedField, RefinableShape, RefinementCallbackResult, ResolveRefinedField unchanged] ...

type NoInferShim<T> = [T][T extends any ? 0 : never];

export type RefinedShape<
	TShape extends Record<string, z.ZodTypeAny>,
	R extends RefinementCallbackResult<TShape>,
> = Omit<TShape, keyof R> & {
	[K in keyof R]: K extends keyof TShape
		? ResolveRefinedField<TShape[K], R[K]>
		: R[K] extends z.ZodTypeAny
			? R[K]
			: never;
};

export type FieldErrorEntry<TField extends z.ZodTypeAny> =
	| ErrorMessage
	| FieldErrorMapForCore<DeepUnwrap<TField>>;

export type SchemaErrorMap<TShape extends Record<string, z.ZodTypeAny>> = {
	[K in keyof TShape]?: FieldErrorEntry<TShape[K]>;
};

function applyErrorMapToShape(
	shape: Record<string, z.ZodTypeAny>,
	errorMap: Record<string, unknown>,
): void {
	for (const [key, entry] of Object.entries(errorMap)) {
		if (entry === undefined) continue;
		const field = Object.hasOwn(shape, key) ? shape[key] : undefined;
		if (!field) {
			throw new DrizzleValidatorsError(
				`Cannot apply an error map to unknown field "${key}". Known fields: ${Object.keys(shape).join(", ")}.`,
			);
		}
		const normalized = normalizeEntry(entry, key);
		if (Object.keys(normalized).length === 0) continue;
		const { core, wrappers } = unwrapAll(field);
		const nextCore = applyErrorMapToCore(core, normalized);
		if (nextCore !== core) {
			shape[key] = applyWrappers(nextCore, wrappers);
		}
	}
}

/**
 * Refines a Zod object with custom field rules, wrapper-preserving `.as()` swaps,
 * and/or a declarative fallback `errorMap`.
 */
export function refineSchema<
	T extends z.ZodObject<any>,
	R extends RefinementCallbackResult<T["shape"]>,
>(
	baseSchema: T,
	refinementFn: (fields: RefinableShape<T["shape"]>) => R,
	errorMap?: SchemaErrorMap<NoInferShim<RefinedShape<T["shape"], R>>>,
): z.ZodObject<RefinedShape<T["shape"], R>>;

export function refineSchema<T extends z.ZodObject<any>>(
	baseSchema: T,
	errorMap: SchemaErrorMap<T["shape"]>,
): z.ZodObject<T["shape"]>;

export function refineSchema(
	baseSchema: z.ZodObject<any>,
	second: unknown,
	third?: unknown,
): z.ZodObject<any> {
	const nextShape: Record<string, z.ZodTypeAny> = { ...baseSchema.shape };
	let errorMap: unknown;

	if (typeof second === "function") {
		const result = (second as (fields: unknown) => unknown)(
			createLazyShapeProxy(baseSchema.shape),
		);
		if (!result || typeof result !== "object" || Array.isArray(result)) {
			throw new DrizzleValidatorsError(
				"refineSchema callback must return an object mapping field names to schemas.",
			);
		}
		for (const [key, value] of Object.entries(result)) {
			if (value === undefined) continue;
			const schema = unwrapProxy(value);
			if (!isZodSchema(schema)) {
				throw new DrizzleValidatorsError(
					`Invalid refinement for field "${key}": expected a Zod schema instance, received ${typeof value}.`,
				);
			}
			nextShape[key] = schema;
		}
		errorMap = third;
	} else if (isPlainObject(second)) {
		if (third !== undefined) {
			throw new DrizzleValidatorsError(
				"refineSchema: the refinement callback must come before the error map: refineSchema(schema, callback, errorMap).",
			);
		}
		errorMap = second;
	} else {
		throw new DrizzleValidatorsError(
			"refineSchema expects a refinement callback function or an error map object as its second argument.",
		);
	}

	if (errorMap !== undefined) {
		if (!isPlainObject(errorMap)) {
			throw new DrizzleValidatorsError(
				"refineSchema errorMap must be a plain object mapping field names to error messages.",
			);
		}
		applyErrorMapToShape(nextShape, errorMap);
	}

	return rebuildZodObject(baseSchema, nextShape);
}
```

---

## 5. Edge Cases & Defensive Guarantees

| # | Scenario | Guaranteed Behavior |
| :-: | :--- | :--- |
| 1 | **Unknown field in `errorMap`** | Compile-time TypeScript error + runtime `DrizzleValidatorsError` listing all known fields on the post-callback shape. |
| 2 | **Unknown key inside a field's map** | Compile-time TypeScript error + runtime `DrizzleValidatorsError` naming `field.key`. |
| 3 | **Reversed arguments `(schema, map, fn)`** | Throws `DrizzleValidatorsError` instructing `(schema, callback, errorMap)` order. |
| 4 | **`undefined` field or key value in map** | Treated as absent (no-op). |
| 5 | **Empty string `""` message** | Preserved as a valid explicit empty message. |
| 6 | **Empty map `{}` or `{ email: {} }`** | Fast-path no-op: field core is not cloned, preserving reference identity and metadata. |
| 7 | **Presence-only map (`{ required, null, invalid_type }`)** | `touchesChecks(map)` returns `false`; `def.checks` array is not cloned at all. |
| 8 | **`.trim()` / `.toLowerCase()` (`overwrite` checks)** | Skipped during check cloning (`checkDef.check === "overwrite"` raises no validation issues). |
| 9 | **Decimal passed to `.int()` or `z.int()` (`15.5`)** | Emits `map.int ?? map.default`. Never triggers `map.invalid_type`, even though Zod's raw issue code is `"invalid_type"` with `format: "safeint"`. |
| 10 | **`z.int32()` / Drizzle integer range overflow** | Emits `map.max ?? map.too_big ?? map.default` (or `min`/`too_small`), never `map.int`. |
| 11 | **Inline check error + map on same field** | `f.age.min(18, { error: "Inline" }).max(100)` with `{ age: { min: "Map min", max: "Map max" } }` reports `"Inline"` on `15` and `"Map max"` on `120`. |
| 12 | **`.setError("X")` in callback + map** | `.setError("X")` stamps authored functions on the core and all checks; `isAuthoredError` returns `true` everywhere and the map is completely skipped for that field. |
| 13 | **`z.email({ error: "Inline" })` root format** | Core `def.error` is authored, so `"Inline"` wins for core issues; any inherited Drizzle `max_length(255)` check on the field is still styled by `map.max`. |
| 14 | **Multi-stage `refineSchema` cascade** | Layer 2's map merges `{ ...prevMap, ...nextMap }` over Layer 1's `[MAP_ERROR]` handler. Keys not mentioned in Layer 2 survive from Layer 1; authored inline errors from Layer 1 remain untouchable. |
| 15 | **Optional / Nullable / Default / Catch / Readonly wrappers** | Peeled via `unwrapAll`, core is cloned with fallback handlers, and wrappers (including lazy `.default(() => ...)` getters) are restored via `applyWrappers`. |
| 16 | **Array fields (`z.array(z.string())`)** | Map styles the outer array container (`required`, `min`, `max`, `length`). Inner element schemas are **never** recursed into (preserving Audit 5b). |
| 17 | **Strict / Loose / Catchall / Described objects** | Rebuilt via `rebuildZodObject`, preserving `strictObject`, `looseObject`, `.catchall()`, object-level checks, and `.describe()`. |
| 18 | **Dynamic callback returning `undefined`** | Falls through to the next candidate in the resolution chain (`specific -> coarse -> default -> Zod native`). |
| 19 | **Caller mutates the `errorMap` literal after calling `refineSchema`** | `normalizeEntry` copies and `Object.freeze`s every field map at construction time; subsequent external mutation has zero effect. |

---

## 6. Verification & Test Suite Specification

### 6.1 Runtime Suite (`packages/drizzle-validators/tests/refine-error-map.test.ts`)

1. **Map-Only Overload (2-arg):**
   * String shorthand (`name: "Invalid name"`) styles `undefined`, `null`, wrong type, and failed checks.
   * Function shorthand (`name: (iss) => ...`) receives raw issue with `input` and `code`.
   * Presence chain: `required` (on `undefined`), `null` (on `null`), `invalid_type` (on wrong type), and fallback from `required`/`null` to `invalid_type` when `required`/`null` are omitted.
   * String checks: `min_length` > `min` > `too_small` > `default`; `max_length` > `max` > `too_big` > `default`; `length` on `.length(5)` for both too-short and too-long strings.
   * Format checks: `email` > `format` > `invalid_format` > `default` on both `z.string().email()` and root `z.email()`.
   * Versioned/protocol formats: `z.uuidv4()` matches `uuidv4`, falls back to `uuid`, then `format`; `z.httpUrl()` matches `httpUrl`, falls back to `url`, then `format`.
   * Pattern checks: `regex`, `starts_with`, `ends_with`, `includes`.
   * Numeric checks: `int` on `.int()` and `z.int()` with `15.5`; verify `15.5` does **not** use `invalid_type` when `int` is omitted. Verify `z.int().gte(-2147483648).lte(2147483647)` uses `min`/`max` on out-of-range integers.
   * `multiple_of` and `not_multiple_of` on `.multipleOf(5)`.
   * `invalid_value` on `z.enum(["a", "b"])` and `z.literal("a")`.
   * `custom` on `.refine((v) => v !== "bad")` without an inline message.
2. **Callback + Map Overload (3-arg) & Precedence:**
   * Callback adds virtual field `confirmPassword: z.string().min(8)` and map styles `confirmPassword.required` and `confirmPassword.min`.
   * Callback swaps type `email: f.email.as(z.email())` on `z.string().max(120)` and map styles `required`, `email`, and the transferred `max(120)` check.
   * Inline check error `f.age.min(18, { error: "Inline 18+" })` beats `errorMap.age.min`, while `errorMap.age.required` still styles `undefined`.
   * `.setError("Field override")` beats all keys in `errorMap` for that field.
3. **Multi-Stage Cascade & Idempotence:**
   * `step1 = refineSchema(base, { email: { required: "R1", email: "E1" } })` followed by `step2 = refineSchema(step1, { email: { required: "R2" } })` produces `"R2"` for `undefined` and `"E1"` for `"not-an-email"`.
   * `step1` remains unmutated and still reports `"R1"`.
4. **C1 Non-Contamination & Wrappers:**
   * Two mapped schemas from the same `baseSchema` never leak messages into each other or `baseSchema`.
   * `optional()`, `exactOptional()`, `nullable()`, `default()`, `default(() => ...)`, `catch()`, and `readonly()` wrappers behave identically before and after mapping.
   * Array field map styles `.min(1)` on `z.array(z.string()).min(1)` without altering element-level error messages on `[123 as any]`.
5. **Fail-Loud Validation:**
   * Unknown field name in `errorMap` throws `DrizzleValidatorsError` listing known fields.
   * Unknown key in field map throws `DrizzleValidatorsError`.
   * Reversed arguments `refineSchema(base, map, callback)` throws `DrizzleValidatorsError`.

### 6.2 Compile-Time Type Suite (`packages/drizzle-validators/tests/refine-error-map-types.test.ts`)

Checked via `bun run typecheck` (`tsc --noEmit`):
* `@ts-expect-error` on unknown field key in 2-arg and 3-arg calls.
* `@ts-expect-error` on `int` key applied to a `z.string()` field.
* `@ts-expect-error` on `email` key applied to a `z.number()` field.
* `@ts-expect-error` on `min` key applied to a `z.enum(["a", "b"])` field.
* Positive check: `.as(z.email())` allows `email`, `format`, `min`, `max`, `required`.
* Positive check: callback-added field `confirmPassword: z.string()` is accepted in the 3rd-arg map.
* Positive check: callback type swap `code: f.code.as(z.number())` switches allowed map keys from string keys to number keys (`int`, `multiple_of`), and `@ts-expect-error` rejects `regex` on `code`.
* Positive check: table with columns named `name` and `length` resolves the 2-arg callback overload cleanly.

---

## 7. Phased Rollout Sequence

1. **Phase 1 — Foundation (`src/constants.ts`, `src/format-names.ts`, `src/zod-serializer.ts`, `src/zod-compat.ts`):**
   * Export `StringFormat` from `src/constants.ts`.
   * Create `src/format-names.ts` with `resolveStringFormatName` and import it in `src/zod-serializer.ts`.
   * Update `cloneZodCheck` in `src/zod-compat.ts` to accept callback functions.
   * Run `bun test` to verify zero regressions on existing suites.
2. **Phase 2 — Error Map Engine & Overloads (`src/error-map.ts`, `src/refine.ts`):**
   * Create `src/error-map.ts` with the type definitions and `applyErrorMapToCore`.
   * Update `src/refine.ts` with `RefinedShape`, `SchemaErrorMap`, the 2 overloads, and `applyErrorMapToShape`.
3. **Phase 3 — Tests, Tree-Shaking Guard & Documentation (`tests/`, `README.md`):**
   * Add `tests/refine-error-map.test.ts` and `tests/refine-error-map-types.test.ts`.
   * Extend `tests/bug-repro/refine-treeshaking.test.ts` to assert that bundling `refineSchema` with an `errorMap` remains locale-free and under the size budget.
   * Update `README.md` to fix `(fields, z)` $\rightarrow$ `(fields)` and document the declarative `errorMap` API.
   * Run `bun run test`, `bun run typecheck`, and `bun run build`.