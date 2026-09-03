import type { ZodTypeAny } from "zod";
import { KNOWN_FORMATS, MAX_RECURSION_DEPTH } from "./constants";

type StringCheckCtx = {
	singleFormat: string | undefined;
	chainParts: string[];
	def: any;
	isoArgs?: string;
	stringBase?: boolean;
};

/**
 * Extracts a custom error message from a check def, if one was provided.
 *
 * Zod 4 normalizes `error: "string"` params to `error: () => string`
 * (util.normalizeParams), so calling `error()` is the canonical read. The
 * call is wrapped in try/catch — a throwing custom error map must not crash
 * generation (finding M2).
 */
function extractCheckError(zodDef: any): string | undefined {
	if (typeof zodDef.error === "function") {
		try {
			const res = zodDef.error();
			if (typeof res === "string") return res;
			if (res && typeof res.message === "string") return res.message;
		} catch {
			// fall through to def.message, then undefined
		}
	}
	if (typeof zodDef.message === "string") return zodDef.message;
	return undefined;
}

/** Serializes a check's optional custom error as a params argument. */
function checkErrorArg(zodDef: any): string {
	const msg = extractCheckError(zodDef);
	return msg === undefined ? "" : `, ${JSON.stringify(msg)}`;
}

/**
 * Resolves the canonical builder name for a string format def.
 *
 * Zod 4 collapses several builders onto shared def formats:
 *   - `z.uuidv4()` → `{ format: "uuid", version: "v4" }`
 *   - `z.httpUrl()` → `{ format: "url", protocol, hostname }`
 * The raw def.format alone would emit the weaker base builder and lose the
 * version/protocol constraints (finding H2).
 */
function resolveStringFormatName(def: any): string | undefined {
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
	return def.format;
}

/**
 * Serializes params for ISO string formats (datetime/time), which carry
 * offset/local/precision constraints that must round-trip or the emission
 * is weaker than the source schema (finding NEW-4).
 *
 * Returns `{ ... }` (no outer parens) or "" — callers wrap as needed.
 */
function isoFormatArgs(def: any): string {
	const args: string[] = [];
	if (def.format === "datetime") {
		if (def.offset) args.push("offset: true");
		if (def.local) args.push("local: true");
	}
	if (typeof def.precision === "number") {
		args.push(`precision: ${def.precision}`);
	}
	return args.length > 0 ? `{ ${args.join(", ")} }` : "";
}

/** True for ISO string formats that must emit z.iso.* builders (NEW-4). */
function isIsoStringFormat(fmt: string): boolean {
	return (
		fmt === "datetime" || fmt === "date" || fmt === "time" || fmt === "duration"
	);
}

/** Emits a bigint literal (`1n`) or a plain number literal. */
function serializeNumeric(v: unknown): string {
	if (typeof v === "bigint") return `${v}n`;
	return String(v);
}

/**
 * Serializes a literal value, handling the cases JSON.stringify cannot:
 * bigint (`JSON.stringify(1n)` throws TypeError) and symbol/function
 * (not representable in static code at all) — findings H4/NEW-5.
 */
function serializeLiteralValue(v: unknown): string {
	if (typeof v === "bigint") return `${v}n`;
	if (typeof v === "symbol" || typeof v === "function") {
		throw new Error(
			`[drizzle-zod-virtual] Cannot serialize literal of type ${typeof v}.`,
		);
	}
	return JSON.stringify(v);
}

/**
 * Fail-loud guard against unserializable checks (`.refine(fn)`, `z.custom(fn)`).
 *
 * Zod 4 represents both as `{ type: "custom", check: "custom", fn }`. A
 * predicate function can never round-trip to static code, and silently
 * dropping it loosens validation — so we throw instead, on EVERY type that
 * can carry checks, not just strings (findings H3 + H6/NEW-3).
 */
function assertNoUnserializableChecks(def: any, typeName: string): void {
	for (const check of def.checks ?? []) {
		const d = check?._zod?.def ?? check?.def;
		if (d?.check === "custom") {
			throw new Error(
				`[drizzle-zod-virtual] Cannot serialize .refine()/.custom() predicate on type "${typeName}" — ` +
					`function values cannot round-trip to static code. ` +
					`Use refineSchema() in your application code to attach runtime validators.`,
			);
		}
	}
}

