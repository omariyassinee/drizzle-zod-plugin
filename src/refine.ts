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
	object,
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

type WrapperDef = {
	type: "optional" | "nullable" | "exactOptional" | "default";
	defaultValue?: any;
};

export type StringFormat = (typeof STRING_FORMAT_NAMES)[number];

export type FormatParams = string | Record<string, any>;

/**
 * Extracts all outer wrapper layers (optional, nullable, exactOptional, default)
 * into an ordered stack and returns the innermost core schema.
 */
function unwrapAll(field: z.ZodTypeAny): {
	core: z.ZodTypeAny;
	wrappers: WrapperDef[];
} {
	const wrappers: WrapperDef[] = [];
	let current: any = field;

	while (current) {
		const def = current._def ?? current.def;
		if (!def) break;

		if (def.type === "optional") {
			// Zod 4: ZodExactOptional's def has type "optional", NOT
			// "exactOptional" — the only reliable discriminator is the
			// traits set (verified against zod@4.4.3).
			const isExact = (current._zod?.traits as Set<string>)?.has(
				"ZodExactOptional",
			);
			wrappers.push({ type: isExact ? "exactOptional" : "optional" });
			current = def.innerType;
		} else if (def.type === "nullable") {
			wrappers.push({ type: "nullable" });
			current = def.innerType;
		} else if (def.type === "default") {
			const defaultVal =
				typeof def.defaultValue === "function"
					? def.defaultValue()
					: def.defaultValue;
			wrappers.push({ type: "default", defaultValue: defaultVal });
			current = def.innerType;
		} else {
			break;
		}
	}

	return { core: current, wrappers };
}

/**
 * Re-applies extracted wrapper layers in reverse order (innermost to outermost).
 */
function applyWrappers(
	core: z.ZodTypeAny,
	wrappers: WrapperDef[],
): z.ZodTypeAny {
	let current: any = core;
	for (let i = wrappers.length - 1; i >= 0; i--) {
		const w = wrappers[i];
		if (!w) continue;
		if (w.type === "optional") {
			current = current.optional();
		} else if (w.type === "nullable") {
			current = current.nullable();
		} else if (w.type === "exactOptional") {
			current = current.exactOptional
				? current.exactOptional()
				: current.optional();
		} else if (w.type === "default") {
			current = current.default(w.defaultValue);
		}
	}
	return current;
}

/**
 * Recursively creates an isolated clone of a field schema with custom error messages,
 * ensuring zero in-place mutation of shared Zod defs, checks, or inner types.
 *
 * In Zod 4, `field.clone()` without a new def argument shares the SAME def
 * object (core/util.js: `clone(inst, def)` → `new constr(def ?? inst._zod.def)`),
 * so mutating the clone's def contaminates the base schema and every sibling
 * refined from it. This function instead builds a fresh def object, rebuilds
 * each check via its own constructor (checks do NOT have a `.clone()` method in
 * Zod 4), and instantiates a fresh schema — matching how Zod's own `.check()`
 * implements immutability.
 */
function setErrorOnField(field: z.ZodTypeAny, errorMsg: string): z.ZodTypeAny {
	const fieldDef = (field as any)._zod?.def ?? (field as any)._def;
	if (!fieldDef) return field;

	// 1. Immutably clone the checks array with new check instances.
	//    Each check is rebuilt via its own constructor with a fresh def —
	//    Zod 4 check instances do not expose .clone().
	const newChecks = Array.isArray(fieldDef.checks)
		? fieldDef.checks.map((check: any) => {
				const checkDef = check?._zod?.def ?? check?.def;
				if (!checkDef) return check;
				const updatedCheckDef = {
					...checkDef,
					error: () => errorMsg,
				};
				if (typeof check?._zod?.constr === "function") {
					return new check._zod.constr(updatedCheckDef);
				}
				return check;
			})
		: undefined;

	// 2. Recursively clone nested innerTypes for wrappers (optional, nullable, ...).
	const newInnerType = fieldDef.innerType
		? setErrorOnField(fieldDef.innerType, errorMsg)
		: undefined;

	// 3. Build a fresh def object containing the new error and cloned checks.
	const newDef = {
		...fieldDef,
		error: () => errorMsg,
		...(newChecks !== undefined ? { checks: newChecks } : {}),
		...(newInnerType !== undefined ? { innerType: newInnerType } : {}),
	};

	// 4. Instantiate a fresh schema via the constructor (what Zod's own
	//    core.clone does internally: `new inst._zod.constr(def)`).
	if (typeof (field as any)._zod?.constr === "function") {
		return new (field as any)._zod.constr(newDef);
	}
	return field;
}

