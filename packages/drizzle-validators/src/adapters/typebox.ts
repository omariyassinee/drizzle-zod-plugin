import { MAX_RECURSION_DEPTH } from "../constants";
import { DrizzleValidatorsError } from "../errors";
import type {
	EmitContext,
	SchemaCreators,
	SerializerAdapter,
} from "./types";
import { DEPENDENCY_PACKAGES } from "./types";

/**
 * TypeBox adapter.
 *
 * Spike finding (verified against drizzle-orm@1.0.0-rc.4 + typebox@1.1.0):
 * the CURRENT `drizzle-orm/typebox` entry point does NOT hand back TypeBox
 * TSchema instances — it builds PLAIN JSON Schema objects (no `[Kind]`
 * symbols at all; even buffer-mode blob columns surface as `{}`/Any). The
 * emitter therefore maps JSON Schema structure -> `t.*` builder calls,
 * which is stable across typebox 0.34+ and 1.x because only core builders
 * are used (Object/String/Integer/Number/Boolean/Null/Literal/Union/Array/
 * Record/Any/Unknown/BigInt/Optional).
 *
 * drizzle-orm's typebox entry is compiled against early typebox 1.x (it
 * extends `Type.Base`, removed in later 1.x) — that constraint is between
 * drizzle-orm and the user's typebox version, not ours.
 */

/** JSON Schema keys that carry no validation semantics — safe to drop. */
const METADATA_KEYS = new Set([
	"$id",
	"$schema",
	"title",
	"description",
	"default",
	"examples",
	"deprecated",
	"readOnly",
	"writeOnly",
]);

/**
 * String formats drizzle-orm/typebox can emit (pg uuid today). Emitted
 * verbatim as `t.String({ format })` — typebox validates via its format
 * registry at the user's runtime, so formats pass through unmapped.
 */

function serializeValue(value: unknown): string {
	if (typeof value === "bigint") return `${value}n`;
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "Number.NaN";
		if (value === Number.POSITIVE_INFINITY) return "Number.POSITIVE_INFINITY";
		if (value === Number.NEGATIVE_INFINITY) return "Number.NEGATIVE_INFINITY";
		return JSON.stringify(value);
	}
	if (typeof value === "string") return JSON.stringify(value);
	if (value === null || typeof value === "boolean") return String(value);
	if (typeof value === "object") {
		return JSON.stringify(value, (_k, v: unknown) =>
			typeof v === "bigint" ? `${v}n` : v,
		);
	}
	throw new DrizzleValidatorsError(
		`Cannot serialize literal value of type ${typeof value} for the typebox target.`,
	);
}

function indent(depth: number): string {
	return "  ".repeat(depth);
}

/**
 * Renders `key: value` property lines for t.Object bodies.
 * Returns the trailing text after the last property (no trailing comma).
 */