/**
 * Detects an always-true predicate (Zod's no-arg `z.custom()` default is
 * `() => !0`). Probing behavior on a few sample inputs is more robust than
 * matching minified source text.
 */
function isAlwaysTruePredicate(fn: (...args: unknown[]) => unknown): boolean {
	try {
		return (
			fn() === true &&
			fn(undefined) === true &&
			fn(0) === true &&
			fn({}) === true
		);
	} catch {
		return false;
	}
}

/**
 * Detects an `instanceof`-style predicate and returns the matched global
 * class name (e.g. "Buffer" for drizzle's sqliteBlob buffer mode, which
 * emits `(v) => v instanceof Buffer`).
 *
 * Probes well-known global classes; returns undefined for anything else.
 */
function probeInstanceofClass(fn: (v: unknown) => unknown): string | undefined {
	const candidates: [string, unknown][] = [
		["Buffer", Buffer],
		["Date", Date],
		["File", typeof File !== "undefined" ? File : undefined],
		["Blob", typeof Blob !== "undefined" ? Blob : undefined],
		["Map", Map],
		["Set", Set],
		["RegExp", RegExp],
	];
	for (const [name, cls] of candidates) {
		if (!cls) continue;
		try {
			// Must accept an instance of the class and reject a non-instance.
			const instance =
				name === "Buffer"
					? Buffer.from("x")
					: name === "Date"
						? new Date()
						: name === "File"
							? new File(["x"], "x")
							: name === "Blob"
								? new Blob(["x"])
								: name === "Map"
									? new Map()
									: name === "Set"
										? new Set()
										: /x/;
			if (fn(instance) === true && fn("not-an-instance") === false) {
				return name;
			}
		} catch {
			// predicate threw on a probe — not an instanceof check on this class
		}
	}
	return undefined;
}

/**
 * Maps an `overwrite` check (trim/toLowerCase/toUpperCase/normalize/slugify)
 * to its builder call by sniffing the canonical `tx` closure body.
 *
 * Zod 4 stores transforms as `{ check: "overwrite", tx }` with no format
 * discriminator — `tx.toString()` is the only signal. We match the exact
 * canonical bodies Zod generates and throw on anything else, so a custom
 * transform is never silently weakened into a built-in (finding H1).
 *
 * `normalize(form)` captures the form in a closure (`(input) =>
 * input.normalize(form)`), so the form is not recoverable from source text —
 * we probe the transform's behavior on a known input instead.
 */
function overwriteCheckToCode(zodDef: any): string {
	const tx = zodDef.tx;
	if (typeof tx !== "function") {
		throw new Error(
			"[drizzle-zod-virtual] Cannot serialize an overwrite check without a transform function.",
		);
	}
	const txStr = tx.toString();
	if (txStr.includes("input.trim()")) return ".trim()";
	if (txStr.includes("input.toLowerCase()")) return ".toLowerCase()";
	if (txStr.includes("input.toUpperCase()")) return ".toUpperCase()";
	if (txStr.includes("util.slugify(input)")) return ".slugify()";
	if (txStr.includes("input.normalize(form)")) {
		// Probe the actual normalization form: apply tx to a string that
		// differs under NFC/NFD/NFKC/NFKD ("é" as NFD is "e" + U+0301).
		const probe = "é";
		const out = tx(probe);
		if (out === probe.normalize("NFC")) return ".normalize()";
		if (out === probe.normalize("NFD")) return `.normalize("NFD")`;
		if (out === probe.normalize("NFKC")) return `.normalize("NFKC")`;
		if (out === probe.normalize("NFKD")) return `.normalize("NFKD")`;
		throw new Error(
			"[drizzle-zod-virtual] Cannot serialize .normalize() with an unrecognized normalization form.",
		);
	}
	throw new Error(
		`[drizzle-zod-virtual] Cannot serialize custom string transform: ${txStr}`,
	);
}

const STRING_CHECK_HANDLERS = new Map<
	string,
	(zodDef: any, ctx: StringCheckCtx) => void