const FORMAT_BUILDERS: Record<
	string,
	((params?: FormatParams) => z.ZodTypeAny) | undefined
> = {
	email,
	url,
	httpUrl,
	uuid,
	uuidv4,
	uuidv6,
	uuidv7,
	guid,
	cuid,
	cuid2,
	ulid,
	emoji,
	nanoid,
	jwt,
	ipv4,
	ipv6,
	cidrv4,
	cidrv6,
	base64,
	base64url,
	xid,
	ksuid,
	e164,
};

function createFormatSchema(
	formatName: string,
	params?: FormatParams,
): z.ZodTypeAny {
	const fn = FORMAT_BUILDERS[formatName];
	if (typeof fn === "function") {
		return fn(params);
	}
	const str = string() as any;
	if (typeof str[formatName] === "function") {
		return str[formatName](params);
	}
	throw new Error(
		`[drizzle-zod-plugin] Unknown format "${formatName}" in z.${formatName}()`,
	);
}

/**
 * String-format checks that are constraints rather than formats — they stay
 * valid regardless of the target schema's format (unlike e.g. an `email`
 * format check, which conflicts with a `uuid` target).
 */
const CONSTRAINT_STRING_FORMATS = new Set([
	"regex",
	"starts_with",
	"ends_with",
	"includes",
]);

/**
 * Intelligently transfers validation checks from a source core schema to a
 * target core schema, preserving min/max length, regex, prefixes, suffixes,
 * and transforms while avoiding conflicting format checks.
 *
 * Without this, `.asEmail()` / `.format()` / `.as()` would silently discard
 * every existing check on the field (e.g. `varchar(255)`'s `.max(255)`).
 *
 * Format-conflict guard: converting `z.string().email().min(5)` to `.asUuid()`
 * must NOT transfer the `email` format check onto the uuid schema — that would
 * demand the input be both an email AND a uuid, failing every valid input.
 * Constraint checks (regex/starts_with/ends_with/includes) are always kept.
 */
function transferChecks(
	source: z.ZodTypeAny,
	target: z.ZodTypeAny,
): z.ZodTypeAny {
	const sourceDef = (source as any)._zod?.def ?? (source as any)._def;
	if (!sourceDef || !Array.isArray(sourceDef.checks)) return target;

	const targetDef = (target as any)._zod?.def ?? (target as any)._def;
	const targetFormat = targetDef?.format;

	let result: any = target;
	for (const check of sourceDef.checks) {
		const checkDef = check?._zod?.def ?? check?.def;
		if (!checkDef) continue;

		// Skip conflicting format checks (e.g. email check when converting to uuid).
		if (checkDef.check === "string_format") {
			const fmt = checkDef.format;
			const isConstraint = CONSTRAINT_STRING_FORMATS.has(fmt);
			if (!isConstraint && targetFormat && fmt !== targetFormat) {
				continue;
			}
		}

		if (typeof result.check === "function") {
			result = result.check(check);
		}
	}
	return result;
}

export type RefinedField<T extends z.ZodTypeAny> = T & {
	/**
	 * Overrides the error message on all existing checks and validations of this field
	 * without adding duplicate validation rules.
	 */
	setError(message: string): RefinedField<T>;
	/**
	 * Alias for `setError`. Overrides the error message on existing validations of this field.
	 */
	withError(message: string): RefinedField<T>;
	/**
	 * Replaces the inner core schema with a specialized Zod 4 string format
	 * (e.g. `email`, `uuid`, `url`, `cuid2`, `ulid`, etc.) while automatically
	 * preserving all outer wrapper layers (`optional`, `nullable`, `default`, `exactOptional`).
	 */
	format(formatName: StringFormat, params?: FormatParams): RefinedField<T>;
	/**
	 * Formats the field as an email using Zod 4's `z.email()`, preserving all wrappers.
	 */
	asEmail(params?: FormatParams): RefinedField<T>;
	/**
	 * Formats the field as a URL using Zod 4's `z.url()`, preserving all wrappers.
	 */
	asUrl(params?: FormatParams): RefinedField<T>;
	/**
	 * Formats the field as a UUID using Zod 4's `z.uuid()`, preserving all wrappers.
	 */
	asUuid(params?: FormatParams): RefinedField<T>;
	/**
	 * Formats the field as a CUID2 using Zod 4's `z.cuid2()`, preserving all wrappers.
	 */
	asCuid2(params?: FormatParams): RefinedField<T>;
	/**
	 * Formats the field as a ULID using Zod 4's `z.ulid()`, preserving all wrappers.
	 */
	asUlid(params?: FormatParams): RefinedField<T>;
	/**
	 * Replaces the inner core schema with an arbitrary custom Zod schema,
	 * while preserving all outer wrapper layers (`optional`, `nullable`, `default`, `exactOptional`).
	 */
	as<U extends z.ZodTypeAny>(newCoreSchema: U): RefinedField<U>;
};

