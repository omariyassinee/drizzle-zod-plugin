import type { ZodTypeAny } from "zod";
import { DrizzleValidatorsError } from "./errors";
import { url } from "zod";
import { KNOWN_FORMATS, MAX_RECURSION_DEPTH } from "./constants";
import { resolveStringFormatName } from "./format-names";

type StringCheckCtx = {
	singleFormat: string | undefined;
	chainParts: string[];
	def: any;
	isoArgs?: string;
	stringBase?: boolean;
};

/** Options that control how serializer edge cases are emitted. */
export type ZodSerializerOptions = {
	/**
	 * Policy for Node-only classes probed inside a `z.custom()` predicate
	 * (finding P2-02):
	 *  - "throw" (default): generation fails with an actionable message —
	 *    the emitted module is documented as client-safe, and a Node-only
	 *    global baked into it crashes browser bundles at import time.
	 *  - "keep": emit `z.instanceof(Buffer)` (for server-only codebases).
	 */
	bufferAs?: "throw" | "keep";
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
 * bigint (`JSON.stringify(1n)` throws TypeError), the NaN/±Infinity numbers
 * (JSON.stringify mangles them to `null` — zod's literal comparison uses
 * Object.is, so `z.literal(Number.NaN)` round-trips exactly), and
 * symbol/function (not representable in static code at all) —
 * findings H4/NEW-5 + P2-05.
 */
function serializeLiteralValue(v: unknown): string {
	if (typeof v === "bigint") return `${v}n`;
	if (typeof v === "symbol" || typeof v === "function") {
		throw new DrizzleValidatorsError(
			`Cannot serialize literal of type ${typeof v}.`,
		);
	}
	if (typeof v === "number") {
		if (Number.isNaN(v)) return "Number.NaN";
		if (v === Number.POSITIVE_INFINITY) return "Number.POSITIVE_INFINITY";
		if (v === Number.NEGATIVE_INFINITY) return "Number.NEGATIVE_INFINITY";
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
			throw new DrizzleValidatorsError(
				`Cannot serialize .refine()/.custom() predicate on type "${typeName}" — ` +
					`function values cannot round-trip to static code. ` +
					`Use refineZSchema() in your application code to attach runtime validators.`,
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
 * discriminator — `tx.toString()` is the only signal. Source-text matching
 * alone can misfire on a transform that merely MENTIONS `input.trim()` in
 * its body (finding P2-18): the emitted `.trim()` would silently discard
 * the rest of the transform. Every candidate match is therefore verified
 * behaviorally against the transform's own canonical input before it may
 * claim the builtin's identity; a mismatch fails loud while naming the
 * transform body.
 *
 * `normalize(form)` captures the form in a closure (`(input) =>
 * input.normalize(form)`), so the form is not recoverable from source text —
 * we probe the transform's behavior on a known input instead.
 */
function overwriteCheckToCode(zodDef: any): string {
	const tx = zodDef.tx;
	if (typeof tx !== "function") {
		throw new DrizzleValidatorsError(
			"Cannot serialize an overwrite check without a transform function.",
		);
	}

	/**
	 * Behavior-based candidate matching (finding P2-18). The original bug
	 * emitted `.trim()` for ANY overwrite check — no verification at all.
	 * Source-text matching alone is also unsafe: a transform whose body
	 * mentions `.trim()` may do more, and bundlers can rename `input`,
	 * making source matching miss genuine builtins. So match on BEHAVIOR:
	 * a transform is emitted as a builtin only when its outputs on a probe
	 * set are exactly the builtin's. The probe set is chosen so no two
	 * candidates agree on every input.
	 */
	const CANDIDATES: Array<{
		builder: string;
		probes: Array<[string, string]>;
	}> = [
		{
			builder: ".trim()",
			probes: [
				["\u00a0 ab \n", "ab"],
				["hello world", "hello world"],
				["Ab\t", "Ab"],
			],
		},
		{
			builder: ".toLowerCase()",
			probes: [
				["\u00a0 AB \n", "\u00a0 ab \n"],
				["hello world", "hello world"],
				["Ab\t", "ab\t"],
			],
		},
		{
			builder: ".toUpperCase()",
			probes: [
				["ab", "AB"],
				["hello world", "HELLO WORLD"],
				["\u00a0 ab \n", "\u00a0 AB \n"],
			],
		},
		{
			builder: ".slugify()",
			probes: [
				["hello world", "hello-world"],
				["a b  c", "a-b-c"],
				["  a  ", "a"],
			],
		},
	];

	for (const candidate of CANDIDATES) {
		let allMatch = true;
		try {
			for (const [input, expected] of candidate.probes) {
				if (tx(input) !== expected) {
					allMatch = false;
					break;
				}
			}
		} catch {
			allMatch = false;
		}
		if (allMatch) return candidate.builder;
	}

	if (tx.toString().includes("normalize")) {
		// Probe the actual normalization form: apply tx to a string that
		// differs under NFC/NFD/NFKC/NFKD ("é" as NFD is "e" + U+0301).
		let out: string | undefined;
		try {
			const probe = "\u00e9";
			out = tx(probe);
			if (out === probe.normalize("NFC")) return ".normalize()";
			if (out === probe.normalize("NFD")) return `.normalize("NFD")`;
			if (out === probe.normalize("NFKC")) return `.normalize("NFKC")`;
			if (out === probe.normalize("NFKD")) return `.normalize("NFKD")`;
		} catch {
			// fall through to the generic failure below
		}
		out = undefined;
	}

	const txStr = tx.toString();
	throw new DrizzleValidatorsError(
		`Cannot serialize a custom string transform to a builtin chain call. ` +
			`A runtime transform must behave EXACTLY like a supported builtin on all outputs ` +
			`(supported: .trim(), .toLowerCase(), .toUpperCase(), .slugify(), .normalize()); ` +
			`transform source: ${txStr}. Use refineZSchema() at runtime instead.`,
	);
}

/**
 * Probes whether the installed zod actually honors `z.url({ protocol,
 * hostname })` params (finding P2-07). zod@4.4.3 ships a broken param
 * matcher that rejects EVERY input — emitting those params would produce an
 * over-tight (always-failing) schema. The probe is memoized once.
 */
let _urlParamsSupported: boolean | undefined;

function zodUrlParamsSupported(): boolean {
	if (_urlParamsSupported !== undefined) return _urlParamsSupported;
	try {
		const probe = url({
			protocol: ["https:"],
			hostname: "zod-url-params-probe",
		} as any);
		_urlParamsSupported = probe.safeParse(
			"https://zod-url-params-probe/path",
		).success;
	} catch {
		_urlParamsSupported = false;
	}
	return _urlParamsSupported;
}

/**
 * Serializes a url-format def WITHOUT the zod httpUrl params (fallback for
 * zods whose param matcher is broken/absent). Protocol/hostname constraints
 * become literal chain checks. Exported for tests — the fallback path only
 * runs on zod versions where `zodUrlParamsSupported()` is false.
 */
export function urlFallbackChainCode(def: any): string {
	const chain: string[] = [];
	if (def.protocol !== undefined) {
		const protocols: string[] = Array.isArray(def.protocol)
			? def.protocol.filter((p: unknown): p is string => typeof p === "string")
			: [def.protocol];
		// zod stores protocol values WITH the trailing colon ("https:") —
		// normalize entries that lack it without double-appending.
		const normalized = protocols.map((p) =>
			p ? (p.endsWith(":") ? p : `${p}:`) : p,
		);
		if (normalized.length === 1 && normalized[0]) {
			chain.push(`.startsWith(${JSON.stringify(`${normalized[0]}//`)})`);
		} else {
			// multiple protocols: encode as a literal regex on the scheme:// prefix
			const alts = normalized
				.filter((p): p is string => !!p)
				.map((p) => `${p}//`.replace(/[/\\]/g, "\\$&"));
			chain.push(`.regex(/^(?:${alts.join("|")})/)`);
		}
	}
	if (def.hostname !== undefined && typeof def.hostname === "string") {
		chain.push(`.includes(${JSON.stringify(`://${def.hostname}`)})`);
	}
	return `z.url()${chain.join("")}`;
}

/**
 * Serializes a url-format def that carries protocol/hostname params.
 *
 * When the installed zod supports the params, emit `z.httpUrl({...})` — the
 * exact round-trip. When it does not (e.g. zod@4.4.3's always-rejecting
 * matcher — verified), fall back to `z.url()` plus literal chain checks so
 * the constraints are preserved without baking a broken matcher into the
 * user's bundle.
 */
function urlWithParamsCode(def: any): string {
	if (zodUrlParamsSupported()) {
		const args: string[] = [];
		if (def.protocol !== undefined)
			args.push(`protocol: ${JSON.stringify(def.protocol)}`);
		if (def.hostname !== undefined)
			args.push(`hostname: ${JSON.stringify(def.hostname)}`);
		return `z.httpUrl({ ${args.join(", ")} })`;
	}

	return urlFallbackChainCode(def);
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
				throw new DrizzleValidatorsError(
					`Unsupported string_format "${zodDef.format}" during serialization. ` +
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
			throw new DrizzleValidatorsError(
				`Cannot serialize .refine()/.custom() predicate on type "string" — ` +
					`function values cannot round-trip to static code. ` +
					`Use refineZSchema() in your application code to attach runtime validators.`,
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
				throw new DrizzleValidatorsError(
					`Unsupported number_format "${zodDef.format}" during serialization.`,
				);
			}
		},
	],
	[
		"custom",
		() => {
			throw new DrizzleValidatorsError(
				`Cannot serialize .refine()/.custom() predicate on type "number" — ` +
					`function values cannot round-trip to static code. ` +
					`Use refineZSchema() in your application code to attach runtime validators.`,
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
	opts?: ZodSerializerOptions,
): string {
	if (cache) {
		const cached = cache.get(schema);
		if (cached !== undefined) return cached;
	}
	const result = _zodTypeToCode(schema, cache, depth, opts);
	if (cache) cache.set(schema, result);
	return result;
}

function _zodTypeToCode(
	schema: ZodTypeAny,
	cache?: WeakMap<ZodTypeAny, string>,
	depth = 0,
	opts?: ZodSerializerOptions,
): string {
	if (depth > MAX_RECURSION_DEPTH) {
		throw new DrizzleValidatorsError(
			`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded in zodTypeToCode. ` +
				`Your schema may contain cyclic references or be excessively deeply nested.`,
		);
	}
	const def = (schema as any)._def ?? (schema as any).def;

	// Zod 3 marker: defs carry `typeName` (e.g. "ZodString") and NO `_zod`
	// runtime marker. This serializer is built against Zod 4 internals only
	// — fail loud instead of mis-serializing checks into weaker validation
	// (finding C1; Zod 3 support is explicitly out of scope).
	if ((schema as any)._zod === undefined && def?.typeName) {
		throw new DrizzleValidatorsError(
			`Detected Zod 3 schemas (def.typeName = "${def.typeName}"). ` +
				`This plugin only supports zod@4 — please upgrade zod to ^4.0.0 ` +
				`along with drizzle-orm >= 0.43 (or drizzle-zod >= 0.7).`,
		);
	}

	if (!def || typeof def.type !== "string") {
		throw new DrizzleValidatorsError(
			`Could not read a valid def.type from schema. ` +
				`Got: ${JSON.stringify(def)}`,
		);
	}

	// Fail loud on unserializable `.refine()`/`.custom()` predicates BEFORE
	// the type dispatch (finding P2-01) — this was previously wired onto only
	// 4 of ~15 types, so a refine on date/enum/union/record/set/map/literal
	// was silently dropped, loosening validation. Running it here covers every
	// type that can carry checks, including all wrapper types.
	assertNoUnserializableChecks(def, def.type);

	switch (def.type) {
		case "string": {
			// URL with protocol/hostname params (finding P2-07): resolveStringFormatName
			// alone would emit the weaker base builder, losing the params
			// entirely — and on zod installs with a broken param matcher
			// (e.g. 4.4.3) emitting the params would reject every input.
			// NOTE: bare z.httpUrl() stores EMPTY-OBJECT sentinels in
			// def.protocol/def.hostname — only real params (array/string
			// hostname) take the param-aware branch.
			const hasProtocolParams = Array.isArray(def.protocol)
				? typeof def.protocol !== "undefined" &&
					(def.protocol as unknown[]).length > 0 &&
					(def.protocol as unknown[]).every(
						(p: unknown) => typeof p === "string",
					)
				: typeof def.protocol === "string" && def.protocol !== "";
			const hasHostnameParams =
				typeof def.hostname === "string" && def.hostname !== "";
			if (def.format === "url" && (hasProtocolParams || hasHostnameParams)) {
				return urlWithParamsCode(def);
			}

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
				throw new DrizzleValidatorsError(
					`Unsupported string format "${singleFormat}" during serialization. ` +
						`Add it to STRING_FORMAT_NAMES in src/constants.ts.`,
				);
			}

			const base = def.coerce ? "z.coerce.string()" : "z.string()";
			return base + chainParts.join("");
		}
		case "number": {
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
				throw new DrizzleValidatorsError(
					`Unsupported number format "${def.format}" during serialization.`,
				);
			}
			return (def.coerce ? "z.coerce.number()" : "z.number()") + parts.join("");
		}
		case "boolean":
			return def.coerce ? "z.coerce.boolean()" : "z.boolean()";
		case "date":
			return def.coerce ? "z.coerce.date()" : "z.date()";
		case "bigint": {
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
			//  3. Node-only globals (Buffer) break the client-safe premise
			//     (finding P2-02): browser bundles crash with
			//     `ReferenceError: Buffer is not defined` AT IMPORT TIME. Default
			//     to failing loud; `bufferAs: "keep"` opts back in.
			//  4. Anything else → throw. A runtime predicate cannot round-trip
			//     to static code, and silently dropping it would loosen
			//     validation.
			const fn = def.fn;
			if (typeof fn !== "function" || isAlwaysTruePredicate(fn)) {
				return "z.custom()";
			}
			const cls = probeInstanceofClass(fn);
			if (cls) {
				if (cls === "Buffer" && opts?.bufferAs !== "keep") {
					throw new DrizzleValidatorsError(
						`A column serializes to z.instanceof(Buffer), which is a Node-only global in a client-safe module ` +
							`(finding P2-02); browser bundles crash with ReferenceError: Buffer is not defined at import time. ` +
							`Pass plugin option \`bufferAs: "keep"\` to keep the Node-only behavior deliberately, ` +
							`or re-model the column so it does not serialize to Buffer.`,
					);
				}
				return `z.instanceof(${cls})`;
			}
			throw new DrizzleValidatorsError(
				`Cannot serialize z.custom() with a runtime predicate function to static code. ` +
					`Use refineZSchema() in your application code to attach runtime validators.`,
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
			// Tuple rest element (finding P2-06): the old emission dropped
			// def.rest entirely, so extra items were rejected by the emitted
			// schema while the original accepted them.
			const rest = def.rest
				? `, ${zodTypeToCode(def.rest, cache, depth + 1, opts)}`
				: "";
			return `z.tuple([${(items as ZodTypeAny[])
				.map((s) => zodTypeToCode(s, cache, depth + 1, opts))
				.join(", ")}]${rest})`;
		}
		case "intersection":
			return `z.intersection(${zodTypeToCode(def.left, cache, depth + 1, opts)}, ${zodTypeToCode(def.right, cache, depth + 1, opts)})`;
		case "record":
			return `z.record(${zodTypeToCode(def.keyType, cache, depth + 1, opts)}, ${zodTypeToCode(def.valueType, cache, depth + 1, opts)})`;
		case "set":
			return `z.set(${zodTypeToCode(def.valueType, cache, depth + 1, opts)})`;
		case "map":
			return `z.map(${zodTypeToCode(def.keyType, cache, depth + 1, opts)}, ${zodTypeToCode(def.valueType, cache, depth + 1, opts)})`;
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
			return `z.union([${(def.options as ZodTypeAny[])
				.map((s) => zodTypeToCode(s, cache, depth + 1, opts))
				.join(", ")}])`;
		case "enum": {
			// Numeric/mapped enums (finding P2-08): the old emission serialized
			// the KEYS of def.entries — turning z.enum({ONE:1,TWO:2}) into
			// z.enum(["ONE","TWO"]), i.e. 1 was rejected and "ONE" accepted
			// (an outright type swap). Plain string enums still emit the
			// array form; any mapped entries whose values differ from the
			// keys round-trip through the object form, which preserves the
			// key↔value pairs exactly (verified: zod 4's z.enum>To accepts
			// numeric literal entries and rejects string keys).
			const entries = def.entries;
			if (entries && typeof entries === "object" && !Array.isArray(entries)) {
				const keys = Object.keys(entries);
				const plainStringEnum =
					keys.length > 0 && keys.every((k) => (entries as any)[k] === k);
				if (plainStringEnum) {
					return `z.enum(${JSON.stringify(keys)})`;
				}
				const objArg = `{ ${keys
					.map(
						(k) =>
							`${JSON.stringify(k)}: ${serializeLiteralValue((entries as any)[k])}`,
					)
					.join(", ")} }`;
				return `z.enum(${objArg})`;
			}
			const values = Array.isArray(def.values) ? def.values : [];
			return `z.enum(${JSON.stringify(values)})`;
		}
		case "optional": {
			// Zod 4: ZodExactOptional has def.type "optional" — traits are the
			// only reliable discriminator (finding M4/NEW-2).
			const isExact = (schema as any)._zod?.traits?.has?.("ZodExactOptional");
			const inner = zodTypeToCode(def.innerType, cache, depth + 1, opts);
			return isExact ? `${inner}.exactOptional()` : `${inner}.optional()`;
		}
		case "nullable":
			return `${zodTypeToCode(def.innerType, cache, depth + 1, opts)}.nullable()`;
		case "default": {
			// zod 4 wraps ALL defaults in a GETTER on the def: statics get
			// shallowCloned per access, lazies (.default(fn)) invoke the
			// callback — the def carries no static/lazy flag and the
			// original argument lives only in the closure. Probing the
			// descriptor cannot discriminate, so probe DETERMINISM instead:
			// evaluate the getter twice; if both reads serialize to the
			// same source, the value is effectively static and emitting it
			// is faithful (zod itself clones per access). Different reads =
			// a lazy runtime computation that would freeze one snapshot —
			// fail loud (P2-04).
			// A default of undefined means "no default" — skip the wrapper
			// rather than emitting the invalid `z.x().default(undefined)`
			// (finding M1).
			if (def.defaultValue === undefined) {
				return zodTypeToCode(def.innerType, cache, depth + 1, opts);
			}
			const evaluated = def.defaultValue;
			if (typeof evaluated === "function") {
				throw new DrizzleValidatorsError(
					`Cannot serialize a lazy .default(() => ...) default to static code — ` +
						`emitting it would freeze a single snapshot value at generation time. ` +
						`Use refineZSchema() with .default() at runtime, or provide a concrete default value.`,
				);
			}
			// Space the two reads so millisecond-resolution nondeterminism
			// (e.g. `() => new Date()`) cannot alias between them — codegen
			// runs offline, so a ~3ms spin per default is negligible.
			const spinStart = performance.now();
			while (performance.now() - spinStart < 3) {
				// spin
			}
			const second = def.defaultValue;
			if (serializeDefaultValue(second) !== serializeDefaultValue(evaluated)) {
				throw new DrizzleValidatorsError(
					`Cannot serialize a lazy .default(() => ...) default to static code — ` +
						`emitting it would freeze a single snapshot value at generation time. ` +
						`Use refineZSchema() with .default() at runtime, or provide a concrete default value.`,
				);
			}
			return `${zodTypeToCode(def.innerType, cache, depth + 1, opts)}.default(${serializeDefaultValue(evaluated)})`;
		}
		case "readonly":
			return `${zodTypeToCode(def.innerType, cache, depth + 1, opts)}.readonly()`;
		case "catch": {
			// zod 4 stores catchValue as a plain function even for static
			// catches — indistinguishable from a lazy computation at the def
			// level, so calling it would risk freezing one snapshot (P2-04).
			// Fail loud like lazy defaults do.
			throw new DrizzleValidatorsError(
				`Cannot serialize a .catch(...) wrapper to static code — ` +
					`zod stores the catch value as a function, and emitting it would ` +
					`freeze a single snapshot value at generation time. ` +
					`Handle the fallback at runtime (e.g. via refineZSchema() or .catch() on the imported schema).`,
			);
		}
		case "array": {
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
			return `z.array(${zodTypeToCode(def.element, cache, depth + 1, opts)})${parts.join("")}`;
		}
		case "object": {
			const shape = def.shape;
			if (!shape) {
				throw new DrizzleValidatorsError(
					`Object schema is missing a shape during serialization.`,
				);
			}
			// Symbol-keyed fields (finding P2-16): Object.entries() silently
			// drops them, so the emitted z.object({}) accepted inputs that the
			// original rejected (and lost typed field semantics). Fail loud.
			const symbolKeys = Object.getOwnPropertySymbols(shape);
			if (symbolKeys.length > 0) {
				throw new DrizzleValidatorsError(
					`Object shape has ${symbolKeys.length} symbol-keyed field(s) — ` +
						`Symbol keys cannot round-trip to static code. Re-model with string keys.`,
				);
			}
			const fields = Object.entries(shape)
				.map(
					([key, val]) =>
						`  ${JSON.stringify(key)}: ${zodTypeToCode(val as ZodTypeAny, cache, depth + 1, opts)},`,
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
				return `z.object({\n${fields}\n}).catchall(${zodTypeToCode(def.catchall, cache, depth + 1, opts)})`;
			}
			return `z.object({\n${fields}\n})`;
		}
		default:
			// Keep the build from silently emitting wrong/incomplete validation.
			throw new DrizzleValidatorsError(
				`Unsupported Zod type "${def.type}". ` +
					`Add a case in zodTypeToCode() for it.`,
			);
	}
}