>([
	[
		"max_length",
		(zodDef, ctx) => {
			if (typeof zodDef.maximum === "number")
				ctx.chainParts.push(`.max(${zodDef.maximum}${checkErrorArg(zodDef)})`);
		},
	],
	[
		"min_length",
		(zodDef, ctx) => {
			if (typeof zodDef.minimum === "number")
				ctx.chainParts.push(`.min(${zodDef.minimum}${checkErrorArg(zodDef)})`);
		},
	],
	[
		"length_equals",
		(zodDef, ctx) => {
			if (typeof zodDef.length === "number")
				ctx.chainParts.push(
					`.length(${zodDef.length}${checkErrorArg(zodDef)})`,
				);
		},
	],
	[
		"string_format",
		(zodDef, ctx) => {
			if (zodDef.format === "regex" && zodDef.pattern instanceof RegExp) {
				ctx.chainParts.push(`.regex(${zodDef.pattern.toString()})`);
			} else if (zodDef.format === "starts_with") {
				ctx.chainParts.push(`.startsWith(${JSON.stringify(zodDef.prefix)})`);
			} else if (zodDef.format === "ends_with") {
				ctx.chainParts.push(`.endsWith(${JSON.stringify(zodDef.suffix)})`);
			} else if (zodDef.format === "includes") {
				// NOTE: Zod 4's own def does not retain the optional `position`
				// argument (verified: `z.string().includes("ab", 2)` stores only
				// `includes`), so flat `.includes(s)` is an exact round-trip.
				ctx.chainParts.push(`.includes(${JSON.stringify(zodDef.includes)})`);
			} else if (zodDef.format && KNOWN_FORMATS.has(zodDef.format)) {
				// A second *format* check cannot be chained onto a format schema
				// (e.g. `z.email().uuid()` throws at import time — ZodEmail has
				// no .uuid() method). Emit the method-chained form on z.string()
				// instead, which is valid and semantically identical (NEW-6).
				// The first format must be flushed to chainParts first, or it
				// would be silently dropped.
				if (ctx.singleFormat) {
					ctx.chainParts.push(`.${ctx.singleFormat}()`);
					ctx.chainParts.push(`.${zodDef.format}()`);
					ctx.stringBase = true;
				} else if (ctx.def.coerce) {
					ctx.chainParts.push(`.${zodDef.format}()`);
				} else {
					ctx.singleFormat = zodDef.format;
				}
			} else if (isIsoStringFormat(zodDef.format)) {
				// ISO formats (NEW-4): must emit z.iso.* builders, and
				// format:"date" on a STRING schema must never emit z.date()
				// (a Date-object schema — a silent type change).
				if (ctx.singleFormat) {
					ctx.chainParts.push(`.${ctx.singleFormat}()`);
					ctx.chainParts.push(
						zodDef.format === "datetime"
							? `.datetime(${isoFormatArgs(zodDef)})`
							: `.${zodDef.format}()`,
					);
					ctx.stringBase = true;
				} else {
					ctx.singleFormat = zodDef.format;
					if (zodDef.format === "datetime") {
						ctx.isoArgs = isoFormatArgs(zodDef);
					}
				}
			} else {
				throw new Error(
					`[drizzle-zod-virtual] Unsupported string_format "${zodDef.format}" during serialization. ` +
						`Add it to STRING_FORMAT_NAMES in src/constants.ts.`,
				);
			}
		},
	],
	[
		"overwrite",
		(zodDef, ctx) => {
			ctx.chainParts.push(overwriteCheckToCode(zodDef));
		},
	],
	[
		"custom",
		() => {
			throw new Error(
				`[drizzle-zod-virtual] Cannot serialize .refine()/.custom() predicate on type "string" — ` +
					`function values cannot round-trip to static code. ` +
					`Use refineSchema() in your application code to attach runtime validators.`,
			);
		},
	],
]);

/**
 * Handlers for number/bigint checks (finding NEW-1).
 *
 * drizzle-zod emits range-constrained schemas for every numeric column
 * (`z.int().gte(min).lte(max)`, `z.bigint().gte().lte()`, ...). The old
 * serializer ignored `def.checks` entirely on these types, silently dropping
 * integer-ness and range bounds.
 */
const NUMBER_CHECK_HANDLERS = new Map<
	string,
	(zodDef: any, parts: string[]) => void