type DeepUnwrap<T extends z.ZodTypeAny> =
	T extends z.ZodOptional<infer Inner extends z.ZodTypeAny>
		? DeepUnwrap<Inner>
		: T extends z.ZodNullable<infer Inner extends z.ZodTypeAny>
			? DeepUnwrap<Inner>
			: T extends z.ZodExactOptional<infer Inner extends z.ZodTypeAny>
				? DeepUnwrap<Inner>
				: T extends z.ZodDefault<infer Inner extends z.ZodTypeAny>
					? DeepUnwrap<Inner>
					: T;

export type PreserveWrapper<
	TOriginal extends z.ZodTypeAny,
	TNewCore extends z.ZodTypeAny,
> =
	TOriginal extends z.ZodOptional<infer Inner extends z.ZodTypeAny>
		? z.ZodOptional<PreserveWrapper<Inner, TNewCore>>
		: TOriginal extends z.ZodNullable<infer Inner extends z.ZodTypeAny>
			? z.ZodNullable<PreserveWrapper<Inner, TNewCore>>
			: TOriginal extends z.ZodExactOptional<infer Inner extends z.ZodTypeAny>
				? z.ZodExactOptional<PreserveWrapper<Inner, TNewCore>>
				: TOriginal extends z.ZodDefault<infer Inner extends z.ZodTypeAny>
					? z.ZodDefault<PreserveWrapper<Inner, TNewCore>>
					: TNewCore;

export type RefinableShape<T extends Record<string, z.ZodTypeAny>> = {
	[K in keyof T]: RefinedField<DeepUnwrap<T[K]>>;
};

export type RefinementCallbackResult<
	TShape extends Record<string, z.ZodTypeAny>,
> = {
	[K in keyof TShape]?: z.ZodTypeAny;
} & {
	[key: string]: z.ZodTypeAny | undefined;
};

/**
 * Wraps a field schema in a Proxy that automatically delegates inner type methods
 * (e.g. `.min()`, `.email()`, `.max()`) on nested wrappers (`z.optional()`, `z.nullable()`,
 * `z.default()`, `z.exactOptional()`), re-proxies results to allow method chaining,
 * exposes format helpers (`.format()`, `.asEmail()`, `.asUrl()`, `.asUuid()`, etc.),
 * and exposes `.setError()` / `.withError()` to override error messages on existing checks.
 */
