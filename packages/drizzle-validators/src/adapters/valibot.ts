import { MAX_RECURSION_DEPTH } from "../constants";
import { DrizzleValidatorsError } from "../errors";
import type {
	EmitContext,
	SchemaCreators,
	SerializerAdapter,
} from "./types";
import { DEPENDENCY_PACKAGES } from "./types";

/**
 * Valibot adapter.
 *
 * Spike findings (verified against drizzle-orm@1.0.0-rc.4 + valibot@1.5.0):
 *  - `drizzle-orm/valibot` hands back REAL valibot schema instances — plain
 *    objects with a `type` discriminator, `wrapped` for wrappers
 *    (optional/nullable), `pipe` = [baseSchema, ...actions] for constraints,
 *    `entries` for objects, `item` for arrays, `enum`/`options` for enums,
 *    `key`/`value` for records.
 *  - drizzle does NOT attach default values (`default` is always undefined).
 *  - Buffer columns surface as `unknown` — no Node-only globals; an
 *    `instance` schema only appears via custom schema factories and is
 *    handled through the bufferAs policy (P2-02 parity).
 *
 * Emission rebuilds equivalent `v.*` code: wrappers via v.optional/v.nullable/
 * v.nullish/v.exactOptional, constraints via v.pipe + v.<action>() entries.
 */

/** Schema `type` values emitted as plain `v.<builder>()` calls. */
const PLAIN_TYPES: Record<string, string> = {
	string: "v.string()",
	number: "v.number()",
	boolean: "v.boolean()",
	date: "v.date()",
	bigint: "v.bigint()",
	symbol: "v.symbol()",
	null: "v.null()",
	undefined: "v.undefined()",
	any: "v.any()",
	unknown: "v.unknown()",
	never: "v.never()",
};

/** Wrapper `type` values emitted as `v.<wrapper>(inner[, default])`. */
const WRAPPER_TYPES: Record<string, string> = {
	optional: "v.optional",
	nullable: "v.nullable",
	nullish: "v.nullish",
	exact_optional: "v.exactOptional",
	readonly: "v.readonly",
};

function indent(depth: number): string {
	return "  ".repeat(depth);
}

function serializeRequirement(value: unknown): string {
	if (typeof value === "bigint") return `${value}n`;
	if (value instanceof Date) {
		return `new Date(${JSON.stringify(value.toISOString())})`;
	}
	if (value instanceof RegExp) return String(value);
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "Number.NaN";
		if (value === Number.POSITIVE_INFINITY) return "Number.POSITIVE_INFINITY";
		if (value === Number.NEGATIVE_INFINITY) return "Number.NEGATIVE_INFINITY";
	}
	if (typeof value === "string") return JSON.stringify(value);
	if (value === null || typeof value === "boolean" || typeof value === "number") {
		return String(value);
	}
	throw new DrizzleValidatorsError(
		`Cannot serialize requirement value (${typeof value}) for the valibot target.`,
	);
}

function failUnrecognized(nodeType: string, detail: string, depth: number): never {
	throw new DrizzleValidatorsError(
		`Unserializable valibot schema node (depth ${depth}): ` +
			`type "${nodeType}" — ${detail}. This usually means a column type (or a custom ` +
			`schema factory) produced a shape the valibot serializer does not know yet — ` +
			`please open an issue with the column definition.`,
	);
}

/**
 * Heuristic Buffer detection for `custom` predicate nodes: the predicate
 * must accept a Buffer instance while rejecting a string and a plain
 * object. Accept-everything predicates fail the negative probes, so they
 * fall through to the generic custom failure instead of being mistaken
 * for Buffer columns.
 */
function isBufferCheck(check: unknown): boolean {
	if (typeof check !== "function") return false;
	try {
		return (
			check(Buffer.alloc(0)) === true &&
			check("") === false &&
			check({}) === false
		);
	} catch {
		return false;
	}
}