>([
	[
		"greater_than",
		(zodDef, parts) => {
			const op = zodDef.inclusive ? "gte" : "gt";
			parts.push(`.${op}(${serializeNumeric(zodDef.value)})`);
		},
	],
	[
		"less_than",
		(zodDef, parts) => {
			const op = zodDef.inclusive ? "lte" : "lt";
			parts.push(`.${op}(${serializeNumeric(zodDef.value)})`);
		},
	],
	[
		"multiple_of",
		(zodDef, parts) => {
			parts.push(`.multipleOf(${serializeNumeric(zodDef.value)})`);
		},
	],
	[
		"number_format",
		(zodDef, parts) => {
			// `z.number().int()` stores the format as a check; `z.int()`
			// stores it on the top-level def. Both paths must be handled.
			if (zodDef.format === "safeint") {
				parts.push(".int()");
			} else {
				throw new Error(
					`[drizzle-zod-virtual] Unsupported number_format "${zodDef.format}" during serialization.`,
				);
			}
		},
	],
	[
		"custom",
		() => {
			throw new Error(
				`[drizzle-zod-virtual] Cannot serialize .refine()/.custom() predicate on type "number" — ` +
					`function values cannot round-trip to static code. ` +
					`Use refineSchema() in your application code to attach runtime validators.`,
			);
		},
	],
]);

export function serializeDefaultValue(value: unknown): string {
	if (typeof value === "bigint") {
		return `${value}n`;
	}
	if (typeof value === "number") {
		// JSON.stringify mangles these to null — emit the exact JS constants.
		if (Number.isNaN(value)) return "Number.NaN";
		if (value === Number.POSITIVE_INFINITY) return "Number.POSITIVE_INFINITY";
		if (value === Number.NEGATIVE_INFINITY) return "Number.NEGATIVE_INFINITY";
	}
	if (value instanceof Date) {
		return `new Date(${JSON.stringify(value.toISOString())})`;
	}
	return JSON.stringify(value);
}

// --- Zod 4 -> source-code serializer ---------------------------------------
// Built against Zod 4's ACTUAL internal shape (verified against zod@4.4.3):
//   - discriminator is `def.type` (a plain string: 'string', 'object', 'optional'...)
//     NOT `def.typeName` (that was Zod 3's convention, e.g. 'ZodString')
//   - object fields live at `def.shape` directly (a plain object), not `def.shape()`
//   - enum values live at `def.entries` (an object map), not `def.values` (an array)
//   - wrapper types (optional/nullable/default) nest via `def.innerType`
// Extend the switch below as you use more Zod types (arrays, unions, records...).
export function zodTypeToCode(
	schema: ZodTypeAny,
	cache?: WeakMap<ZodTypeAny, string>,
	depth = 0,
): string {
	if (cache) {
		const cached = cache.get(schema);
		if (cached !== undefined) return cached;
	}
	const result = _zodTypeToCode(schema, cache, depth);
	if (cache) cache.set(schema, result);
	return result;
}