function wrapFieldProxy(field: z.ZodTypeAny): any {
	const { core, wrappers } = unwrapAll(field);

	return new Proxy(field, {
		has(target, prop) {
			if (
				prop === "setError" ||
				prop === "withError" ||
				prop === "format" ||
				prop === "as" ||
				prop === "asEmail" ||
				prop === "asUrl" ||
				prop === "asUuid" ||
				prop === "asCuid2" ||
				prop === "asUlid"
			)
				return true;
			if (prop in target) return true;
			return prop in core;
		},
		get(target, prop, receiver) {
			if (prop === "setError" || prop === "withError") {
				return (msg: string) => {
					const updated = setErrorOnField(target, msg);
					return wrapFieldProxy(updated);
				};
			}

			if (prop === "format") {
				return (formatName: string, params?: FormatParams) => {
					const rawCore = createFormatSchema(formatName, params);
					const newCore = transferChecks(core, rawCore);
					const wrapped = applyWrappers(newCore, wrappers);
					return wrapFieldProxy(wrapped);
				};
			}

			if (prop === "as") {
				return (newCoreSchema: z.ZodTypeAny) => {
					const newCore = transferChecks(core, newCoreSchema);
					const wrapped = applyWrappers(newCore, wrappers);
					return wrapFieldProxy(wrapped);
				};
			}

			if (prop === "asEmail") {
				return (params?: FormatParams) => {
					const rawCore = createFormatSchema("email", params);
					const newCore = transferChecks(core, rawCore);
					const wrapped = applyWrappers(newCore, wrappers);
					return wrapFieldProxy(wrapped);
				};
			}

			if (prop === "asUrl") {
				return (params?: FormatParams) => {
					const rawCore = createFormatSchema("url", params);
					const newCore = transferChecks(core, rawCore);
					const wrapped = applyWrappers(newCore, wrappers);
					return wrapFieldProxy(wrapped);
				};
			}

			if (prop === "asUuid") {
				return (params?: FormatParams) => {
					const rawCore = createFormatSchema("uuid", params);
					const newCore = transferChecks(core, rawCore);
					const wrapped = applyWrappers(newCore, wrappers);
					return wrapFieldProxy(wrapped);
				};
			}

			if (prop === "asCuid2") {
				return (params?: FormatParams) => {
					const rawCore = createFormatSchema("cuid2", params);
					const newCore = transferChecks(core, rawCore);
					const wrapped = applyWrappers(newCore, wrappers);
					return wrapFieldProxy(wrapped);
				};
			}

			if (prop === "asUlid") {
				return (params?: FormatParams) => {
					const rawCore = createFormatSchema("ulid", params);
					const newCore = transferChecks(core, rawCore);
					const wrapped = applyWrappers(newCore, wrappers);
					return wrapFieldProxy(wrapped);
				};
			}

			if (prop in target) {
				const val = Reflect.get(target, prop, receiver);
				if (typeof val === "function") return val.bind(target);
			}

			if (
				typeof prop === "string" &&
				typeof (core as any)[prop] === "function"
			) {
				return (...args: any[]) => {
					const coreResult = (core as any)[prop](...args);
					const wrappedResult = applyWrappers(coreResult, wrappers);
					return wrapFieldProxy(wrappedResult);
				};
			}

			return Reflect.get(target, prop, receiver);
		},
	});
}

/**
 * Refines a base Zod object schema by applying custom field validations or custom error messages,
 * preserving untouched fields and maintaining full TypeScript type inference.
 *
 * Exposes `.setError("...")` / `.withError("...")` on fields to override existing check messages,
 * `.format("email")` / `.asEmail()` / `.asUrl()` / `.asUuid()` to switch to specialized string formats,
 * and automatically delegates methods on optional, nullable, default, or exactOptional fields.
 *
 * @example
 * ```ts
 * import { insertSchema as baseInsertSchema } from "virtual:drizzle-zod/users";
 * import { refineSchema } from "@omariyassine/drizzle-zod-plugin";
 *
 * export const insertSchema = refineSchema(baseInsertSchema, (fields) => ({
 *   email: fields.email.asEmail({ error: "Please enter a valid email address" }),
 *   age: fields.age.min(18, { error: "Must be 18 or older to sign up" }),
 * }));
 * ```
 */
export function refineSchema<
	T extends z.ZodObject<any>,
	R extends RefinementCallbackResult<T["shape"]>,
>(
	baseSchema: T,
	refinementFn: (fields: RefinableShape<T["shape"]>) => R,
): z.ZodObject<
	Omit<T["shape"], keyof R> & {
		[K in keyof R]: K extends keyof T["shape"]
			? R[K] extends z.ZodTypeAny
				? PreserveWrapper<T["shape"][K], DeepUnwrap<R[K]>>
				: T["shape"][K]
			: R[K] extends z.ZodTypeAny
				? R[K]
				: never;
	}
> {
	const proxiedShape: Record<string, any> = {};
	for (const [key, field] of Object.entries(baseSchema.shape)) {
		proxiedShape[key] = wrapFieldProxy(field as z.ZodTypeAny);
	}

	const modifiedFields = refinementFn(proxiedShape as any);
	return object({
		...baseSchema.shape,
		...modifiedFields,
	}) as any;
}
