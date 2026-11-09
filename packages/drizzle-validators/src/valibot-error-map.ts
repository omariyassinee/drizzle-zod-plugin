import * as v from "valibot";
import { DrizzleValidatorsError } from "./errors";
import { MAP_ERROR, isPlainObject, type ErrorMessage } from "./error-map";
import type { AnyValibotNode } from "./valibot-refine";
export { unwrapAllV } from "./valibot-refine";

// ───────────────────────── Public Types ─────────────────────────
//
// The key names deliberately mirror the Zod error-map vocabulary so a map
// literal is portable between refineZSchema and refineVSchema; the
// candidate-key dispatch below maps valibot's action/issue types onto them.

export type FieldErrorMapV = {
	required?: ErrorMessage;
	null?: ErrorMessage;
	invalid_type?: ErrorMessage;
	invalid_value?: ErrorMessage;
	invalid_union?: ErrorMessage;
	unrecognized_keys?: ErrorMessage;
	custom?: ErrorMessage;
	default?: ErrorMessage;
	min?: ErrorMessage;
	max?: ErrorMessage;
	too_small?: ErrorMessage;
	too_big?: ErrorMessage;
	min_length?: ErrorMessage;
	max_length?: ErrorMessage;
	length?: ErrorMessage;
	int?: ErrorMessage;
	integer?: ErrorMessage;
	multiple_of?: ErrorMessage;
	not_multiple_of?: ErrorMessage;
	min_value?: ErrorMessage;
	max_value?: ErrorMessage;
	gt_value?: ErrorMessage;
	lt_value?: ErrorMessage;
	value?: ErrorMessage;
	format?: ErrorMessage;
	invalid_format?: ErrorMessage;
	regex?: ErrorMessage;
	starts_with?: ErrorMessage;
	ends_with?: ErrorMessage;
	includes?: ErrorMessage;
	email?: ErrorMessage;
	uuid?: ErrorMessage;
	url?: ErrorMessage;
	ipv4?: ErrorMessage;
	ipv6?: ErrorMessage;
	iso_date?: ErrorMessage;
	iso_time?: ErrorMessage;
	iso_date_time?: ErrorMessage;
	iso_timestamp?: ErrorMessage;
	[K: string]: ErrorMessage | undefined;
};

// ───────────────────────── Runtime Engine ─────────────────────────

const VALID_MAP_KEYS: ReadonlySet<string> = new Set([
	"default",
	"required",
	"null",
	"invalid_type",
	"invalid_value",
	"invalid_union",
	"unrecognized_keys",
	"custom",
	"min",
	"max",
	"too_small",
	"too_big",
	"min_length",
	"max_length",
	"length",
	"int",
	"integer",
	"multiple_of",
	"not_multiple_of",
	"min_value",
	"max_value",
	"gt_value",
	"lt_value",
	"value",
	"format",
	"invalid_format",
	"regex",
	"starts_with",
	"ends_with",
	"includes",
	// string formats
	"email",
	"uuid",
	"url",
	"ipv4",
	"ipv6",
	"iso_date",
	"iso_time",
	"iso_date_time",
	"iso_timestamp",
	"base64",
	"credit_card",
	"decimal",
	"digits",
	"emoji",
	"hexadecimal",
	"hex_color",
	"octal",
	"slug",
	"ulid",
	"nanoid",
	"cuid2",
	"bic",
	"iban",
	"mac",
	"mac48",
	"mac64",
]);

/** Parent format fallback when a versioned format key is not set. */
const FORMAT_PARENT: Readonly<Record<string, string>> = {};

/** Keys that only ever fire on the core schema, never on a pipe action. */
const CORE_ONLY_KEYS: ReadonlySet<string> = new Set([
	"required",
	"null",
	"invalid_type",
	"invalid_value",
	"invalid_union",
	"unrecognized_keys",
]);

const SPECIFIC_FORMAT_ACTIONS: ReadonlySet<string> = new Set([
	"regex",
	"starts_with",
	"ends_with",
	"includes",
	"email",
	"uuid",
	"url",
	"ipv4",
	"ipv6",
	"iso_date",
	"iso_time",
	"iso_date_time",
	"iso_timestamp",
	"base64",
	"credit_card",
	"decimal",
	"digits",
	"emoji",
	"hexadecimal",
	"hex_color",
	"octal",
	"slug",
	"ulid",
	"nanoid",
	"cuid2",
	"bic",
	"iban",
	"mac",
	"mac48",
	"mac64",
]);

