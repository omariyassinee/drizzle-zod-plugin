import type { z } from "zod";
import { STRING_FORMAT_NAMES, type StringFormat } from "./constants";
import { DrizzleValidatorsError } from "./errors";
import { resolveStringFormatName } from "./format-names";
import { FORMAT_PARENT, SPECIFIC_FORMAT_KEYS } from "./predictions/core";
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

/**
 * Fallback key set when the core type is unknown AT TYPE-CHECK TIME. This
 * happens for every 3-arg `refineZSchema(schema, callback, errorMap)` call
 * whose callback is context-sensitive (unannotated `fields` param): TS
 * fixes the callback's return type parameter to its constraint before the
 * error-map argument is checked, so the per-core dispatch cannot resolve.
 * The fallback therefore carries ALL documented keys — per-core strictness
 * stays enforced where TS can resolve the core: the 2-arg map form and
 * non-context-sensitive callbacks. This is a TS inference limitation, not
 * a runtime one — the engine below still only applies keys that exist.
 */
export type AnyCoreErrorKeys = CommonErrorKeys &
	SizedBoundErrorKeys &
	BoundErrorKeys &
	StringFormatErrorKeys & {
		format?: ErrorMessage<StringFormatIssue>;
		invalid_format?: ErrorMessage<StringFormatIssue>;
		regex?: ErrorMessage<StringFormatIssue>;
		starts_with?: ErrorMessage<StringFormatIssue>;
		ends_with?: ErrorMessage<StringFormatIssue>;
		includes?: ErrorMessage<StringFormatIssue>;
		int?: ErrorMessage<InvalidTypeIssue | TooSmallIssue | TooBigIssue>;
		multiple_of?: ErrorMessage<NotMultipleOfIssue>;
		not_multiple_of?: ErrorMessage<NotMultipleOfIssue>;
		invalid_value?: ErrorMessage<InvalidValueIssue>;
		invalid_union?: ErrorMessage;
		unrecognized_keys?: ErrorMessage;
	};

// ───────────────────────── Runtime Engine ─────────────────────────

/**
 * Symbol attached to every fallback error function installed by `error-map.ts`.
 * Stores the frozen NormalizedMap so:
 *  1. `isAuthoredError` can distinguish user-authored inline errors from
 *     fallback maps installed by this module.
 *  2. Multi-stage `refineZSchema` calls can cascade `{ ...prevMap, ...nextMap }`
 *     per key, so a later layer restyles an earlier one without erasing keys
 *     the later layer did not mention.
 */
export const MAP_ERROR = Symbol.for("drizzle-validators.error-map");

export type NormalizedMap = Readonly<
	Record<string, ErrorMessage<any> | undefined>
>;

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


/** Keys that only ever fire on the core schema def, never on an attached check. */
const CORE_ONLY_KEYS: ReadonlySet<string> = new Set<string>([
	"required",
	"null",
	"invalid_type",
	"invalid_value",
	"unrecognized_keys",
	"invalid_union",
]);

export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
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

export interface SiteMeta {
	readonly isCheck: boolean;
	readonly intCheck: boolean;
	readonly sizedOrigin: boolean;
	readonly formatName: string | undefined;
}

export function siteOf(def: InternalZodDef, isCheck: boolean): SiteMeta {
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

export function candidateKeys(issue: Record<string, any>, site: SiteMeta): string[] {
	// Non-integer numbers on .int() or z.int() emit code: "invalid_type" with
	// format: "safeint" — they are numbers, so they must resolve `int`, never
	// `invalid_type` (finding #5 in the final plan).
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
			if (issue.input === undefined) return ["required", "invalid_type"];
			if (issue.input === null) return ["null", "invalid_type"];
			return ["invalid_value", "invalid_type"];

		case "too_small":
			if (issue.exact) return ["length", "too_small"];
			return site.sizedOrigin ||
				issue.origin === "string" ||
				issue.origin === "array" ||
				issue.origin === "set"
				? ["min_length", "min", "too_small"]
				: ["min", "too_small"];

		case "too_big":
			if (issue.exact) return ["length", "too_big"];
			return site.sizedOrigin ||
				issue.origin === "string" ||
				issue.origin === "array" ||
				issue.origin === "set"
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

function makeFallbackHandler(
	map: NormalizedMap,
	site: SiteMeta,
): FallbackHandler {
	const handler: FallbackHandler = (issue: Record<string, any>) => {
		// In Zod 4.6+, core def.error is also invoked as a fallback for check
		// issues. Check issues are already handled by their own check-level
		// handler; if a check had an authored error or intentionally fell
		// through to Zod's native message, the core handler must not
		// intercept it.
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

/** Candidate map keys for a check kind, mirroring `candidateKeys` dispatch. */
function checkCandidateKeys(checkDef: InternalZodDef): string[] {
	const site = siteOf(checkDef, true);
	switch (checkDef.check) {
		case "min_length":
			return ["min_length", "min", "too_small"];
		case "max_length":
			return ["max_length", "max", "too_big"];
		case "length_equals":
			return ["length", "too_small", "too_big"];
		case "greater_than":
			return ["min", "too_small"];
		case "less_than":
			return ["max", "too_big"];
		case "multiple_of":
			return ["multiple_of", "not_multiple_of"];
		case "number_format":
			return site.intCheck ? ["int"] : [];
		case "string_format": {
			const rawFormat = site.formatName ?? String(checkDef.format ?? "");
			const keys: string[] = [];
			if (SPECIFIC_FORMAT_KEYS.has(rawFormat)) {
				keys.push(rawFormat);
				const parent = FORMAT_PARENT[rawFormat];
				if (parent) keys.push(parent);
			}
			keys.push("format", "invalid_format");
			return keys;
		}
		case "custom":
			return ["custom"];
		default:
			return [];
	}
}

/** True when the map has any key that could apply to the given check kind. */
function hasAnyCheckKey(map: NormalizedMap, checkDef: InternalZodDef): boolean {
	if (map.default !== undefined) return true;
	const keys = checkCandidateKeys(checkDef);
	return keys.some((key) => map[key] !== undefined);
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
				isAuthoredError(checkDef) ||
				!hasAnyCheckKey(entry, checkDef)
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