function _zodTypeToCode(
	schema: ZodTypeAny,
	cache?: WeakMap<ZodTypeAny, string>,
	depth = 0,
): string {
	if (depth > MAX_RECURSION_DEPTH) {
		throw new Error(
			`[drizzle-zod-virtual] Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded in zodTypeToCode. ` +
				`Your schema may contain cyclic references or be excessively deeply nested.`,
		);
	}
	const def = (schema as any)._def ?? (schema as any).def;

	if (!def || typeof def.type !== "string") {
		throw new Error(
			`[drizzle-zod-virtual] Could not read a valid def.type from schema. ` +
				`Got: ${JSON.stringify(def)}`,
		);
	}

	switch (def.type) {
		case "string": {
			// resolveStringFormatName: z.uuidv4() → format "uuid" + version "v4",
			// z.httpUrl() → format "url" + protocol — raw def.format would emit
			// the weaker base builder (finding H2).
			let singleFormat = resolveStringFormatName(def);
			const chainParts: string[] = [];
			// Constructor-form ISO schemas (z.iso.datetime({...})) carry
			// offset/local/precision on the top-level def, not in checks.
			let isoArgs = isoFormatArgs(def);
			let stringBase = false;

			if (Array.isArray(def.checks)) {
				const ctx: StringCheckCtx = { singleFormat, chainParts, def };
				for (const check of def.checks) {
					const zodDef = check?._zod?.def ?? check?.def;
					if (!zodDef) continue;
					const handler = STRING_CHECK_HANDLERS.get(zodDef.check);
					if (handler) handler(zodDef, ctx);
				}
				singleFormat = ctx.singleFormat;
				isoArgs = ctx.isoArgs ?? isoArgs;
				stringBase = ctx.stringBase ?? false;
			}

			// ISO string formats (NEW-4): z.iso.date()/z.iso.time()/... —
			// format:"date" on a string schema must NEVER emit z.date().
			if (singleFormat && !stringBase && !def.coerce) {
				if (isIsoStringFormat(singleFormat)) {
					return `z.iso.${singleFormat}(${isoArgs})${chainParts.join("")}`;
				}
				if (KNOWN_FORMATS.has(singleFormat)) {
					return `z.${singleFormat}()${chainParts.join("")}`;
				}
				throw new Error(
					`[drizzle-zod-virtual] Unsupported string format "${singleFormat}" during serialization. ` +
						`Add it to STRING_FORMAT_NAMES in src/constants.ts.`,
				);
			}

			const base = def.coerce ? "z.coerce.string()" : "z.string()";
			return base + chainParts.join("");
		}
		case "number": {
			assertNoUnserializableChecks(def, "number");
			const parts: string[] = [];
			for (const check of def.checks ?? []) {
				const d = check?._zod?.def ?? check?.def;
				if (!d) continue;
				const handler = NUMBER_CHECK_HANDLERS.get(d.check);
				if (handler) handler(d, parts);
			}
			// `z.int()` stores format:"safeint" on the top-level def;
			// `z.number().int()` stores it as a number_format check.
			if (def.format === "safeint") {
				return `z.int()${parts.join("")}`;
			}
			if (def.format) {
				throw new Error(
					`[drizzle-zod-virtual] Unsupported number format "${def.format}" during serialization.`,
				);
			}
			return (def.coerce ? "z.coerce.number()" : "z.number()") + parts.join("");
		}
		case "boolean":
			return def.coerce ? "z.coerce.boolean()" : "z.boolean()";
		case "date":
			return def.coerce ? "z.coerce.date()" : "z.date()";
		case "bigint": {
			assertNoUnserializableChecks(def, "bigint");
			const parts: string[] = [];
			for (const check of def.checks ?? []) {
				const d = check?._zod?.def ?? check?.def;
				if (!d) continue;
				const handler = NUMBER_CHECK_HANDLERS.get(d.check);
				if (handler) handler(d, parts);
			}
			return (def.coerce ? "z.coerce.bigint()" : "z.bigint()") + parts.join("");
		}
		case "any":
			return "z.any()";
		case "unknown":
			return "z.unknown()";
		case "custom": {
			// Graduated handling (finding H3):
			//  1. No fn / always-true fn → `z.custom()` (accepts anything) —
			//     this is what drizzle's customType columns map to.
			//  2. instanceof-style predicate → `z.instanceof(Cls)` — an exact
			//     round-trip (drizzle's sqliteBlob buffer mode emits
			//     `(v) => v instanceof Buffer`).
			//  3. Anything else → throw. A runtime predicate cannot round-trip
			//     to static code, and silently dropping it would loosen
			//     validation.
			const fn = def.fn;
			if (typeof fn !== "function" || isAlwaysTruePredicate(fn)) {
				return "z.custom()";
			}
			const cls = probeInstanceofClass(fn);
			if (cls) {
				return `z.instanceof(${cls})`;
			}
			throw new Error(
				`[drizzle-zod-virtual] Cannot serialize z.custom() with a runtime predicate function to static code. ` +
					`Use refineSchema() in your application code to attach runtime validators.`,
			);
		}
		case "literal": {
			// Zod 4 ALWAYS stores an array in def.values (core/api.js:833).
			const values: unknown[] = Array.isArray(def.values)
				? def.values
				: [def.value];
			return values.length === 1
				? `z.literal(${serializeLiteralValue(values[0])})`
				: `z.literal([${values.map(serializeLiteralValue).join(", ")}])`;
		}
		case "tuple": {
			const items = def.items ?? (def.element ? [def.element] : []);
			return `z.tuple([${(items as ZodTypeAny[]).map((s) => zodTypeToCode(s, cache, depth + 1)).join(", ")}])`;
		}
		case "intersection":
			return `z.intersection(${zodTypeToCode(def.left, cache, depth + 1)}, ${zodTypeToCode(def.right, cache, depth + 1)})`;
		case "record":
			return `z.record(${zodTypeToCode(def.keyType, cache, depth + 1)}, ${zodTypeToCode(def.valueType, cache, depth + 1)})`;
		case "set":
			return `z.set(${zodTypeToCode(def.valueType, cache, depth + 1)})`;
		case "map":
			return `z.map(${zodTypeToCode(def.keyType, cache, depth + 1)}, ${zodTypeToCode(def.valueType, cache, depth + 1)})`;
		case "nan":
			return "z.nan()";
		case "never":
			return "z.never()";
		case "undefined":
			return "z.undefined()";
		case "void":
			return "z.void()";
		case "null":
			return "z.null()";
		case "union":
			return `z.union([${(def.options as ZodTypeAny[]).map((s) => zodTypeToCode(s, cache, depth + 1)).join(", ")}])`;
		case "enum": {
			const entries = def.entries
				? Object.keys(def.entries)
				: Array.isArray(def.values)
					? def.values
					: [];
			return `z.enum(${JSON.stringify(entries)})`;
		}
		case "optional": {
			// Zod 4: ZodExactOptional has def.type "optional" — traits are the
			// only reliable discriminator (finding M4/NEW-2).
			const isExact = (schema as any)._zod?.traits?.has?.("ZodExactOptional");
			const inner = zodTypeToCode(def.innerType, cache, depth + 1);
			return isExact ? `${inner}.exactOptional()` : `${inner}.optional()`;
		}
		case "nullable":
			return `${zodTypeToCode(def.innerType, cache, depth + 1)}.nullable()`;
		case "default": {
			const defaultVal =
				typeof def.defaultValue === "function"
					? def.defaultValue()
					: def.defaultValue;
			// A default of undefined means "no default" — skip the wrapper
			// rather than emitting the invalid `z.x().default(undefined)`
			// (finding M1).
			if (defaultVal === undefined) {
				return zodTypeToCode(def.innerType, cache, depth + 1);
			}
			return `${zodTypeToCode(def.innerType, cache, depth + 1)}.default(${serializeDefaultValue(defaultVal)})`;
		}
		case "array": {
			assertNoUnserializableChecks(def, "array");
			const parts: string[] = [];
			for (const check of def.checks ?? []) {
				const d = check?._zod?.def ?? check?.def;
				if (!d) continue;
				if (d.check === "min_length" && typeof d.minimum === "number") {
					parts.push(`.min(${d.minimum})`);
				} else if (d.check === "max_length" && typeof d.maximum === "number") {
					parts.push(`.max(${d.maximum})`);
				} else if (
					d.check === "length_equals" &&
					typeof d.length === "number"
				) {
					parts.push(`.length(${d.length})`);
				}
			}
			return `z.array(${zodTypeToCode(def.element, cache, depth + 1)})${parts.join("")}`;
		}
		case "object": {
			assertNoUnserializableChecks(def, "object");
			const shape = def.shape;
			const fields = Object.entries(shape)
				.map(
					([key, val]) =>
						`  ${JSON.stringify(key)}: ${zodTypeToCode(val as ZodTypeAny, cache, depth + 1)},`,
				)
				.join("\n");

			// strictObject → catchall: z.never(); looseObject → catchall:
			// z.unknown() (verified classic/schemas.js:794-810). `.strict()`/
			// `.loose()`/`.strip()` produce the same def shapes (finding H5).
			const catchallDef =
				def.catchall?._zod?.def ?? def.catchall?.def ?? def.catchall?._def;
			if (catchallDef) {
				if (catchallDef.type === "never") {
					return `z.strictObject({\n${fields}\n})`;
				}
				if (catchallDef.type === "unknown") {
					return `z.looseObject({\n${fields}\n})`;
				}
				return `z.object({\n${fields}\n}).catchall(${zodTypeToCode(def.catchall, cache, depth + 1)})`;
			}
			return `z.object({\n${fields}\n})`;
		}
		default:
			// Keep the build from silently emitting wrong/incomplete validation.
			throw new Error(
				`[drizzle-zod-virtual] Unsupported Zod type "${def.type}". ` +
					`Add a case in zodTypeToCode() for it.`,
			);
	}
}
