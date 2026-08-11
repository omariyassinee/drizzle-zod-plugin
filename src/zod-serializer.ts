import type { ZodTypeAny } from "zod";
import { KNOWN_FORMATS, MAX_RECURSION_DEPTH } from "./constants";

type StringCheckCtx = {
	singleFormat: string | undefined;
	chainParts: string[];
	def: any;
};

const STRING_CHECK_HANDLERS = new Map<
	string,
	(zodDef: any, ctx: StringCheckCtx) => void
>([
	[
		"max_length",
		(zodDef, ctx) => {
			if (typeof zodDef.maximum === "number")
				ctx.chainParts.push(`.max(${zodDef.maximum})`);
		},
	],
	[
		"min_length",
		(zodDef, ctx) => {
			if (typeof zodDef.minimum === "number")
				ctx.chainParts.push(`.min(${zodDef.minimum})`);
		},
	],
	[
		"length_equals",
		(zodDef, ctx) => {
			if (typeof zodDef.length === "number")
				ctx.chainParts.push(`.length(${zodDef.length})`);
		},
	],
	[
		"string_format",
		(zodDef, ctx) => {
			if (zodDef.format === "regex" && zodDef.pattern instanceof RegExp) {
				ctx.chainParts.push(`.regex(${zodDef.pattern.toString()})`);
			} else if (zodDef.format && KNOWN_FORMATS.has(zodDef.format)) {
				if (ctx.singleFormat && ctx.singleFormat !== zodDef.format) {
					ctx.chainParts.push(`.${zodDef.format}()`);
				} else if (ctx.def.coerce) {
					ctx.chainParts.push(`.${zodDef.format}()`);
				} else {
					ctx.singleFormat = zodDef.format;
				}
			}
		},
	],
]);

export function serializeDefaultValue(value: unknown): string {
	if (typeof value === "bigint") {
		return `${value}n`;
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
	const result = "/* @__PURE__ */ " + _zodTypeToCode(schema, cache, depth);
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
			let singleFormat: string | undefined = def.format;
			const chainParts: string[] = [];

			if (Array.isArray(def.checks)) {
				const ctx: StringCheckCtx = { singleFormat, chainParts, def };
				for (const check of def.checks) {
					const zodDef = check?._zod?.def ?? check?.def;
					if (!zodDef) continue;
					const handler = STRING_CHECK_HANDLERS.get(zodDef.check);
					if (handler) handler(zodDef, ctx);
				}
				singleFormat = ctx.singleFormat;
			}

			if (singleFormat && KNOWN_FORMATS.has(singleFormat) && !def.coerce) {
				return `z.${singleFormat}()${chainParts.join("")}`;
			}

			const base = def.coerce ? "z.coerce.string()" : "z.string()";
			return base + chainParts.join("");
		}
		case "number":
			return def.coerce ? "z.coerce.number()" : "z.number()";
		case "boolean":
			return def.coerce ? "z.coerce.boolean()" : "z.boolean()";
		case "date":
			return def.coerce ? "z.coerce.date()" : "z.date()";
		case "bigint":
			return def.coerce ? "z.coerce.bigint()" : "z.bigint()";
		case "any":
			return "z.any()";
		case "unknown":
			return "z.unknown()";
		case "custom":
			return "z.custom()";
		case "literal": {
			const val = def.values ? def.values[0] : def.value;
			return `z.literal(${JSON.stringify(val)})`;
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
		case "optional":
			return `${zodTypeToCode(def.innerType, cache, depth + 1)}.optional()`;
		case "nullable":
			return `${zodTypeToCode(def.innerType, cache, depth + 1)}.nullable()`;
		case "default": {
			const defaultVal =
				typeof def.defaultValue === "function"
					? def.defaultValue()
					: def.defaultValue;
			return `${zodTypeToCode(def.innerType, cache, depth + 1)}.default(${serializeDefaultValue(defaultVal)})`;
		}
		case "array":
			return `z.array(${zodTypeToCode(def.element, cache, depth + 1)})`;
		case "object": {
			const shape = def.shape;
			const fields = Object.entries(shape)
				.map(
					([key, val]) =>
						`  ${JSON.stringify(key)}: ${zodTypeToCode(val as ZodTypeAny, cache, depth + 1)},`,
				)
				.join("\n");
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
