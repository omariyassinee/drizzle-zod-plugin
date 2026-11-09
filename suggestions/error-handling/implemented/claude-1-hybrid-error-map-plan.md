# Final Plan — Declarative Error Mapping for `refineSchema`

> **Package:** `@vacuus/drizzle-validators` v0.1.32 · **Zod:** dev `^4.4.3`, peer `^4.0.0-0`
> **Supersedes:** `hybrid-error-map-plan.md` (and the four plans it merged)
> **Status:** Final. Implementable as written once the Phase 0 probes (§9) confirm the Zod 4 assumptions (§3.5).

---

## 0. Verdict

The hybrid got the **shape** right and I keep it: `refineSchema(schema, errorMap)` + `refineSchema(schema, callback, errorMap?)`, per-core key restriction, clone-only application, inline errors always win.

Checked against the real package, though, it has defects that would reintroduce a regression the repo already fixed, ship keys that can never match, or not work as specified (§1). This plan fixes those and adds two things the hybrid lacked: **issue-code dispatch** (instead of check-kind-only dispatch) and **cascade** (so chained `refineSchema` calls can restyle each other's messages).

**What I did:** read all five plans and the whole `package.txt` (src, README, build, ~40 test files), then implemented the runtime core (§5.1) and ran it through 18 behavioural tests against stand-in schema nodes shaped like Zod 4's `_zod.def` / `_zod.constr` (all pass; §12).

**What I could not do:** run Zod 4 or `tsc`. My sandbox has only `zod@3.23.8` and no network. Everything that depends on Zod 4's real issue shapes or TypeScript types is listed as an explicit assumption (A1–A8, §3.5) with a copy-paste probe (§9). Run Phase 0 first; each assumption names the section that changes if it turns out wrong.

---

## 1. What changed vs the hybrid, and why

| # | Hybrid plan | Problem (evidence in the package) | This plan |
|:-:|:--|:--|:--|
| 1 | Callback becomes `(fields, z)`. | The repo **removed exactly this**: `refine-schema.test.ts` carries a NOTE that injecting the Zod namespace cost ~454 KB vs ~85 KB and broke tree-shaking; `refine-treeshaking.test.ts` guards it. The hybrid's own §11 says "no `import * as z`", so it contradicts itself. The README still documents `(fields, z)`. **The README is stale**, which is probably where the idea came from. | Callback stays `(fields)`. Fix the README in this work (§5.4). |
| 2 | "Zero bundle impact: only reachable through the new overloads." | `refineSchema` is a single export; whatever it references ships to every consumer. | Honest claim: **bounded** cost. Code isolated in `error-map.ts`; add a bundle-delta test (§7). |
| 3 | `EXPLICIT_SET_ERROR_BRAND` symbol plus an own-descriptor "getter vs data property" probe in `hasInlineError`. | `setErrorOnField` already stamps `error: () => msg` on the def **and every check**, so "`def.error` is a function" already detects `.setError`. The brand is set on the *outermost* clone but the map pass reads it from the *unwrapped core*, so it never matches optional/nullable/default fields (nearly every Drizzle field). The "Zod pre-populates an `error` getter" claim has no support: the serializer's `extractCheckError` treats `typeof def.error === "function"` as "the user wrote a message", which would emit garbage on every check if that were false. | Drop both. `isAuthored(def)` = `def.error` is a function **we did not install** (§3.1). |
| 4 | Dispatch by `checkDef.check` only (`number_format → map.int`). | `z.int32()` range overflow comes from the same check but is a `too_big`/`too_small` issue; it would say "must be a whole number". Also depends on internal check names that drift between Zod patches. | Dispatch by **issue code**, plus a tiny static *site* hint (is this the int check? what is the canonical format name?) (§3.2). |
| 5 | Specific format keys from `StringFormat`, looked up via `def.format`. | Zod stores `z.uuidv4()` as `{format:"uuid", version:"v4"}` and `z.httpUrl()` as `{format:"url", protocol}` (serializer comment, finding H2). So `uuidv4`, `uuidv6`, `uuidv7`, `httpUrl` **can never match**. | Resolve the canonical name with the existing `resolveStringFormatName` (moved to a shared module). `uuid` covers v4/6/7 and `url` covers `httpUrl` when the specific key is absent. |
| 6 | Key restriction by class identity: `DeepUnwrap<T> extends z.ZodString`, `z.ZodNativeEnum`, … | After `.as(z.email())` the core is a `ZodEmail`, probably **not** assignable to `ZodString` → it silently falls into the permissive branch. `ZodNativeEnum` probably doesn't exist in Zod 4's types (compile error). A 9-deep conditional chain against heavy Zod interfaces is also slow. | Classify by the **`_zod.def.type` literal** through a lookup table (`KeysByKind`). O(1), subclass-proof (A7). |
| 7 | "Layer 2 preserves Layer 1's mapped errors." | True only for fields layer 2 doesn't touch. A function installed by layer 1's map is indistinguishable from an authored one, so layer 2's map can **never restyle it**. `composition-chains.test.ts` shows multi-stage refine is a first-class use case. | **Cascade**: installed handlers carry their source map; layer 2 merges per key (later wins); authored errors still win (§3.3). |
| 8 | Three overloads, map-only first. | Splitting the callback form across two overloads degrades diagnostics. A function reaching the map overload must not be left to weak-type luck (tables with `name`/`length` columns). "Left-to-right" is necessary but not sufficient for inferring `R`. | **Two overloads, callback first.** Map parameter wrapped in a `NoInfer` shim so the map can never feed inference of `R`. Pinned by type tests. |
| 9 | Root-format special case: `z.email({error})` wins only for `invalid_format`; map fills `required`. | Needs `isRootFormat` branching (also true for `z.int()`), and contradicts "inline wins". | Strict rule: an authored def-level error covers everything that def raises. Rejected alternative explained in §3.1. |
| 10 | "Unknown check → `default` only (fail-closed, from Plan D)". | Plan D says unknown → *skip the map*. The hybrid mislabels its own behaviour. | Defined precisely: unknown code/check → `default` only, never a guessed specific key (§3.2). |
| 11 | §6 Valibot / TypeBox application algorithms. | `refineSchema` is **Zod-only by design** (README; `dts-builder` omits it for non-zod targets) and neither adapter emits any custom message at all. TypeBox's `errorMessage` in Plans A/E is an Ajv-errors convention, not a TypeBox feature. | Out of v1. Only the *vocabulary* is kept neutral (§10). |
| 12 | Pattern 3: `.setError(FieldErrorMap)`. | No new capability (the 3rd argument does the same job); overwrite-vs-fill semantics unspecified (today's `setError` is overwrite-all). | Deferred (§10). Internals make it a ~10-line addition later. |

**Also rejected from the source plans** (recorded so nobody re-imports them): `invalid_enum_value` (a Zod 3 code; Zod 4 uses `invalid_value`) and "`multiple_of` → `invalid_value`" (Zod 4: `not_multiple_of`) in `error-map-architecture.md`; the `[field: string]` index signature in `SchemaErrorMap` (refine-schema plan), which disables the unknown-field compile error; recursing into `def.element` in `setErrorOnField` (error_handling plan), which breaks the "audit 5b" array-element test; a `TMap` generic plus identity `ErrorMappedShape` (the output type never depends on the map).

---

## 2. Public API

### 2.1 Signatures

```ts
// Overload 1 (callback FIRST): rules, plus an optional fallback map for the final shape.
export function refineSchema<
	T extends z.ZodObject<any>,
	R extends RefinementCallbackResult<T["shape"]>,
>(
	baseSchema: T,
	refinementFn: (fields: RefinableShape<T["shape"]>) => R,
	errorMap?: SchemaErrorMap<NoInferShim<RefinedShape<T["shape"], R>>>,
): z.ZodObject<RefinedShape<T["shape"], R>>;

// Overload 2: messages only.
export function refineSchema<T extends z.ZodObject<any>>(
	baseSchema: T,
	errorMap: SchemaErrorMap<T["shape"]>,
): z.ZodObject<T["shape"]>;
```

The callback keeps its single `fields` argument. Users import Zod themselves, as the repo's tree-shaking guard requires.

### 2.2 Usage

```ts
import { email, string } from "zod";
import { insertUsersSchema, refineSchema } from "virtual:drizzle-validators/users";

// 1. Messages only
export const createAccount = refineSchema(insertUsersSchema, {
	username: "Please enter a valid username",            // shorthand = { default }
	email: {
		required: "Please provide your corporate email",
		email: "Email address format is invalid",
		max: "Email cannot exceed 255 characters",         // styles the varchar(255) check
	},
	age: {
		required: "Age is required",
		int: "Age must be a whole number",
		min: (issue) => `You must be at least ${issue.minimum} years old`,
	},
	role: { invalid_value: "Selected role is invalid" },
});

// 2. Rules + fallback messages (the map sees callback-added fields and replaced types)
export const register = refineSchema(
	insertUsersSchema,
	(fields) => ({
		email: fields.email.as(email()),
		age: fields.age.min(21, { error: "VIP registration requires age 21+" }), // authored: wins
		confirmPassword: string().min(8),
	}),
	{
		email: { required: "Email is required", email: "Enter a valid work email" },
		age: { required: "Age is required", min: "Fallback; ignored for the authored min(21)" },
		confirmPassword: { required: "Please confirm your password", min: "At least 8 characters" },
	},
);

// 3. i18n: functions receive Zod's raw issue
export const localized = refineSchema(baseUsers, {
	email: {
		required: () => t("validation.email.required"),
		max: ({ maximum }) => t("validation.email.too_long", { max: maximum }),
	},
});

// 4. Chaining: a later map restyles an earlier one per key (§3.3)
const domain = refineSchema(baseUsers, { email: { required: "Email required", email: "Valid email required" } });
const app    = refineSchema(domain,    { email: { required: "We need your email!" } }); // email format message persists
```

### 2.3 Key reference

| Key | Fires on | Legal on (unwrapped core) | Notes |
|:--|:--|:--|:--|
| `default` | any issue on the field with no more specific key | all | string / function shorthand is `{ default }` |
| `required` | `undefined` input | all | falls back to `invalid_type` |
| `null` | `null` input | all | falls back to `invalid_type` |
| `invalid_type` | wrong JS type | all | |
| `invalid_value` | enum / literal mismatch | enum, literal | |
| `min` / `max` | `.min .gt .gte` / `.max .lt .lte` | string, number, bigint, date, array, set | function payload carries `minimum` / `maximum` |
| `length` | exact length (`.length()`) | string, array, set | |
| `int` | non-integer from `.int()` / `z.int()` | number | int32/uint32 *range* errors go to `min`/`max` |
| `multiple_of` | `.multipleOf()` | number, bigint | |
| `format` | any string format without a specific key | string | |
| `regex` `starts_with` `ends_with` `includes` | the matching string checks | string | |
| `email` `url` `uuid` `guid` `cuid` `cuid2` `ulid` `emoji` `nanoid` `jwt` `ipv4` `ipv6` `cidrv4` `cidrv6` `base64` `base64url` `xid` `ksuid` `e164` `httpUrl` `uuidv4` `uuidv6` `uuidv7` | that format | string | derived from `STRING_FORMAT_NAMES` (single source of truth); `uuid` covers v4/6/7, `url` covers `httpUrl` |
| `custom` | `.refine()` / `z.custom()` with no message of its own | all | |

At runtime a **known key that doesn't apply** to the core is a harmless no-op (the map is a stylesheet, never a rule). An **unknown key** or a non-string/function value throws (the package's fail-loud policy).

---

## 3. Semantics

### 3.1 Precedence

| Tier | Source | Wins over |
|:-:|:--|:--|
| 1 | **Authored**: inline `.min(n, {error})`, `z.x({error})`, `.setError()` / `.withError()`, anything baked into the base schema | everything below |
| 2 | Map **specific** key (a later layer's map beats an earlier layer's) | 3, 4 |
| 3 | Map **`default`** / shorthand | 4 |
| 4 | Zod's own chain: parse-time `error` → `z.config({ customError })` → locale | n/a |

`.setError()` stamps the def and every check, so "field-level" and "check-level" authored errors collapse into one tier.

**Composes with Zod i18n.** Our handler returns `undefined` for unmapped issues, so Zod continues down its chain: unmapped issues still get your locale. A *mapped* message beats a parse-time `{ error }` and the locale (it sits at `def.error`).

| Scenario | Definition | Map | Input | Message |
|:--|:--|:--|:--|:--|
| Inline check wins | `f.age.min(18, {error:"Inline"})` | `age:{min:"Map"}` | `15` | `Inline` |
| `.setError` wins entirely | `f.email.setError("Field")` | `email:{required:"Map"}` | `undefined` | `Field` |
| Map fills a gap | `f.age.as(z.int())` | `age:{int:"Whole"}` | `15.5` | `Whole` |
| Mixed on one field | `.min(18,{error:"Inline"})` + bare `.max(150)` | `{min:"M", max:"X"}` | `10` / `200` | `Inline` / `X` |
| `default` | bare required string | `name:"Name needed"` | `undefined` | `Name needed` |
| Unmapped → Zod | `f.name.min(3)` | `name:{max:"Long"}` | `"a"` | Zod's default / locale |

**Decision: strict inline-wins for def-level errors, no presence exception.** `z.email({error:"X"})` + map `required` shows `X` for `undefined`, exactly as Zod itself would. I considered letting the map fill presence issues (`undefined`/`null`) over an authored def error (the hybrid's special case) and rejected it: `.setError("X")` writes the same property, so telling the two apart needs the brand machinery back (§1 #3), and it would make "authored always wins" false. Advice for the README: *to style presence and format separately, use `.as(z.email())` and put both messages in the map.* The schema's **checks** (e.g. the Drizzle `max(255)`) are still styled even when the def is authored.

### 3.2 Dispatch (issue → key chain; first defined wins, else `undefined` → Zod)

| `issue.code` | Chain |
|:--|:--|
| `invalid_type`, `input === undefined` | `required` → `invalid_type` → `default` |
| `invalid_type`, `input === null` | `null` → `invalid_type` → `default` |
| `invalid_type`, int check, numeric input | `int` → `default` (never `invalid_type`: "it *is* a number") |
| `invalid_type`, otherwise | `invalid_type` → `default` |
| `invalid_value` | `invalid_value` → `default` |
| `too_small` / `too_big` | exact (`issue.exact`)? `length` : `min`/`max` → `default` |
| `not_multiple_of` | `multiple_of` → `default` |
| `custom` | `custom` → `default` |
| `invalid_format`, int check | `int` → `default` (guard for Zod versions that report non-integers this way) |
| `invalid_format` | canonical-format key (`regex`, `starts_with`, `email`, `uuidv4` → `uuid`, `httpUrl` → `url`, …) → `format` → `default` |
| anything else (`unrecognized_keys`, `invalid_union`, `invalid_key`, `invalid_element`, future codes) | `default` only. **Never a guessed specific key.** |

### 3.3 Cascade (chained `refineSchema`)

Every function we install carries (via `Symbol.for("drizzle-validators.error-map")`) the frozen map it was built from.
- Authored error present → untouched, always (even over a later map).
- Our installed error present → the new map is **merged per key over the old one** and a fresh handler replaces it. Keys the later map doesn't mention persist.
- Result: re-labelling a lower layer's schema works, nothing is lost silently, and applying the same map twice is idempotent.
- A later `default` does **not** erase an earlier *specific* key (specific beats default, as everywhere). Documented.

### 3.4 Behaviours to document in the README ("Gotchas")

1. **Same-kind checks share a message.** A Drizzle bound plus your own `.min()` both get `min`. Use a function (`issue.minimum`) or author the one you care about inline.
2. **`z.coerce.*`**: coercion runs before the type check, so `issue.input` is the coerced value (`NaN`, `Invalid Date`), not `undefined`. `required` can't fire; the issue lands on `invalid_type` (A5).
3. **Field `.describe()` metadata is lost on a field the map actually changes.** `cloneSchemaWithDef` rebuilds with `new constr(def)` and doesn't carry registry metadata (already true for `setError` and `.as`). Untouched fields are returned as-is (A8).
4. **Throwing functions propagate** out of `safeParse` (standard Zod behaviour for error callbacks).
5. Only wrappers `unwrapAll` understands are peeled (optional, exactOptional, nullable, readonly, default, catch). Other cores (pipe, nonoptional, lazy, …) receive def-level keys and `default` only.

### 3.5 Assumptions about Zod 4 that Phase 0 must confirm

| # | Assumption | Evidence I have | If wrong, change |
|:-:|:--|:--|:--|
| A1 | `def.error` is `undefined` unless authored; authored values are own function properties. | Serializer `extractCheckError`; `refine-contamination` default messages. | `isAuthored` (§5.1) |
| A2 | A check's issues use the **check** as `inst`; a schema-level `error` is not consulted for them. | `setErrorOnField` already sets errors on every check for this reason. | Whether checks must be cloned |
| A3 | The raw issue given to `error` includes `input`; returning `undefined` falls through to Zod's chain. | Zod 4 docs example uses `iss.input === undefined`. | `required` / `null` dispatch |
| A4 | Shapes: `.length()` → `too_small`/`too_big` with `exact: true`; regex/starts_with/… → `invalid_format` with `format` = that name; `.multipleOf` → `not_multiple_of`; enum → `invalid_value`. | Memory of Zod 4 source. **Unverified.** | `pick()` §5.1 |
| A5 | `z.coerce.*` rewrites input before issuing. | Source memory. **Unverified.** | §3.4 #2 wording |
| A6 | `z.int()` on `1.5` → `invalid_type` (expected int) *or* `invalid_format`; `z.int32()` overflow → `too_big`. | Handled both ways by `site.intCheck`. | Only if a third shape appears |
| A7 | `ZodEmail` is not assignable to `ZodString`; `_zod.def.type` is a literal type; `z.core.$ZodIssue*` names exist; `ZodNativeEnum` does not. | Memory. **Unverified.** | `KeysByKind` / payload types (§5.3) |
| A8 | `new constr({...def})` drops registry metadata (`description`). | `rebuildZodObject` re-applies `.describe` manually for objects, which implies it. | §3.4 #3 |


---

## 4. Architecture

```
src/constants.ts        + export type StringFormat            (moved here; refine.ts re-exports it)
src/format-names.ts     NEW  resolveStringFormatName()        (moved verbatim out of zod-serializer.ts)
src/zod-serializer.ts   imports it instead of declaring it    (behaviour-preserving refactor)
src/zod-compat.ts       cloneZodCheck(check, string | fn)     (fn passed through untouched)
src/error-map.ts        NEW  public key types + runtime       (no import from refine.ts: no cycle)
src/refine.ts           overloads, RefinedShape, FieldErrorMapFor, SchemaErrorMap, glue, body
README.md               remove stale (fields, z); add "Error maps"
```

`error-map.ts` works on **one unwrapped core**. `refine.ts` owns the glue (`unwrapAll` → `applyErrorMapToCore` → `applyWrappers`), so there is no runtime cycle. `FieldErrorMapFor` / `SchemaErrorMap` live in `refine.ts` because they need `DeepUnwrap`.

**Why per-check cloning and not one def-level handler:** Zod resolves a message from `issue.inst`'s def, and for check-raised issues `inst` is the check, so the field's def never sees them (A2). The existing `setErrorOnField` clones checks for the same reason.

---

## 5. Implementation

### 5.1 `src/error-map.ts` (new): tested

This is the exact file that passed the 18-test harness (§12). Type-only imports from `zod`, one value import (`STRING_FORMAT_NAMES`, ~250 bytes).

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

// ───────────────────────── Public types ─────────────────────────

type IssueBase = z.core.$ZodIssueBase;
/** Raw issue exactly as Zod hands it to an `error` callback (has `input`, `inst`). */
type Raw<I extends IssueBase> = z.core.$ZodRawIssue<I>;

export type ErrorMessage<I extends IssueBase = z.core.$ZodIssue> =
	| string
	| ((issue: Raw<I>) => string | undefined);

type InvalidType = z.core.$ZodIssueInvalidType;
type TooSmall = z.core.$ZodIssueTooSmall;
type TooBig = z.core.$ZodIssueTooBig;
type BadFormat = z.core.$ZodIssueInvalidStringFormat;

export type FieldErrorMap = {
	/** Catch-all for any issue on this field that has no more specific key. */
	default?: ErrorMessage;
	/** `undefined` input on a required field. */
	required?: ErrorMessage<InvalidType>;
	/** `null` input on a non-nullable field. */
	null?: ErrorMessage<InvalidType>;
	/** Wrong JS type (also the fallback for `required` / `null`). */
	invalid_type?: ErrorMessage<InvalidType>;
	/** enum / literal mismatch. */
	invalid_value?: ErrorMessage<z.core.$ZodIssueInvalidValue>;
	/** `.min()` `.gt()` `.gte()` on string / number / bigint / date / array / set. */
	min?: ErrorMessage<TooSmall>;
	/** `.max()` `.lt()` `.lte()`. */
	max?: ErrorMessage<TooBig>;
	/** Exact length (`.length()`). */
	length?: ErrorMessage<TooSmall | TooBig>;
	/** `.int()` / `z.int()` "is not a whole number". */
	int?: ErrorMessage<InvalidType | TooSmall | TooBig>;
	multiple_of?: ErrorMessage<z.core.$ZodIssueNotMultipleOf>;
	/** Any string format without a more specific key below. */
	format?: ErrorMessage<BadFormat>;
	regex?: ErrorMessage<BadFormat>;
	starts_with?: ErrorMessage<BadFormat>;
	ends_with?: ErrorMessage<BadFormat>;
	includes?: ErrorMessage<BadFormat>;
	/** `.refine()` / `z.custom()` checks that carry no message of their own. */
	custom?: ErrorMessage<z.core.$ZodIssueCustom>;
} & { [K in StringFormat]?: ErrorMessage<BadFormat> };

type Presence = "default" | "required" | "null" | "invalid_type" | "custom";
type Bounds = "min" | "max";

/** Which keys are legal for which unwrapped core `_zod.def.type`. */
export interface KeysByKind {
	string:
		| Presence
		| Bounds
		| "length"
		| "format"
		| "regex"
		| "starts_with"
		| "ends_with"
		| "includes"
		| StringFormat;
	number: Presence | Bounds | "int" | "multiple_of";
	bigint: Presence | Bounds | "multiple_of";
	date: Presence | Bounds;
	boolean: Presence;
	enum: Presence | "invalid_value";
	literal: Presence | "invalid_value";
	array: Presence | Bounds | "length";
	set: Presence | Bounds | "length";
}

// ───────────────────────── Runtime ─────────────────────────

/** Marks (and carries the source map of) functions WE install, so a later
 *  refineSchema pass can tell them apart from user-authored errors. */
const MAP_ERROR = Symbol.for("drizzle-validators.error-map");

type NormalizedMap = Readonly<Record<string, ErrorMessage<any> | undefined>>;
type Handler = ((issue: any) => string | undefined) & {
	[MAP_ERROR]?: NormalizedMap;
};

const MAP_KEYS: ReadonlySet<string> = new Set<string>([
	"default", "required", "null", "invalid_type", "invalid_value",
	"min", "max", "length", "int", "multiple_of",
	"format", "regex", "starts_with", "ends_with", "includes", "custom",
	...STRING_FORMAT_NAMES,
]);

const SPECIFIC_FORMAT_KEYS: ReadonlySet<string> = new Set<string>([
	"regex", "starts_with", "ends_with", "includes", ...STRING_FORMAT_NAMES,
]);

/** `uuid` covers uuidv4/6/7, `url` covers httpUrl, when the specific key is absent. */
const FORMAT_PARENT: Readonly<Record<string, string>> = {
	uuidv4: "uuid", uuidv6: "uuid", uuidv7: "uuid", httpUrl: "url",
};

/** Keys that can only originate from the core def, never from a check. */
const CORE_ONLY_KEYS: ReadonlySet<string> = new Set([
	"required", "null", "invalid_type", "invalid_value",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Object.prototype.toString.call(value) === "[object Object]";
}

/** string | fn | object -> frozen, validated, defensively-copied map. */
export function normalizeEntry(entry: unknown, field: string): NormalizedMap {
	if (typeof entry === "string" || typeof entry === "function") {
		return Object.freeze({ default: entry as ErrorMessage<any> });
	}
	if (!isPlainObject(entry)) {
		throw new DrizzleValidatorsError(
			`Invalid error map entry for field "${field}": expected a string, a function, or an object of messages.`,
		);
	}
	const out: Record<string, ErrorMessage<any>> = {};
	for (const [key, value] of Object.entries(entry)) {
		if (value === undefined) continue; // treated as absent
		if (!MAP_KEYS.has(key)) {
			throw new DrizzleValidatorsError(
				`Unknown error map key "${key}" on field "${field}". See FieldErrorMap for the valid keys.`,
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

function mapOf(error: unknown): NormalizedMap | undefined {
	return typeof error === "function" ? (error as Handler)[MAP_ERROR] : undefined;
}

/** Authored = a message the user wrote (inline, `.setError`, base schema). */
function isAuthored(def: InternalZodDef): boolean {
	if (typeof def.error === "function") return mapOf(def.error) === undefined;
	return typeof def.error === "string" || typeof def.message === "string";
}

/** Later maps override earlier maps per key; untouched keys persist. */
function cascade(prev: NormalizedMap | undefined, next: NormalizedMap): NormalizedMap {
	return prev ? Object.freeze({ ...prev, ...next }) : next;
}

interface Site {
	/** This def/check is Zod's integer `number_format` check. */
	readonly intCheck: boolean;
	/** Canonical string-format name (uuidv4, httpUrl, regex, email, ...). */
	readonly formatName: string | undefined;
}

function siteOf(def: InternalZodDef): Site {
	const isStringFormat =
		def.check === "string_format" ||
		(def.type === "string" && typeof def.format === "string");
	return {
		intCheck:
			def.check === "number_format" && /int/i.test(String(def.format ?? "")),
		formatName: isStringFormat ? resolveStringFormatName(def) : undefined,
	};
}

/** Issue -> message. Specific key, then `default`, else undefined (Zod's own message). */
function pick(
	m: NormalizedMap,
	issue: Record<string, any>,
	site: Site,
): ErrorMessage<any> | undefined {
	switch (issue.code) {
		case "invalid_type":
			if (issue.input === undefined) return m.required ?? m.invalid_type ?? m.default;
			if (issue.input === null) return m.null ?? m.invalid_type ?? m.default;
			if (site.intCheck && typeof issue.input === "number") return m.int ?? m.default;
			return m.invalid_type ?? m.default;
		case "invalid_value":
			return m.invalid_value ?? m.default;
		case "too_small":
			return (issue.exact ? m.length : m.min) ?? m.default;
		case "too_big":
			return (issue.exact ? m.length : m.max) ?? m.default;
		case "not_multiple_of":
			return m.multiple_of ?? m.default;
		case "custom":
			return m.custom ?? m.default;
		case "invalid_format": {
			if (site.intCheck) return m.int ?? m.default;
			const name = site.formatName ?? String(issue.format ?? "");
			const parent = FORMAT_PARENT[name];
			const specific = SPECIFIC_FORMAT_KEYS.has(name)
				? (m[name] ?? (parent ? m[parent] : undefined))
				: undefined;
			return specific ?? m.format ?? m.default;
		}
		default:
			// unrecognized_keys, invalid_union, invalid_key, invalid_element, and
			// anything Zod adds later: `default` only, never a guessed specific key.
			return m.default;
	}
}

function makeHandler(map: NormalizedMap, site: Site): Handler {
	const handler: Handler = (issue) => {
		const msg = pick(map, issue, site);
		return typeof msg === "function" ? msg(issue) : msg;
	};
	handler[MAP_ERROR] = map;
	return handler;
}

function touchesChecks(map: NormalizedMap): boolean {
	for (const key of Object.keys(map)) if (!CORE_ONLY_KEYS.has(key)) return true;
	return false;
}

/**
 * Applies one field's map to ONE unwrapped core schema. Clone-only:
 * returns `core` itself when nothing needs to change.
 */
export function applyErrorMapToCore(
	core: z.ZodTypeAny,
	entry: NormalizedMap,
): z.ZodTypeAny {
	const def = getZodDef(core);
	if (!def) return core;
	const overrides: Record<string, unknown> = {};

	if (Array.isArray(def.checks) && touchesChecks(entry)) {
		let changed = false;
		const checks = def.checks.map((check: unknown) => {
			const checkDef = getZodDef(check);
			if (!checkDef || checkDef.check === "overwrite" || isAuthored(checkDef)) {
				return check;
			}
			changed = true;
			return cloneZodCheck(
				check,
				makeHandler(cascade(mapOf(checkDef.error), entry), siteOf(checkDef)),
			);
		});
		if (changed) overrides.checks = checks;
	}

	if (!isAuthored(def)) {
		overrides.error = makeHandler(cascade(mapOf(def.error), entry), siteOf(def));
	}

	return Object.keys(overrides).length > 0
		? cloneSchemaWithDef(core, overrides, "error map application")
		: core;
}
```

### 5.2 Small supporting changes

**`src/constants.ts`**: add next to the tuple:

```ts
export type StringFormat = (typeof STRING_FORMAT_NAMES)[number];
```

**`src/format-names.ts`** (new): move `resolveStringFormatName` verbatim from `zod-serializer.ts`, add `export`. `zod-serializer.ts` then does `import { resolveStringFormatName } from "./format-names";`. *Why a new module and not importing from the serializer:* the serializer imports `url` from `zod` at module level; pulling it into `refine.ts` would drag the whole serializer into the client bundle.

**`src/zod-compat.ts`**: widen `cloneZodCheck` (backwards compatible; a function is passed through untouched so our `MAP_ERROR` marker survives):

```ts
export type ZodErrorOverride = string | ((issue: any) => string | undefined);

export function cloneZodCheck(check: unknown, errorOverride?: ZodErrorOverride): z.ZodTypeAny {
	const checkDef = getZodDef(check);
	if (!checkDef) {
		throw new DrizzleValidatorsError("Cannot clone a malformed Zod check without a definition.");
	}
	const nextDef = { ...checkDef };
	if (errorOverride !== undefined) {
		nextDef.error = typeof errorOverride === "function" ? errorOverride : () => errorOverride;
	}
	return new (getZodConstructor(check, "check cloning"))(nextDef);
}
```

### 5.3 `src/refine.ts`

```ts
import {
	applyErrorMapToCore,
	normalizeEntry,
	type ErrorMessage,
	type FieldErrorMap,
	type KeysByKind,
} from "./error-map";

export type { ErrorMessage, FieldErrorMap } from "./error-map";
export type { StringFormat } from "./constants";   // replaces the local declaration

export type DeepUnwrap<T extends z.ZodTypeAny> = /* existing, now exported */;

/** Blocks inference through a parameter (TS < 5.4 has no built-in NoInfer). */
type NoInferShim<T> = [T][T extends any ? 0 : never];

/** The shape the existing return type already computed inline; now shared. */
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

type KindOf<T extends z.ZodTypeAny> =
	DeepUnwrap<T> extends infer C extends z.ZodTypeAny ? C["_zod"]["def"]["type"] : never;

/** Distributive: a union of kinds yields the union of their key sets; unknown kinds stay permissive. */
type KeysOf<K> = K extends keyof KeysByKind ? KeysByKind[K] : keyof FieldErrorMap;

export type FieldErrorMapFor<T extends z.ZodTypeAny> = {
	[K in KeysOf<KindOf<T>> & keyof FieldErrorMap]?: FieldErrorMap[K];
};

export type FieldErrorEntry<T> = T extends z.ZodTypeAny ? ErrorMessage | FieldErrorMapFor<T> : never;

export type SchemaErrorMap<TShape> = { [K in keyof TShape]?: FieldErrorEntry<TShape[K]> };
```

*Type-spike note:* if `NoInferShim<...>` fails a constraint check, loosen `SchemaErrorMap`'s parameter to `TShape` (already unconstrained above). If `KindOf` errors on `["_zod"]`, key the lookup on `z.output<>` instead. Both are Phase 1 exit-criteria items, not design changes.

Glue and body (the callback branch is the **existing** code, unchanged):

```ts
function applyErrorMapToShape(
	shape: Record<string, z.ZodTypeAny>,
	errorMap: Record<string, unknown>,
): void {
	for (const [key, entry] of Object.entries(errorMap)) {
		if (entry === undefined) continue; // treated as absent
		const field = Object.hasOwn(shape, key) ? shape[key] : undefined;
		if (!field) {
			throw new DrizzleValidatorsError(
				`Cannot apply an error map to unknown field "${key}". Known fields: ${Object.keys(shape).join(", ")}.`,
			);
		}
		const { core, wrappers } = unwrapAll(field); // also strips refine proxies
		const nextCore = applyErrorMapToCore(core, normalizeEntry(entry, key));
		if (nextCore !== core) shape[key] = applyWrappers(nextCore, wrappers);
		// nothing changed -> the original field instance is kept (fast path)
	}
}

export function refineSchema(baseSchema: z.ZodObject<any>, second: unknown, third?: unknown): z.ZodObject<any> {
	const nextShape: Record<string, z.ZodTypeAny> = { ...baseSchema.shape };
	let errorMap: unknown;

	if (typeof second === "function") {
		const result = (second as (fields: unknown) => unknown)(createLazyShapeProxy(baseSchema.shape));
		if (!result || typeof result !== "object") {
			throw new DrizzleValidatorsError("refineSchema callback must return an object mapping field names to schemas.");
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
	} else if (second !== null && typeof second === "object" && !Array.isArray(second)) {
		if (third !== undefined) {
			throw new DrizzleValidatorsError(
				"refineSchema(schema, errorMap) takes two arguments. To combine rules and messages, pass (schema, callback, errorMap).",
			);
		}
		errorMap = second;
	} else {
		throw new DrizzleValidatorsError(
			"refineSchema expects a refinement callback function or an error map object as its second argument.",
		);
	}

	if (errorMap !== undefined) {
		if (errorMap === null || typeof errorMap !== "object" || Array.isArray(errorMap)) {
			throw new DrizzleValidatorsError("refineSchema errorMap must be a plain object mapping field names to messages.");
		}
		applyErrorMapToShape(nextShape, errorMap as Record<string, unknown>);
	}
	return rebuildZodObject(baseSchema, nextShape);
}
```

The two overload declarations from §2.1 sit directly above this implementation signature. The map is applied **after** callback results are merged, so it sees the final schema and final core type, and it always goes through `rebuildZodObject` (strict/loose/catchall, object-level checks and `.describe` preserved exactly as today).

### 5.4 README

Remove the "Validator callback argument" bullet and the `(fields, z)` example (they document a feature the code no longer has). Add an "Error maps" section: the two forms, the key table (§2.3), the precedence ladder (§3.1), cascade (§3.3), the Gotchas (§3.4), and a note that `refineSchema` (and so error maps) is Zod-only.

---

## 6. Edge cases

| Case | Behaviour |
|:--|:--|
| Field in map, not in shape | Throws `DrizzleValidatorsError` naming the known fields. TS rejects it at compile time. |
| Map value `undefined` | Absent. |
| Empty string `""` | A valid message (not absent). |
| Empty map `{}` | No field changes; still rebuilt through `rebuildZodObject` (consistent with a `{}` callback today). |
| Known key irrelevant to the core (`int` on a string) | Runtime no-op; compile error in TS. |
| Unknown key / non-string-or-function value | Throws, naming `field.key`. |
| Presence-only map (`required`, `null`, `invalid_type`, `invalid_value`) | Checks are not cloned (they cannot raise those issues). |
| Field with no changes needed | Same instance returned; description/metadata untouched. |
| `overwrite` checks (`.trim()`, `.toLowerCase()`) | Never cloned; they raise no issues. |
| Optional + `undefined` | Wrapper succeeds; `required` never falsely fires. |
| Optional + wrong type | Core raises `invalid_type` → mapped. |
| Non-nullable + `null` | `null` → `invalid_type` → `default`. |
| `default` / `catch` wrappers | Preserved by `applyWrappers`, including lazy getters. |
| Arrays | Map styles the array's own checks only. Element failures keep their own messages (no recursion into `element`; parity with the "audit 5b" test). |
| Transforms / pipes / lazy / nonoptional | Def-level keys + `default` only; internals are never guessed. |
| Object-level checks | Untouched (cloned by `rebuildZodObject` as today). No `_object` key in v1. |
| Check with `abort` / `when` | Preserved (def spread). |
| Throwing error function | Propagates out of `safeParse`. |
| Async refinements | Unaffected (map application is synchronous construction). |
| Map object mutated by caller afterwards | No effect (entries are copied and frozen). |
| Same map applied to many schemas | Independent; no shared mutable state. |
| Authored `def.message` / string `def.error` | Treated as authored (defensive; Zod 4 normalizes to a function). |

---

## 7. Test plan

**Runtime**: new `tests/refine-error-map.test.ts` (Bun). Extend `bug-repro/refine-contamination.test.ts` and `bug-repro/refine-treeshaking.test.ts`.

| Group | Cases |
|:--|:--|
| **Dispatch** | R1 string shorthand is a catch-all (undefined, wrong type, too short all → message) · R2 function shorthand · R3 `required`/`null`/`invalid_type` chain and fallbacks · R4 `min`/`max`/`length` on string, number, array · R5 `int` vs int32 range overflow · R6 `email` > `format` > `default`; `ipv4` via `format`; `regex`/`starts_with`/`ends_with`/`includes` · R7 `uuidv4` → `uuid`, `httpUrl` → `url` · R8 enum/literal `invalid_value` · R9 `multiple_of` · R10 `.refine()` without message → `custom`; with message untouched · R11 dynamic fn receives the raw issue (`minimum`, `input`) · R12 unmapped issue yields Zod's exact default text (`"Too small: expected string to have >=2 characters"`) |
| **Precedence** | R13 inline check error wins · R14 `.setError()` wins incl. `required` · R15 authored `z.email({error})` wins even for `undefined`; its `max(255)` check is still styled · R16 `.as(z.email({error}))` + map `required` → inline wins (documents §3.1) |
| **Wrappers** | R17 optional / nullable / default / catch / readonly / exactOptional still accept their sentinels and report mapped messages for invalid values · R18 untouched field returned by identity · R19 Drizzle-shaped fields: `z.string().max(255)` styled by `max`; `z.int().gte().lte()` styled by `min`/`max` |
| **Callback + map** | R20 callback-added field is styled · R21 `.as()` replaces the core; map sees the new core; transferred checks are styled · R22 unknown field throws and lists known fields · R23 unknown key / bad value type throws; `undefined` absent; `""` valid · R24 non-plain object, or object-form with a 3rd argument, throws; callback-only API byte-for-byte unchanged |
| **Cascade / chain** | R25 layer 2 overrides layer 1 per key, others persist · R26 layer 2 authored beats layer 1 map; layer 1 authored beats layer 2 map · R27 `.pick()`/`.omit()` between layers · R28 idempotence |
| **C1** | R29 two maps from one base are independent and the base's defs/checks are identity-unchanged · R30 mutating the map literal afterwards has no effect · R31 array element failures keep the element's message · R32 strict/loose/catchall + object `.describe` preserved |
| **Bundle** | B1 named-import entry using a map stays < 120 000 chars · B2 delta vs the same entry without a map ≤ **8 KB** (tune after the first measurement; expected low single-digit KB) · B3 no locales |

**Types**: new `tests/types/refine-error-map.types.ts` (no `.test.` suffix; checked by `bun run typecheck`, since `tsconfig` includes `tests/**/*`). The repo has no type tests today, so add a tiny `Equal<A,B>` helper and use `// @ts-expect-error`.

| # | Assertion |
|:-:|:--|
| T1 | Map-only: base fields autocomplete; unknown field is an error |
| T2 | Wrong-category key errors (`int` on a string field, `email` on a number field) |
| T3 | Callback-added field is accepted in the map |
| T4 | Callback changes a field's type via `.as()` → key set switches |
| T5 | `.as(z.email())` core still offers the string key set (guards A7) |
| T6 | Optional / nullable / default wrappers see the inner kind |
| T7 | A table with columns named **`name`** and **`length`**: the callback overload is chosen and `fields` is typed (not `any`) |
| T8 | The map never widens `R`: the return type with and without a map is `Equal`; an extra key errors |
| T9 | Function payloads are typed (`min: (i) => i.minimum`) |
| T10 | `z.infer` is identical with and without a map |
| T11 | `tsc -p tsconfig.build.json` emits declarations; the overloads survive `(typeof import('@vacuus/drizzle-validators/refine'))['refineSchema']` (that is how `dts-builder` re-exports it) |

---

## 8. Phases and exit criteria

| Phase | Work | Exit criterion |
|:-:|:--|:--|
| **0** | Run the probes (§9). Paste the output into the PR. | Assumption table A1–A8 updated; any deviation reflected in §5.1 `pick()` / §5.3 types before coding. |
| **1** | Types + overloads wired to an erased runtime (map ignored). | T1–T10 green; `bun run typecheck` clean. |
| **2** | Foundation refactors: `StringFormat` into `constants.ts`, `format-names.ts`, `cloneZodCheck` accepts a function, serializer import swap. | The **entire existing suite is green with zero output diff** (serializer tests prove the move is behaviour-preserving). |
| **3** | `error-map.ts`, glue, new `refineSchema` body. | R1–R24 green. |
| **4** | Cascade, C1, bundle tests, README. | R25–R32, B1–B3, T11 green; `bun run build` clean. |
| **5** | Release notes; bump to `0.2.0` (additive public API). | n/a |

Smallest-first commands: `bun test packages/drizzle-validators/tests/refine-error-map.test.ts`, then `…/refine-schema.test.ts`, `…/bug-repro/refine-contamination.test.ts`, then `typecheck` and `build` via `bun run --filter='@vacuus/drizzle-validators' <script>`.

Because `peerDependencies` allows `zod ^4.0.0-0` while tests run on `^4.4.3`, run the new suite once against the oldest 4.x you intend to support (the check-kind and issue shapes are the likeliest to drift).

---

## 9. Phase 0: probes (≈ 5 minutes)

Two throwaway scripts. They print what Zod 4 *actually* does for every assumption in §3.5. Nothing here touches the package.

**`scripts/probe-zod-error-internals.ts`**: `bun scripts/probe-zod-error-internals.ts`

```ts
// scripts/probe-zod-error-internals.ts — run: bun scripts/probe-zod-error-internals.ts
// Prints what zod@4.x ACTUALLY does for every assumption the error-map plan makes.
import { z } from "zod";

type Raw = Record<string, any>;

function probe(label: string, build: (spy: (iss: Raw) => undefined) => z.ZodTypeAny, input: unknown) {
	const seen: Raw[] = [];
	const spy = (iss: Raw): undefined => {
		seen.push({
			code: iss.code, input: Number.isNaN(iss.input) ? "NaN" : iss.input,
			expected: iss.expected, origin: iss.origin, format: iss.format, exact: iss.exact,
			minimum: iss.minimum, maximum: iss.maximum, inclusive: iss.inclusive,
			divisor: iss.divisor, values: iss.values,
			instType: iss.inst?._zod?.def?.type, instCheck: iss.inst?._zod?.def?.check,
			instFormat: iss.inst?._zod?.def?.format, instVersion: iss.inst?._zod?.def?.version,
		});
		return undefined; // defer to Zod's own message
	};
	const r = build(spy).safeParse(input);
	console.log(label.padEnd(30), JSON.stringify({ ok: r.success, seen }));
}

console.log("── A. issue shapes (raw issue seen by an `error` callback) ──");
probe("string / undefined",        (s) => z.string({ error: s }), undefined);
probe("string / null",             (s) => z.string({ error: s }), null);
probe("string / 123",              (s) => z.string({ error: s }), 123);
probe("string.min",                (s) => z.string().min(3, { error: s }), "a");
probe("string.max",                (s) => z.string().max(2, { error: s }), "abc");
probe("string.length (exact?)",    (s) => z.string().length(3, { error: s }), "abcd");
probe("string.regex",              (s) => z.string().regex(/^a/, { error: s }), "b");
probe("string.startsWith",         (s) => z.string().startsWith("a", { error: s }), "b");
probe("string.email() check",      (s) => z.string().email({ error: s }), "x");
probe("z.email() / bad",           (s) => z.email({ error: s }), "x");
probe("z.email() / undefined",     (s) => z.email({ error: s }), undefined);
probe("z.uuidv4()",                (s) => z.uuidv4({ error: s }), "x");
probe("z.httpUrl()",               (s) => z.httpUrl({ error: s }), "x");
probe("z.int() / 1.5",             (s) => z.int({ error: s }), 1.5);
probe("z.int() / 'abc'",           (s) => z.int({ error: s }), "abc");
probe("z.int32() / 3e9",           (s) => z.int32({ error: s }), 3_000_000_000);
probe("number.min",                (s) => z.number().min(5, { error: s }), 1);
probe("number.gt",                 (s) => z.number().gt(5, { error: s }), 5);
probe("number.multipleOf",         (s) => z.number().multipleOf(5, { error: s }), 7);
probe("enum",                      (s) => z.enum(["a", "b"], { error: s }), "c");
probe("array.min",                 (s) => z.array(z.string()).min(1, { error: s }), []);
probe("array element",             (s) => z.array(z.string({ error: s })), [1]);
probe("date.min",                  (s) => z.date().min(new Date(2020, 0, 1), { error: s }), new Date(2000, 0, 1));
probe("coerce.number / undefined", (s) => z.coerce.number({ error: s }), undefined);
probe("coerce.date / 'nope'",      (s) => z.coerce.date({ error: s }), "nope");

console.log("\n── B. structural assumptions ──");
const plain: any = z.string().min(3);
console.log("B1 schema def.error:", plain._zod.def.error, "| check def.error:", plain._zod.def.checks[0]._zod.def.error,
	"| own descriptor:", Object.getOwnPropertyDescriptor(plain._zod.def.checks[0]._zod.def, "error"));
const authored: any = z.string().min(3, { error: "x" });
console.log("B2 authored check def.error is:", typeof authored._zod.def.checks[0]._zod.def.error);
const r2 = z.string({ error: () => "SCHEMA-LEVEL" }).min(3).safeParse("a");
console.log("B3 schema-level error used for a CHECK issue? (expect NO):", !r2.success && r2.error.issues[0]?.message);
const d: any = z.string().describe("Email field");
const Ctor = d._zod.constr;
console.log("B4 description survives raw clone? (expect undefined = lost):", new Ctor({ ...d._zod.def }).description);
```

**`scripts/probe-types.ts`**: `bunx tsc --noEmit scripts/probe-types.ts`

```ts
// scripts/probe-types.ts — run: bunx tsc --noEmit scripts/probe-types.ts  (zod@4.x installed)
import type { z } from "zod";
import { email } from "zod";

// T1: must COMPILE (the typed-payload names the plan uses)
type _1 = z.core.$ZodRawIssue<z.core.$ZodIssueTooSmall>;
type _2 = z.core.$ZodIssueInvalidType;
type _3 = z.core.$ZodIssueTooBig;
type _4 = z.core.$ZodIssueInvalidStringFormat;
type _5 = z.core.$ZodIssueInvalidValue;
type _6 = z.core.$ZodIssueNotMultipleOf;
type _7 = z.core.$ZodIssueCustom;
// T2: class-identity classification. If this line ERRORS, `T extends z.ZodString` is NOT a safe classifier.
const _emailIsString: z.ZodString = email();
// T3: the literal the plan classifies on — must be exactly "string"
type _Kind = ReturnType<typeof email>["_zod"]["def"]["type"];
const _k: _Kind = "string";
// T4: the hybrid plan references this. EXPECT an error here in Zod 4.
type _Native = z.ZodNativeEnum<any>;
```

**What to look for**

| Probe | Expected | Confirms | If it differs |
|:--|:--|:--|:--|
| B1 | both `def.error` are `undefined`; no own descriptor | A1 | rewrite `isAuthored` |
| B2 | `"function"` | A1 | n/a |
| B3 | `false` / the Zod default text, **not** `SCHEMA-LEVEL` | A2 | if `SCHEMA-LEVEL` appears, the def's error reaches checks and per-check cloning is unnecessary |
| B4 | `undefined` | A8 | if the description survives, delete §3.4 #3 |
| `string / undefined`, `string / null` | `input` is `undefined` / `null` | A3 | `required`/`null` dispatch needs another signal |
| `string.length` | `exact: true` | A4 | switch `length` detection to the check kind via `site` |
| `string.regex`, `startsWith` | `format: "regex"` / `"starts_with"` | A4 | adjust `invalid_format` branch |
| `z.uuidv4()`, `z.httpUrl()` | `instFormat: "uuid"` + `instVersion: "v4"` / `"url"` | #5 | n/a (confirms the serializer comment) |
| `number.multipleOf` | `code: "not_multiple_of"` | A4 | fix the `multiple_of` branch |
| `enum` | `code: "invalid_value"` | A4 | fix the `invalid_value` branch |
| `z.int() / 1.5` | `invalid_type` with `expected: "int"` (or `invalid_format`) | A6 | both are handled; a *third* shape needs a new branch |
| `z.int() / 'abc'` | `invalid_type`, `expected: "number"` | A6 | n/a |
| `z.int32() / 3e9` | `too_big` | A6 | n/a |
| `coerce.number / undefined` | `input: "NaN"` (not `undefined`) | A5 | if `undefined`, drop §3.4 #2 |
| types T1 | compiles | A7 | rename payload types in `error-map.ts` |
| types T2 | **errors** (`ZodEmail` is not a `ZodString`) | A7 | confirms `KeysByKind` over class identity |
| types T3 | compiles, literal `"string"` | A7 | confirms the classifier |
| types T4 | **errors** (`ZodNativeEnum` absent) | A7 | confirms the hybrid would not compile |

---

## 10. Deferred / out of scope for v1

| Item | Why deferred | Door left open |
|:--|:--|:--|
| `.setError(FieldErrorMap)` / `.withError(map)` | No new capability; semantics (overwrite vs fill) must be decided; today's `setError` is overwrite-all. | `applyErrorMapToCore` already takes a normalized map; an "authored" mode is ~10 lines. |
| Nested/dotted keys (`"address.city"`), array-element maps | Flat per-field maps cover Drizzle's flat tables; recursion mis-classifies `invalid_element`. | Entry type is open to a path key. |
| `_object` key (object-level issues) | Object-level checks keep their own messages. | Same. |
| **Valibot / TypeBox** | `refineSchema` is Zod-only by design and neither adapter emits messages, so there is nothing to map yet. | The key *vocabulary* is validator-neutral. Valibot has per-action `message` (string or function) and would be a straightforward port **if** a Valibot refine layer is ever added. TypeBox has no per-keyword message slot; it would need a checker/formatter boundary, so scope it separately. Do not ship speculative adapters. |
| Preserving field `.describe()` on cloned fields | Pre-existing across `setError` / `.as`; separate fix in `cloneSchemaWithDef` (re-register metadata). | Worth its own PR; this plan documents it (§3.4 #3). |
| Importing Zod locales | Banned (bundle invariant). | Our handler already composes with `z.config(z.locales.xx())` (§3.1). |

---

## 11. Guarantees (accurate claims only)

- **Backward compatible**: callback-only `refineSchema(base, fn)` behaves identically; the new overloads are additive. No change to generated output or CLI.
- **Types**: error mapping never changes `z.infer` (T10). `dts-builder` propagates the overloads automatically through its `typeof import(...)` re-export; verify with T11, no change expected.
- **C1**: every changed def and check is a fresh clone; installed handlers are new closures over frozen copies of the map; nothing shared is written (R29, R30).
- **Bundle**: small and bounded, not zero. Named Zod imports only, `import type` for everything else, no namespace `z`, no locales (B1–B3).
- **Behaviour preserved** for authored errors, arrays' element messages, strict/loose/catchall objects and lazy default/catch getters (R13–R19, R31, R32).

---

## 12. Appendix: what was actually executed while writing this

- `error-map.ts` (§5.1, verbatim) plus stubs of `errors`, `constants`, `format-names` and a copy of the real `getZodDef` / `getZodConstructor` / `cloneSchemaWithDef` and the modified `cloneZodCheck`, run with Node 22 type-stripping against **stand-in Zod 4-shaped nodes**.
- 18 tests, all passing: check filling, `overwrite` skip, C1 identity/deep-equal on the base, authored-wins (core and check), mixed authored/map on one field, `required`/`null`/`invalid_type` chain, shorthands, dynamic payloads, exact `length`, int vs int32 overflow, format specific/generic/default with `uuidv4`→`uuid` and `httpUrl`→`url`, root-format core, authored root-format (strict inline-wins), presence-only no-clone guard, **cascade**, **idempotence**, mutation-of-literal immunity, fail-loud validation, fail-closed unknown codes.
- Both probe scripts passed `node --check` (syntax only).
- **Not executed**: anything against real Zod 4, and any TypeScript compilation. That is precisely what Phase 0 and Phase 1 exist for.