function emitActions(node: any, depth: number): string[] {
	if (!Array.isArray(node.pipe)) return [];
	const actions: string[] = [];
	for (const entry of node.pipe) {
		// pipe = [baseSchema, ...actions]; base entries have kind "schema".
		if (!entry || entry.kind === "schema") continue;
		if (entry.kind === "metadata") continue; // carries no validation
		switch (entry.type) {
			case "min_value":
				actions.push(`v.minValue(${serializeRequirement(entry.requirement)})`);
				break;
			case "max_value":
				actions.push(`v.maxValue(${serializeRequirement(entry.requirement)})`);
				break;
			case "min_length":
				actions.push(`v.minLength(${serializeRequirement(entry.requirement)})`);
				break;
			case "max_length":
				actions.push(`v.maxLength(${serializeRequirement(entry.requirement)})`);
				break;
			case "length":
				actions.push(`v.length(${serializeRequirement(entry.requirement)})`);
				break;
			case "integer":
				actions.push("v.integer()");
				break;
			case "uuid":
				actions.push("v.uuid()");
				break;
			case "email":
				actions.push("v.email()");
				break;
			case "url":
				actions.push("v.url()");
				break;
			case "ipv4":
				actions.push("v.ipv4()");
				break;
			case "ipv6":
				actions.push("v.ipv6()");
				break;
			case "regex":
				actions.push(`v.regex(${serializeRequirement(entry.requirement)})`);
				break;
			case "value":
				actions.push(`v.value(${serializeRequirement(entry.requirement)})`);
				break;
			default:
				failUnrecognized(
					String(entry.type),
					`unsupported pipe action (kind "${String(entry.kind)}")`,
					depth,
				);
		}
	}
	return actions;
}

/** Wraps emitted base code in v.pipe(...) when the node carries actions. */
function withPipe(node: any, base: string, depth: number): string {
	const actions = emitActions(node, depth);
	if (actions.length === 0) return base;
	return `v.pipe(${[base, ...actions].join(", ")})`;
}