export function normalizeVEntry(entry: unknown, field: string): FieldErrorMapV {
	if (typeof entry === "string" || typeof entry === "function") {
		return { default: entry as ErrorMessage };
	}
	if (!isPlainObject(entry)) {
		throw new DrizzleValidatorsError(
			`Invalid error map entry for field "${field}": expected a string, a function, or a plain object of messages.`,
		);
	}
	const out: Record<string, ErrorMessage> = {};
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
		out[key] = value as ErrorMessage;
	}
	return out;
}

export function mapOfV(message: unknown): FieldErrorMapV | undefined {
	return typeof message === "function"
		? (message as { [MAP_ERROR]?: FieldErrorMapV })[MAP_ERROR]
		: undefined;
}

/** True when `node.message` carries an explicit user-authored error. */
export function isAuthoredVMessage(node: { message?: unknown }): boolean {
	if (typeof node.message === "function") {
		return mapOfV(node.message) === undefined;
	}
	return typeof node.message === "string";
}

/**
 * Candidate map keys for a valibot issue, mirroring the Zod dispatch:
 * specific keys first, general keys, then "default" (appended by the
 * evaluator). Schema-kind issues resolve required/null/invalid_type
 * variants; validation-kind issues resolve per-action keys.
 */
export function candidateVKeys(issue: {
	kind?: string;
	type?: string;
	input?: unknown;
}): string[] {
	if (issue.kind === "validation") {
		switch (issue.type) {
			case "min_length":
			case "non_empty":
				return ["min_length", "min", "too_small"];
			case "max_length":
				return ["max_length", "max", "too_big"];
			case "length":
				return ["length", "too_small", "too_big"];
			case "min_value":
			case "gt_value":
				return ["min", "too_small"];
			case "max_value":
			case "lt_value":
				return ["max", "too_big"];
			case "integer":
			case "safe_integer":
				return ["int"];
			case "multiple_of":
				return ["multiple_of", "not_multiple_of"];
			case "value":
				return ["value", "invalid_value"];
			case "check":
			case "raw_check":
			case "partial_check":
				return ["custom"];
			default:
				if (SPECIFIC_FORMAT_ACTIONS.has(issue.type ?? "")) {
					return [issue.type ?? "", "format", "invalid_format"];
				}
				return [];
		}
	}
	// schema-kind issues
	if (issue.input === undefined) return ["required", "invalid_type"];
	if (issue.input === null) return ["null", "invalid_type"];
	if (
		issue.type === "picklist" ||
		issue.type === "literal" ||
		issue.type === "enum" ||
		issue.type === "enum_"
	) {
		return ["invalid_value", "invalid_type"];
	}
	if (issue.type === "strict_object") return ["unrecognized_keys"];
	if (issue.type === "union" || issue.type === "variant") {
		return ["invalid_union", "invalid_type"];
	}
	return ["invalid_type"];
}

type VIssueLike = { message?: string; kind?: string };

function evaluateVCandidates(
	map: FieldErrorMapV,
	keys: string[],
	issue: VIssueLike,
): string | undefined {
	for (const key of [...keys, "default"]) {
		let entry = map[key];
		if (entry === undefined && key === "int") entry = map.integer;
		if (entry === undefined && key === "min") entry = map.min_value ?? map.gt_value;
		if (entry === undefined && key === "max") entry = map.max_value ?? map.lt_value;
		if (entry === undefined) continue;
		const resolved =
			typeof entry === "function" ? entry(issue as never) : entry;
		if (resolved !== undefined) return resolved;
	}
	return undefined;
}

function makeVFallbackHandler(
	map: FieldErrorMapV,
	isAction: boolean,
): (issue: VIssueLike) => string {
	const handler = (issue: VIssueLike): string => {
		// Core-level handlers must not intercept action-issue messages (the
		// action's own handler already ran); zod's engine has the same rule.
		if (!isAction && issue.kind === "validation") {
			return issue.message ?? "";
		}
		const keys = candidateVKeys(issue);
		return evaluateVCandidates(map, keys, issue) ?? issue.message ?? "";
	};
	Object.defineProperty(handler, MAP_ERROR, {
		value: map,
		enumerable: false,
		configurable: false,
	});
	return handler;
}

