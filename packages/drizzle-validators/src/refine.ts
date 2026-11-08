import type { z } from "zod";
import { DrizzleValidatorsError } from "./errors";
import type { StringFormat } from "./constants";
import {
	applyErrorMapToCore,
	isPlainObject,
	normalizeEntry,
	type BigIntErrorKeys,
	type ChoiceErrorKeys,
	type CommonErrorKeys,
	type DateErrorKeys,
	type ErrorMessage,
	type AnyCoreErrorKeys,
	type FieldErrorMap,
	type GenericErrorKeys,
	type NumberErrorKeys,
	type ObjectErrorKeys,
	type SizedContainerErrorKeys,
	type StringErrorKeys,
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
export type { StringFormat } from "./constants";
export type { ErrorMessage, FieldErrorMap } from "./error-map";

export const REFINED_FIELD_BRAND = Symbol.for(
	"drizzle-validators.refined-field",
);

export type FormatParams = string | Record<string, any>;

export interface AsOptions {
	/**
	 * Transfer compatible checks from the original core schema unless the
	 * replacement already defines the same check kind.
	 */
	transferChecks?: boolean;
}

type WrapperDef =
	| { type: "optional" | "nullable" | "exactOptional" | "readonly" }
	| {
			type: "default";
			defaultValue?: unknown;
			defaultValueRef?: unknown;
			constr?: new (def: Record<string, unknown>) => z.ZodTypeAny;
	  }
	| {
			type: "catch";
			catchValue?: unknown;
			catchValueRef?: unknown;
			constr?: new (def: Record<string, unknown>) => z.ZodTypeAny;
	  };

type InternalSchema = z.ZodTypeAny & {
	readonly [REFINED_FIELD_BRAND]?: z.ZodTypeAny;
};

export function unwrapAll(field: z.ZodTypeAny): {
	core: z.ZodTypeAny;
	wrappers: WrapperDef[];
} {
	const wrappers: WrapperDef[] = [];
	let current: any = unwrapProxy(field);

	while (current) {
		const def = getZodDef(current);
		if (!def) break;

		if (def.type === "optional") {
			wrappers.push({
				type: isExactOptionalSchema(current) ? "exactOptional" : "optional",
			});
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
					constr: getZodConstructor(current, "lazy default reconstruction"),
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
					constr: getZodConstructor(current, "lazy catch reconstruction"),
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
	for (let index = wrappers.length - 1; index >= 0; index--) {
		const wrapper = wrappers[index];
		if (!wrapper) continue;
		switch (wrapper.type) {
			case "optional":
				current = current.optional();
				break;
			case "exactOptional":
				current =
					typeof current.exactOptional === "function"
						? current.exactOptional()
						: current.optional();
				break;
			case "nullable":
				current = current.nullable();
				break;
			case "readonly":
				current = current.readonly();
				break;
			case "default":
				if (wrapper.defaultValueRef !== undefined && wrapper.constr) {
					const reference = wrapper.defaultValueRef as any;
					current = new wrapper.constr({
						type: "default",
						innerType: current,
						get defaultValue() {
							return reference.defaultValue;
						},
					});
				} else {
					current = current.default(wrapper.defaultValue);
				}
				break;
			case "catch":
				if (wrapper.catchValueRef !== undefined && wrapper.constr) {
					const reference = wrapper.catchValueRef as any;
					current = new wrapper.constr({
						type: "catch",
						innerType: current,
						get catchValue() {
							return reference.catchValue;
						},
					});
				} else {
					current = current.catch(wrapper.catchValue);
				}
				break;
		}
	}
	return current;
}

const CONSTRAINT_STRING_FORMATS = new Set([
	"regex",
	"starts_with",
	"ends_with",
	"includes",
]);

const CHECK_CORE_COMPAT: Record<string, (coreType: string) => boolean> = {
	greater_than: (type) =>
		type === "number" || type === "bigint" || type === "date",
	less_than: (type) =>
		type === "number" || type === "bigint" || type === "date",
	multiple_of: (type) => type === "number" || type === "bigint",
	number_format: (type) => type === "number",
	overwrite: (type) => type === "string",
	min_length: (type) => type === "string" || type === "array" || type === "set",
	max_length: (type) => type === "string" || type === "array" || type === "set",
	length_equals: (type) =>
		type === "string" || type === "array" || type === "set",
	string_format: (type) => type === "string",
	custom: () => true,
};

function checkSignature(def: Record<string, any>): string | undefined {
	if (typeof def.check !== "string") return undefined;
	if (def.check === "string_format") {
		const format = String(def.format ?? "");
		return CONSTRAINT_STRING_FORMATS.has(format)
			? `string_format:${format}`
			: "string_format:primary";
	}
	return def.check;
}

function occupiedCheckSignatures(def: Record<string, any>): Set<string> {
	const occupied = new Set<string>();
	if (typeof def.format === "string") occupied.add("string_format:primary");
	for (const check of def.checks ?? []) {
		const signature = checkSignature(getZodDef(check) ?? {});
		if (signature) occupied.add(signature);
	}
	return occupied;
}

/**
 * Cross-constraint satisfiability: an exact-signature match is already
 * skipped by `occupiedCheckSignatures`, but a source bound can also
 * CONFLICT with a different target bound — e.g. transferring max_length(8)
 * from a varchar(8) column onto z.string().min(10) builds min(10).max(8),
 * which rejects every possible value. Such source checks are dropped;
 * the target's (user-written) constraints win.
 *
 * Bound field varies by check kind (zod 4): min_length → `minimum`,
 * max_length → `maximum`, length_equals → `length`, numeric bounds → `value`.
 */
function boundOf(def: Record<string, any>): number {
	if (def.check === "min_length") return Number(def.minimum);
	if (def.check === "max_length") return Number(def.maximum);
	if (def.check === "length_equals") return Number(def.length);
	return Number(def.value);
}

function collectBounds(def: Record<string, any>) {
	const bounds = {
		minLength: null as number | null,
		maxLength: null as number | null,
		lengthEquals: null as number | null,
		greaterThan: null as number | null,
		lessThan: null as number | null,
	};
	for (const check of def.checks ?? []) {
		const d = getZodDef(check) ?? {};
		const value = boundOf(d);
		if (!Number.isFinite(value)) continue;
		if (d.check === "min_length")
			bounds.minLength = Math.max(bounds.minLength ?? -Infinity, value);
		else if (d.check === "max_length")
			bounds.maxLength = Math.min(bounds.maxLength ?? Infinity, value);
		else if (d.check === "length_equals") bounds.lengthEquals = value;
		else if (d.check === "greater_than")
			bounds.greaterThan = Math.max(bounds.greaterThan ?? -Infinity, value);
		else if (d.check === "less_than")
			bounds.lessThan = Math.min(bounds.lessThan ?? Infinity, value);
	}
	return bounds;
}

function conflictsWithTarget(
	checkDef: Record<string, any>,
	targetDef: Record<string, any>,
): boolean {
	const kind = checkDef.check;
	const value = boundOf(checkDef);
	if (!Number.isFinite(value)) return false;
	const b = collectBounds(targetDef);
	if (kind === "min_length") {
		return value > (b.maxLength ?? b.lengthEquals ?? Infinity);
	}
	if (kind === "max_length") {
		return value < (b.minLength ?? b.lengthEquals ?? 0);
	}
	if (kind === "length_equals") {
		return value < (b.minLength ?? 0) || value > (b.maxLength ?? Infinity);
	}
	if (kind === "greater_than") {
		return b.lessThan !== null && value >= b.lessThan;
	}
	if (kind === "less_than") {
		return b.greaterThan !== null && value <= b.greaterThan;
	}
	return false;
}

export function transferChecks(
	source: z.ZodType,
	target: z.ZodType,
	options?: AsOptions,
): z.ZodType {
	if (options?.transferChecks === false) return target;
	const sourceDef = getZodDef(source);
	const targetDef = getZodDef(target);
	if (!sourceDef || !targetDef || !Array.isArray(sourceDef.checks)) {
		return target;
	}

	const targetType = String(targetDef.type);
	const occupied = occupiedCheckSignatures(targetDef);
	let result: any = target;
	for (const check of sourceDef.checks) {
		const checkDef = getZodDef(check);
		if (!checkDef || typeof checkDef.check !== "string") continue;

		const compatibility = CHECK_CORE_COMPAT[checkDef.check];
		if (!compatibility) {
			throw new DrizzleValidatorsError(
				`Unknown Zod check type "${checkDef.check}" encountered during check transfer. ` +
					`Pass { transferChecks: false } to .as() to skip inherited checks.`,
			);
		}
		if (
			!compatibility(targetType) ||
			(checkDef.check === "custom" && sourceDef.type !== targetDef.type)
		) {
			continue;
		}

		const signature = checkSignature(checkDef);
		if (signature && occupied.has(signature)) continue;
		if (conflictsWithTarget(checkDef, targetDef)) continue;
		const cloned = cloneZodCheck(check);
		if (typeof result.check === "function") result = result.check(cloned);
	}
	return result;
}

function setErrorOnField(field: z.ZodTypeAny, error: string): z.ZodTypeAny {
	const def = getZodDef(field);
	if (!def) {
		throw new DrizzleValidatorsError(
			"Cannot set an error on a schema without a Zod definition.",
		);
	}
	const checks = Array.isArray(def.checks)
		? def.checks.map((check: unknown) => cloneZodCheck(check, error))
		: undefined;
	const innerType = def.innerType
		? setErrorOnField(def.innerType, error)
		: undefined;
	// def.element is deliberately NOT recursed: it is an array/tuple's ITEM
	// schema, not a wrapper. Propagating the message there would report the
	// field's custom error for element-level failures (e.g. tags: [123]
	// blaming "At least one tag required") — items keep their own messages.
	const overrides: Record<string, unknown> = {
		error: () => error,
		...(checks ? { checks } : {}),
		...(innerType ? { innerType } : {}),
	};
	return cloneSchemaWithDef(field, overrides, "error override");
}

type DeepUnwrap<T extends z.ZodTypeAny> =
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

export type PreserveWrapper<
	TOriginal extends z.ZodTypeAny,
	TNewCore extends z.ZodTypeAny,
> =
	TOriginal extends z.ZodOptional<infer Inner extends z.ZodTypeAny>
		? z.ZodOptional<PreserveWrapper<Inner, TNewCore>>
		: TOriginal extends z.ZodNullable<infer Inner extends z.ZodTypeAny>
			? z.ZodNullable<PreserveWrapper<Inner, TNewCore>>
			: TOriginal extends z.ZodDefault<infer Inner extends z.ZodTypeAny>
				? z.ZodDefault<PreserveWrapper<Inner, TNewCore>>
				: TOriginal extends z.ZodCatch<infer Inner extends z.ZodTypeAny>
					? z.ZodCatch<PreserveWrapper<Inner, TNewCore>>
					: TOriginal extends z.ZodReadonly<infer Inner extends z.ZodTypeAny>
						? z.ZodReadonly<PreserveWrapper<Inner, TNewCore>>
						: TNewCore;

type RemoveOptional<T extends z.ZodTypeAny> =
	T extends z.ZodOptional<infer Inner extends z.ZodTypeAny>
		? RemoveOptional<Inner>
		: T;

type RemoveNullable<T extends z.ZodTypeAny> =
	T extends z.ZodNullable<infer Inner extends z.ZodTypeAny>
		? RemoveNullable<Inner>
		: T;

export type RefinedField<
	T extends z.ZodTypeAny,
	TOriginalWrapper extends z.ZodTypeAny = T,
> = T & {
	readonly [REFINED_FIELD_BRAND]: TOriginalWrapper;
	as<U extends z.ZodTypeAny>(
		newCoreSchema: U,
		options?: AsOptions,
	): RefinedField<U, PreserveWrapper<TOriginalWrapper, DeepUnwrap<U>>>;
	setError(message: string): RefinedField<T, TOriginalWrapper>;
	withError(message: string): RefinedField<T, TOriginalWrapper>;
	unwrap(): RefinedField<DeepUnwrap<T>, DeepUnwrap<TOriginalWrapper>>;
	required(): RefinedField<T, RemoveOptional<TOriginalWrapper>>;
	nonnullable(): RefinedField<T, RemoveNullable<TOriginalWrapper>>;
};

export type RefinableShape<T extends Record<string, z.ZodTypeAny>> = {
	[K in keyof T]: RefinedField<DeepUnwrap<T[K]>, T[K]>;
};

export type RefinementCallbackResult<
	TShape extends Record<string, z.ZodTypeAny>,
> = {
	// No index-signature member here: during inference, its ZodTypeAny
	// candidate unions into R for context-sensitive callbacks (unannotated
	// `fields` param), which defers FieldErrorMapForCore's conditional and
	// breaks the per-core-type error-map key checks. Callback-ADDED fields
	// still typecheck — the fresh return literal is checked against the
	// The optional mapped member must NOT carry an index signature: during
	// inference its ZodTypeAny candidate unions into R for context-sensitive
	// callbacks (unannotated `fields` param) and defers the per-core-type
	// error-map conditional. Callback-ADDED fields still typecheck — the
	// fresh return literal is checked against the generic R, where excess
	// properties are allowed.
	[K in keyof TShape]?: z.ZodTypeAny;
} & {
	// ...but added fields DO need the index member for the CONSTRAINT check
	// (without it, returning only new fields trips weak-type detection).
	// The ZodTypeAny it contributes to R is sanitized per-key by
	// ResolveRefinedField.
	[key: string]: z.ZodTypeAny | undefined;
};

type ResolveRefinedField<TOriginal, TReturned> =
	// TReturned can be a union polluted by RefinementCallbackResult's
	// index-signature fallback (context-sensitive callbacks infer R as
	// `constraint | literal`). Slice out the informative members first.
	Extract<
		TReturned,
		{ readonly [REFINED_FIELD_BRAND]: unknown }
	> extends infer TBranded
		? TBranded extends {
				readonly [REFINED_FIELD_BRAND]: infer TWrapper extends z.ZodTypeAny;
			}
			? TBranded extends RefinedField<infer TCore extends z.ZodTypeAny, any>
				? PreserveWrapper<TWrapper, DeepUnwrap<TCore>>
				: TBranded
			: // No branded member: either the field is untouched (only the
				// constraint's ZodTypeAny|undefined fallback) or the callback
				// returned a plain schema preserving TOriginal's type.
				Extract<TReturned, TOriginal> extends never
				? Exclude<TReturned, undefined> extends z.ZodTypeAny
					? Exclude<TReturned, undefined>
					: TOriginal
				: TOriginal
		: TOriginal;

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

export type FieldErrorMapForCore<TCore extends z.ZodTypeAny> = [TCore] extends [
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
								: AnyCoreErrorKeys;

export type FieldErrorEntry<TField extends z.ZodTypeAny> =
	| ErrorMessage
	| FieldErrorMapForCore<DeepUnwrap<TField>>;

export type SchemaErrorMap<TShape extends Record<string, z.ZodTypeAny>> = {
	[K in keyof TShape]?: FieldErrorEntry<TShape[K]>;
};

/**
 * The 3-arg error map is deliberately keyed loosely. Typing it against the
 * POST-refinement shape is impossible: for context-sensitive callbacks
 * (unannotated `fields` param — the dominant usage) TS fixes the return
 * type parameter to its constraint BEFORE the map argument is checked, so
 * every per-core dispatch defers and ALL object maps get rejected.
 * Per-core strictness lives where TS can resolve it: the 2-arg
 * `refineZSchema(schema, map)` form (SchemaErrorMap above). Unknown field
 * names here are caught at RUNTIME by applyErrorMapToShape, which throws
 * with the known-field list.
 */
export type SchemaErrorMapLoose = {
	[key: string]: ErrorMessage | AnyCoreErrorKeys | undefined;
};

function unwrapProxy<T>(value: T): T {
	if (!value || typeof value !== "object") return value;
	const raw = Reflect.get(value as object, UNWRAP_PROXY);
	return (raw && raw !== value ? unwrapProxy(raw) : value) as T;
}

function wrapFieldProxy(
	field: z.ZodTypeAny,
	explicitState?: { core: z.ZodTypeAny; wrappers: WrapperDef[] },
): RefinedField<any> {
	const target = unwrapProxy(field);
	const state = explicitState ?? unwrapAll(target);
	return new Proxy(target, {
		has(current, prop) {
			return (
				prop === UNWRAP_PROXY ||
				prop === REFINED_FIELD_BRAND ||
				prop === "as" ||
				prop === "setError" ||
				prop === "withError" ||
				prop === "unwrap" ||
				prop === "required" ||
				prop === "nonnullable" ||
				prop in current ||
				prop in state.core
			);
		},
		get(current, prop, receiver) {
			if (prop === UNWRAP_PROXY) return current;
			if (prop === REFINED_FIELD_BRAND) return state.wrappers;

			if (prop === "as") {
				return (newCore: z.ZodTypeAny, options?: AsOptions) => {
					const rawCore = unwrapProxy(newCore);
					if (!isZodSchema(rawCore)) {
						throw new DrizzleValidatorsError(
							`.as() expects a valid Zod schema, got ${typeof newCore}.`,
						);
					}
					const mergedCore = transferChecks(state.core, rawCore, options);
					return wrapFieldProxy(applyWrappers(mergedCore, state.wrappers), {
						core: mergedCore,
						wrappers: state.wrappers,
					});
				};
			}

			if (prop === "setError" || prop === "withError") {
				return (message: string) =>
					wrapFieldProxy(setErrorOnField(current, message));
			}
			if (prop === "unwrap") {
				return () =>
					wrapFieldProxy(state.core, { core: state.core, wrappers: [] });
			}
			if (prop === "required" || prop === "nonnullable") {
				return () => {
					const wrappers = state.wrappers.filter((wrapper) =>
						prop === "required"
							? wrapper.type !== "optional" && wrapper.type !== "exactOptional"
							: wrapper.type !== "nullable",
					);
					const nextCore = applyWrappers(state.core, wrappers);
					return wrapFieldProxy(nextCore, { core: state.core, wrappers });
				};
			}

			if (
				typeof prop === "string" &&
				(prop === "optional" ||
					prop === "exactOptional" ||
					prop === "nullable" ||
					prop === "default" ||
					prop === "catch" ||
					prop === "readonly")
			) {
				const method = Reflect.get(current, prop, receiver);
				if (typeof method === "function") {
					return (...args: unknown[]) => {
						const result = (method as (...args: unknown[]) => unknown).apply(
							current,
							args,
						);
						return isZodSchema(result) ? wrapFieldProxy(result) : result;
					};
				}
			}

			if (
				typeof prop === "string" &&
				!prop.startsWith("_") &&
				typeof (state.core as any)[prop] === "function"
			) {
				return (...args: unknown[]) => {
					const result = (state.core as any)[prop](...args);
					if (!isZodSchema(result)) return result;
					const next = applyWrappers(result, state.wrappers);
					return wrapFieldProxy(next, {
						core: result,
						wrappers: state.wrappers,
					});
				};
			}

			const value = Reflect.get(current, prop, receiver);
			return typeof value === "function" ? value.bind(current) : value;
		},
	}) as RefinedField<any>;
}

function createLazyShapeProxy(
	shape: Record<string, z.ZodTypeAny>,
): Record<string, z.ZodTypeAny> {
	const cache = new Map<string, z.ZodTypeAny>();
	return new Proxy(shape, {
		get(target, prop, receiver) {
			if (typeof prop !== "string" || !(prop in target)) {
				return Reflect.get(target, prop, receiver);
			}
			let field = cache.get(prop);
			if (!field) {
				const source = target[prop];
				if (!source) {
					throw new DrizzleValidatorsError(
						`Unable to read schema field "${prop}".`,
					);
				}
				const proxied = wrapFieldProxy(source);
				field = proxied;
				cache.set(prop, proxied);
			}
			return field;
		},
	});
}

/**
 * Applies a declarative error map to a shape in place (mutates the caller's
 * `shape` object only — never any shared schema definition).
 */
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
 * Refines a Zod object with custom field rules, wrapper-preserving `.as()`
 * swaps, and/or a declarative fallback `errorMap`.
 *
 * The `errorMap` is a per-field stylesheet of default messages. It only fills
 * gaps where no inline error was authored (`.min(n, { error })`, `z.x({ error })`,
 * `.setError()`), and it never changes parse outcomes or inferred types.
 */
export function refineZSchema<
	T extends z.ZodObject<any>,
	R extends RefinementCallbackResult<T["shape"]>,
>(
	baseSchema: T,
	refinementFn: (fields: RefinableShape<T["shape"]>) => R,
): z.ZodObject<RefinedShape<T["shape"], R>>;

export function refineZSchema<
	T extends z.ZodObject<any>,
	R extends RefinementCallbackResult<T["shape"]>,
>(
	baseSchema: T,
	refinementFn: (fields: RefinableShape<T["shape"]>) => R,
	errorMap: SchemaErrorMapLoose,
): z.ZodObject<RefinedShape<T["shape"], R>>;

export function refineZSchema<T extends z.ZodObject<any>>(
	baseSchema: T,
	errorMap: SchemaErrorMap<T["shape"]>,
): z.ZodObject<T["shape"]>;

export function refineZSchema(
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
				"refineZSchema callback must return an object mapping field names to schemas.",
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
				"refineZSchema: the refinement callback must come before the error map: refineZSchema(schema, callback, errorMap).",
			);
		}
		errorMap = second;
	} else {
		throw new DrizzleValidatorsError(
			"refineZSchema expects a refinement callback function or an error map object as its second argument.",
		);
	}

	if (errorMap !== undefined) {
		if (!isPlainObject(errorMap)) {
			throw new DrizzleValidatorsError(
				"refineZSchema errorMap must be a plain object mapping field names to error messages.",
			);
		}
		applyErrorMapToShape(nextShape, errorMap);
	}

	return rebuildZodObject(baseSchema, nextShape);
}