function propertyLines(
	entries: [string, string][],
	depth: number,
): string {
	const pad = indent(depth);
	return entries.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${v}`).join(",\n");
}

function failUnrecognized(node: Record<string, unknown>, keys: string[], depth: number): never {
	throw new DrizzleValidatorsError(
		`Unserializable JSON Schema node for the typebox target ` +
			`(depth ${depth}): unexpected key(s) ${keys.map((k) => `"${k}"`).join(", ")}. ` +
			`This usually means a column type (or a custom schema factory) produced a shape ` +
			`the typebox serializer does not know yet — please open an issue with the column definition.`,
	);
}

/**
 * The P2-02 buffer policy for the typebox target: drizzle's current typebox
 * entry never surfaces Buffer columns as Node-only values (they come through
 * as `{}`/Any), but if a custom schema factory produces a TBuffer instance,
 * fail loud by default exactly like the Zod serializer does.
 *
 * Returns the keep-policy encoding when the node is a TBuffer and "keep" is
 * set; null when the node is not a TBuffer.
 */
function bufferNodeEncoding(node: unknown, ctx: EmitContext): string | null {
	const ctorName =
		node !== null && typeof node === "object"
			? (node as object).constructor?.name
			: undefined;
	if (ctorName !== "TBuffer") return null;
	if (ctx.bufferAs === "throw") {
		throw new DrizzleValidatorsError(
			`A column serializes to a Node-only Buffer schema (TBuffer), which ` +
				`cannot be emitted into client-safe generated code (finding P2-02). Either exclude this ` +
				`table, use a string/base64 blob mode, or set bufferAs: "keep" to emit it deliberately.`,
		);
	}
	// "keep": t.Unknown() is the only portable cross-version encoding.
	return "t.Unknown()";
}

function emitNode(node: unknown, ctx: EmitContext, depth: number): string {
	if (depth > MAX_RECURSION_DEPTH) {
		throw new DrizzleValidatorsError(
			`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded in the typebox serializer. ` +
				`Your schema may contain cyclic references or be excessively deeply nested.`,
		);
	}
	if (node === undefined || node === null || typeof node !== "object" || Array.isArray(node)) {
		throw new DrizzleValidatorsError(
			`Unserializable JSON Schema node for the typebox target (depth ${depth}): ` +
				`expected an object, got ${node === null ? "null" : Array.isArray(node) ? "array" : typeof node}.`,
		);
	}
	const bufferEnc = bufferNodeEncoding(node, ctx);
	if (bufferEnc !== null) return bufferEnc;

	const raw = node as Record<string, unknown>;
	const symbolKeys = Object.getOwnPropertySymbols(raw);
	if (symbolKeys.length > 0) {
		// A real TSchema instance (custom schema factory output) — not plain
		// JSON Schema; fail loud rather than guessing at kind internals.
		failUnrecognized(
			raw,
			symbolKeys.map((s) => String(s.description ?? "symbol")),
			depth,
		);
	}

	const keys = Object.keys(raw);
	if (keys.length === 0) return "t.Any()";

	const constrainedKeys = keys.filter((k) => !METADATA_KEYS.has(k));
	if (constrainedKeys.length === 0) return "t.Any()";

	// --- unions -----------------------------------------------------------
	const anyOf = raw.anyOf ?? raw.oneOf;
	if (anyOf !== undefined) {
		const rest = constrainedKeys.filter((k) => k !== "anyOf" && k !== "oneOf");
		if (rest.length > 0) failUnrecognized(raw, rest, depth);
		const members = (anyOf as unknown[]).map((m) => emitNode(m, ctx, depth + 1));
		return `t.Union([${members.join(", ")}])`;
	}

	// --- enums / const ------------------------------------------------------
	if (raw.enum !== undefined) {
		// JSON Schema permits a redundant `type` next to `enum` — the literal
		// members already carry the type.
		const rest = constrainedKeys.filter((k) => k !== "enum" && k !== "type");
		if (rest.length > 0) failUnrecognized(raw, rest, depth);
		const values = raw.enum as unknown[];
		if (values.length === 1) return `t.Literal(${serializeValue(values[0])})`;
		return `t.Union([${values.map((v) => `t.Literal(${serializeValue(v)})`).join(", ")}])`;
	}
	if (raw.const !== undefined) {
		const rest = constrainedKeys.filter((k) => k !== "const" && k !== "type");
		if (rest.length > 0) failUnrecognized(raw, rest, depth);
		return `t.Literal(${serializeValue(raw.const)})`;
	}

	// --- objects ------------------------------------------------------------
	if (raw.type === "object" || raw.properties !== undefined || raw.patternProperties !== undefined || raw.additionalProperties !== undefined) {
		const rest = constrainedKeys.filter(
			(k) =>
				k !== "type" &&
				k !== "properties" &&
				k !== "required" &&
				k !== "patternProperties" &&
				k !== "additionalProperties" &&
				k !== "minProperties" &&
				k !== "maxProperties",
		);
		if (rest.length > 0) failUnrecognized(raw, rest, depth);

		const patternProps = raw.patternProperties as
			| Record<string, unknown>
			| undefined;
		const props = raw.properties as Record<string, unknown> | undefined;
		const addl = raw.additionalProperties;

		if (patternProps !== undefined) {
			const patterns = Object.keys(patternProps);
			if (props !== undefined || patterns.length !== 1) {
				failUnrecognized(
					raw,
					props !== undefined ? ["properties"] : patterns.slice(1),
					depth,
				);
			}
			const pattern = patterns[0]!;
			const valueCode = emitNode(patternProps[pattern], ctx, depth + 1);
			// drizzle's JSON-value record uses the match-all pattern "^.*$";
			// t.String() is its exact equivalent.
			const keyCode =
				pattern === "^.*$" || pattern === ""
					? "t.String()"
					: `t.String({ pattern: ${JSON.stringify(pattern)} })`;
			return `t.Record(${keyCode}, ${valueCode})`;
		}

		if (props !== undefined) {
			const required = new Set(
				Array.isArray(raw.required) ? (raw.required as string[]) : [],
			);
			const body = propertyLines(
				Object.entries(props).map(([k, v]) => [
					k,
					required.has(k)
						? emitNode(v, ctx, depth + 1)
						: `t.Optional(${emitNode(v, ctx, depth + 1)})`,
				]),
				depth + 1,
			);
			return body
				? `t.Object({\n${body}\n${indent(depth)}})`
				: "t.Object({})";
		}

		if (addl !== undefined && typeof addl === "object" && addl !== null && !Array.isArray(addl)) {
			return `t.Record(t.String(), ${emitNode(addl, ctx, depth + 1)})`;
		}

		return "t.Object({})";
	}

	// --- primitives -----------------------------------------------------------
	const type = raw.type;
	const opts: string[] = [];
	const numericOpts = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"] as const;

	switch (type) {
		case "string": {
			const rest = constrainedKeys.filter(
				(k) => k !== "type" && k !== "minLength" && k !== "maxLength" && k !== "pattern" && k !== "format",
			);
			if (rest.length > 0) failUnrecognized(raw, rest, depth);
			if (raw.minLength !== undefined) opts.push(`minLength: ${serializeValue(raw.minLength)}`);
			if (raw.maxLength !== undefined) opts.push(`maxLength: ${serializeValue(raw.maxLength)}`);
			if (raw.pattern !== undefined) opts.push(`pattern: ${JSON.stringify(raw.pattern)}`);
			if (raw.format !== undefined) {
				// Emit any format verbatim — typebox resolves it against its own
				// format registry at the user's runtime.
				opts.push(`format: ${JSON.stringify(raw.format)}`);
			}
			break;
		}
		case "integer":
		case "number": {
			const rest = constrainedKeys.filter(
				(k) => k !== "type" && !(numericOpts as readonly string[]).includes(k),
			);
			if (rest.length > 0) failUnrecognized(raw, rest, depth);
			for (const opt of numericOpts) {
				if (raw[opt] !== undefined) opts.push(`${opt}: ${serializeValue(raw[opt])}`);
			}
			break;
		}
		case "bigint": {
			const rest = constrainedKeys.filter(
				(k) => k !== "type" && !(numericOpts as readonly string[]).includes(k),
			);
			if (rest.length > 0) failUnrecognized(raw, rest, depth);
			for (const opt of numericOpts) {
				if (raw[opt] !== undefined) opts.push(`${opt}: ${serializeValue(raw[opt])}`);
			}
			break;
		}
		case "boolean": {
			const rest = constrainedKeys.filter((k) => k !== "type");
			if (rest.length > 0) failUnrecognized(raw, rest, depth);
			break;
		}
		case "buffer": {
			const rest = constrainedKeys.filter((k) => k !== "type");
			if (rest.length > 0) failUnrecognized(raw, rest, depth);
			// drizzle-orm rc.5+ encodes Buffer columns (bytea, blob buffer)
			// as the raw JSON marker { type: "buffer" } — same P2-02 policy
			// as the Zod/Valibot adapters.
			if (ctx.bufferAs === "throw") {
				throw new DrizzleValidatorsError(
					`A column serializes to a Node-only Buffer schema ({ type: "buffer" }), which ` +
						`cannot be emitted into client-safe generated code (finding P2-02). Either exclude this ` +
						`table, use a string/base64 blob mode, or set bufferAs: "keep" to emit it deliberately.`,
				);
			}
			// "keep": round-trip the marker through Unsafe (typebox has no
			// Buffer builder on any version line; runtime checking of the
			// Buffer-ness belongs to the consumer).
			return "t.Unsafe<Buffer>({ type: \"buffer\" })";
		}
		case "date": {
			const rest = constrainedKeys.filter((k) => k !== "type");
			if (rest.length > 0) failUnrecognized(raw, rest, depth);
			// typebox (0.34 and 1.x alike) has no Date builder — drizzle emits
			// the raw JSON marker { type: "date" } (rc.5+). Unsafe alone
			// validates NOTHING (unknown type strings fall through to pass),
			// so a Refine predicate carries the actual Date check while the
			// Unsafe brand keeps the static type. Invalid-Date objects
			// (instanceof Date but NaN time) are rejected too.
			return 't.Refine(t.Unsafe<Date>({ type: "date" }), (value) => value instanceof Date && !Number.isNaN(value.getTime()))';
		}
		case "null": {
			const rest = constrainedKeys.filter((k) => k !== "type");
			if (rest.length > 0) failUnrecognized(raw, rest, depth);
			return "t.Null()";
		}
		case "array": {
			const rest = constrainedKeys.filter(
				(k) => k !== "type" && k !== "items" && k !== "minItems" && k !== "maxItems" && k !== "uniqueItems",
			);
			if (rest.length > 0) failUnrecognized(raw, rest, depth);
			const items = raw.items !== undefined ? emitNode(raw.items, ctx, depth + 1) : "t.Any()";
			if (raw.minItems !== undefined) opts.push(`minItems: ${serializeValue(raw.minItems)}`);
			if (raw.maxItems !== undefined) opts.push(`maxItems: ${serializeValue(raw.maxItems)}`);
			if (raw.uniqueItems !== undefined) opts.push(`uniqueItems: ${serializeValue(raw.uniqueItems)}`);
			const itemsPart = items === "t.Any()" && opts.length === 0
				? "t.Any()"
				: items;
			return opts.length > 0
				? `t.Array(${itemsPart}, { ${opts.join(", ")} })`
				: `t.Array(${itemsPart})`;
		}
		default:
			failUnrecognized(raw, type === undefined ? constrainedKeys : [`type: ${String(type)}`], depth);
	}

	const builder =
		type === "integer"
			? "t.Integer"
			: type === "bigint"
				? "t.BigInt"
				: type === "number"
					? "t.Number"
					: type === "boolean"
						? "t.Boolean"
						: "t.String";
	return opts.length > 0 ? `${builder}({ ${opts.join(", ")} })` : `${builder}()`;
}

export const typeboxAdapter: SerializerAdapter = {
	target: "typebox",
	importStatement: "import * as t from 'typebox'",
	dependencyPackages: DEPENDENCY_PACKAGES.typebox,

	async loadCreators(): Promise<SchemaCreators> {
		// Requires drizzle-orm >= the first release shipping ./typebox AND the
		// user's `typebox` package (drizzle's entry imports it). Both failures
		// surface through the generator's guarded actionable message.
		const mod = await import("drizzle-orm/typebox");
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