function touchesVChecks(map: FieldErrorMapV): boolean {
	for (const key of Object.keys(map)) {
		if (!CORE_ONLY_KEYS.has(key)) return true;
	}
	return false;
}

/**
 * Applies a normalized field error map to an unwrapped core valibot node.
 * Purely clone-based (C1 invariant): never mutates the core node or its
 * pipe actions. Valibot ASSIGNS the return of `node.message(issue)` to the
 * issue, so the fallback handler returns `issue.message` when the map has
 * nothing to say — preserving valibot's native text.
 */
export function applyErrorMapToCoreV(
	core: AnyValibotNode,
	entry: FieldErrorMapV,
	cloneNode: <T extends object>(
		node: T,
		overrides?: Record<string, unknown>,
	) => T,
): AnyValibotNode {
	if (Object.keys(entry).length === 0) return core;
	const def = core as Record<string, unknown>;
	const isPiped = Array.isArray(def.pipe) && def.pipe.length > 0;
	const actions: AnyValibotNode[] = isPiped
		? ((def.pipe as AnyValibotNode[]).slice(1) as AnyValibotNode[])
		: [];
	const base = isPiped ? (def.pipe as AnyValibotNode[])[0]! : core;

	let nextBase = base;
	if (!isAuthoredVMessage(base as { message?: unknown })) {
		// Multi-stage cascade: merge over a map a previous refineVSchema
		// stage installed, so a later layer restyles keys it mentions
		// without erasing the ones it does not.
		const prev = mapOfV((base as { message?: unknown }).message);
		nextBase = cloneNode(base as object, {
			message: makeVFallbackHandler(
				prev ? { ...prev, ...entry } : entry,
				false,
			),
		}) as AnyValibotNode;
	}

	let nextActions = actions;
	if (touchesVChecks(entry) && actions.length > 0) {
		nextActions = actions.map((action) => {
			if (
				!isAuthoredVMessage(action as { message?: unknown }) &&
				action.type !== "metadata"
			) {
				const prev = mapOfV((action as { message?: unknown }).message);
				return cloneNode(action as object, {
					message: makeVFallbackHandler(
						prev ? { ...prev, ...entry } : entry,
						true,
					),
				}) as AnyValibotNode;
			}
			return action;
		});
	}

	if (!isPiped) return nextBase;
	// Rebuild through the REAL v.pipe: valibot's pipe runner closes over
	// its arguments array, so replacing the `pipe` property on a clone is
	// silently ignored — only a fresh v.pipe() binds the new actions.
	if (nextActions.length === 0) return nextBase as AnyValibotNode;
	return v.pipe(nextBase as never, ...(nextActions as never[])) as never;
}

type VObjectFieldMaps = Record<string, FieldErrorMapV>;

/**
 * Object-level handler for issues valibot routes through the OBJECT node
 * rather than the field: missing-key `required` issues are created by the
 * object's own ~run (`_addIssue(this, "key", ...)`), so a per-field map
 * needs a field-aware dispatch on the rebuilt object, selecting the field
 * map via issue.path[0].key. Tagged with MAP_ERROR (field maps) so
 * multi-stage refineVSchema calls cascade per field.
 */
export function makeVObjectHandler(
	fieldMaps: VObjectFieldMaps,
): (issue: VIssueLike & { path?: Array<{ key?: PropertyKey }> }) => string {
	const handler = (
		issue: VIssueLike & { path?: Array<{ key?: PropertyKey }> },
	): string => {
		if (issue.kind === "validation") return issue.message ?? "";
		const key = issue.path?.[0]?.key;
		const map = typeof key === "string" ? fieldMaps[key] : undefined;
		if (!map) return issue.message ?? "";
		return (
			evaluateVCandidates(map, candidateVKeys(issue), issue) ??
			issue.message ??
			""
		);
	};
	Object.defineProperty(handler, MAP_ERROR, {
		value: fieldMaps,
		enumerable: false,
		configurable: false,
	});
	return handler;
}

/** Extracts an object handler's installed field maps, if any. */
export function objectFieldMapsOf(
	message: unknown,
): VObjectFieldMaps | undefined {
	return typeof message === "function"
		? ((message as { [MAP_ERROR]?: VObjectFieldMaps })[MAP_ERROR] as
				| VObjectFieldMaps
				| undefined)
		: undefined;
}