function emitNode(node: unknown, ctx: EmitContext, depth: number): string {
	if (depth > MAX_RECURSION_DEPTH) {
		throw new DrizzleValidatorsError(
			`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded in the valibot serializer. ` +
				`Your schema may contain cyclic references or be excessively deeply nested.`,
		);
	}
	if (node === undefined || node === null || typeof node !== "object") {
		throw new DrizzleValidatorsError(
			`Unserializable valibot schema node (depth ${depth}): ` +
				`expected a schema object, got ${node === null ? "null" : typeof node}.`,
		);
	}
	const raw = node as any;
	const nodeType = String(raw.type);

	// P2-02 parity: Buffer instances cannot be referenced from client-safe
	// generated code. (drizzle's valibot entry never emits these; they only
	// arrive through custom schema factories.)
	if (nodeType === "instance") {
		const ctorName = raw.class?.name;
		if (ctx.bufferAs === "throw") {
			throw new DrizzleValidatorsError(
				`A column serializes to a Node-only instance schema (v.instance(${ctorName ?? "?"})), which ` +
					`cannot be emitted into client-safe generated code (finding P2-02). Either exclude this ` +
					`table, use a string/base64 blob mode, or set bufferAs: "keep" to emit it deliberately.`,
			);
		}
		return `v.instance(${ctorName ?? "Object"})`;
	}

	// drizzle-orm rc.5+ emits Buffer columns (blob({ mode: "buffer" })) as
	// `custom` nodes carrying a predicate — probe it so the P2-02 policy
	// applies exactly as it does for instance nodes.
	if (nodeType === "custom" && isBufferCheck(raw.check)) {
		if (ctx.bufferAs === "throw") {
			throw new DrizzleValidatorsError(
				`A column serializes to a Node-only Buffer validator (v.instance(Buffer)), which ` +
					`is a Node-only global in a client-safe module (finding P2-02); browser bundles crash with ` +
					`ReferenceError: Buffer is not defined at import time. Either exclude this table, use a ` +
					`string/base64 blob mode, or pass bufferAs: "keep" to emit it deliberately.`,
			);
		}
		return "v.instance(Buffer)";
	}

	// --- wrappers -----------------------------------------------------------
	const wrapper = WRAPPER_TYPES[nodeType];
	if (wrapper) {
		if (raw.wrapped === undefined) {
			failUnrecognized(nodeType, "wrapper without a wrapped schema", depth);
		}
		const inner = emitNode(raw.wrapped, ctx, depth + 1);
		// drizzle's valibot entry never sets `default`, but a custom factory
		// may — pass it through as the wrapper's default argument.
		if ("default" in raw && raw.default !== undefined) {
			return `${wrapper}(${inner}, ${serializeRequirement(raw.default)})`;
		}
		return `${wrapper}(${inner})`;
	}

	// --- containers -----------------------------------------------------------
	switch (nodeType) {
		case "object":
		case "loose_object":
		case "strict_object": {
			const builder =
				nodeType === "object"
					? "v.object"
					: nodeType === "loose_object"
						? "v.looseObject"
						: "v.strictObject";
			const entries = (raw.entries ?? {}) as Record<string, unknown>;
			const body = Object.entries(entries)
				.map(
					([k, v]) =>
						`${indent(depth + 1)}${JSON.stringify(k)}: ${emitNode(v, ctx, depth + 1)}`,
				)
				.join(",\n");
			return body
				? `${builder}({\n${body}\n${indent(depth)}})`
				: `${builder}({})`;
		}
		case "array":
			if (raw.item === undefined) {
				failUnrecognized(nodeType, "array without an item schema", depth);
			}
			return withPipe(raw, `v.array(${emitNode(raw.item, ctx, depth + 1)})`, depth);
		case "record":
			if (raw.key === undefined || raw.value === undefined) {
				failUnrecognized(nodeType, "record without key/value schemas", depth);
			}
			return withPipe(
				raw,
				`v.record(${emitNode(raw.key, ctx, depth + 1)}, ${emitNode(raw.value, ctx, depth + 1)})`,
				depth,
			);
		case "union":
		case "intersect": {
			const options = raw.options as unknown[] | undefined;
			if (!Array.isArray(options) || options.length === 0) {
				failUnrecognized(nodeType, "union without options", depth);
			}
			const members = options.map((o) => emitNode(o, ctx, depth + 1));
			const base =
				nodeType === "union"
					? `v.union([${members.join(", ")}])`
					: `v.intersect([${members.join(", ")}])`;
			return withPipe(raw, base, depth);
		}
		case "enum":
		case "picklist": {
			const values =
				nodeType === "enum"
					? Object.values((raw.enum ?? {}) as Record<string, unknown>)
					: (raw.options as unknown[] | undefined);
			if (!Array.isArray(values) || values.length === 0) {
				failUnrecognized(nodeType, "no options", depth);
			}
			const serialized = values.map((v) => serializeRequirement(v));
			const base =
				nodeType === "enum"
					? `v.enum({ ${Object.keys(raw.enum ?? {})
							.map((k, i) => `${JSON.stringify(k)}: ${serialized[i]}`)
							.join(", ")} })`
					: `v.picklist([${serialized.join(", ")}])`;
			return withPipe(raw, base, depth);
		}
		case "literal":
			if (!("literal" in raw)) {
				failUnrecognized(nodeType, "literal without a value", depth);
			}
			return withPipe(raw, `v.literal(${serializeRequirement(raw.literal)})`, depth);
		default:
			break;
	}

	// --- plain leaves -----------------------------------------------------------
	const plain = PLAIN_TYPES[nodeType];
	if (plain) return withPipe(raw, plain, depth);

	failUnrecognized(nodeType, "unknown schema type", depth);
}

export const valibotAdapter: SerializerAdapter = {
	target: "valibot",
	importStatement: "import * as v from 'valibot'",
	dependencyPackages: DEPENDENCY_PACKAGES.valibot,
	refineExportStatement:
		"export { refineVSchema } from '@vacuus/drizzle-validators/refine/valibot'",
	refineDtsStatement:
		"export const refineVSchema: (typeof import('@vacuus/drizzle-validators/refine/valibot'))['refineVSchema']",

	async loadCreators(): Promise<SchemaCreators> {
		// Requires drizzle-orm >= the first release shipping ./valibot AND the
		// user's `valibot` package (drizzle's entry imports it). Both failures
		// surface through the generator's guarded actionable message.
		const mod = await import("drizzle-orm/valibot");
		return {
			createInsertSchema: mod.createInsertSchema,
			createSelectSchema: mod.createSelectSchema,
			createUpdateSchema: mod.createUpdateSchema,
		};
	},

	emit(schema: unknown, ctx: EmitContext): string {
		return emitNode(schema, ctx, ctx.depth);
	},
};
