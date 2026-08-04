// vite-plugin-drizzle-zod-virtual.ts
//
// Generates Zod schemas from your Drizzle tables at build/dev time (Node/server
// context only) and exposes them as a virtual module containing PLAIN Zod code.
// No `drizzle-orm` / `drizzle-zod` import ever reaches client bundles.
//
// Usage in vite.config.ts:
//
//   import { drizzleZodVirtual } from './vite-plugin-drizzle-zod-virtual'
//
//   export default defineConfig({
//     plugins: [
//       drizzleZodVirtual({
//         schemaPath: './src/server/db/schema.ts',
//         // tables: ['users', 'appointments'],  // omit to auto-detect ALL tables
//         outputPath: './zod-schemas/generated.ts', // optional: real file to inspect
//       }),
//     ],
//   })
//
// Then anywhere in client OR server code:
//
//   import { usersInsertSchema, appointmentsSelectSchema } from 'virtual:drizzle-zod'
//
// That module contains only `z.object(...)` calls — safe to import from
// client components, forms, React Hook Form resolvers, etc.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
	dirname,
	isAbsolute,
	join as joinPath,
	relative,
	resolve as resolvePath,
} from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import type { Plugin } from "vite";
import type { ZodTypeAny } from "zod";

export interface DrizzleZodVirtualOptions {
	/** Path to the file exporting your Drizzle tables (server-only file). */
	schemaPath: string;
	/**
	 * Names of the exported table objects to generate schemas for.
	 * Omit to auto-detect every exported Drizzle table in schemaPath.
	 */
	tables?: string[];
	/** Virtual module id clients will import from. Defaults to 'virtual:drizzle-zod'. */
	moduleId?: string;
	/**
	 * Also write the generated Zod source to a real file on disk (relative to
	 * project root) — used both so you can inspect/diff it, AND so a matching
	 * .d.ts shim can give the virtual module real, fully-inferred TypeScript
	 * types instead of `any`. Defaults to './.drizzle-zod-generated/schemas.ts'.
	 */
	outputPath?: string;
}

const RESOLVED_PREFIX = "\0";

// --- Zod 4 -> source-code serializer ---------------------------------------
// Built against Zod 4's ACTUAL internal shape (verified against zod@4.4.3):
//   - discriminator is `def.type` (a plain string: 'string', 'object', 'optional'...)
//     NOT `def.typeName` (that was Zod 3's convention, e.g. 'ZodString')
//   - object fields live at `def.shape` directly (a plain object), not `def.shape()`
//   - enum values live at `def.entries` (an object map), not `def.values` (an array)
//   - wrapper types (optional/nullable/default) nest via `def.innerType`
// Extend the switch below as you use more Zod types (arrays, unions, records...).
function zodTypeToCode(schema: ZodTypeAny): string {
	const def = (schema as any)._def ?? (schema as any).def;

	if (!def || typeof def.type !== "string") {
		throw new Error(
			`[drizzle-zod-virtual] Could not read a valid def.type from schema. ` +
				`Got: ${JSON.stringify(def)}`,
		);
	}

	switch (def.type) {
		case "string": {
			let format = def.format;
			if (!format && Array.isArray(def.checks)) {
				for (const check of def.checks) {
					if (check?.format) {
						format = check.format;
						break;
					}
					if (check?.def?.format) {
						format = check.def.format;
						break;
					}
				}
			}
			const knownFormats = [
				"uuid",
				"email",
				"url",
				"cuid",
				"cuid2",
				"ulid",
				"emoji",
				"ipv4",
				"ipv6",
			];
			if (format && knownFormats.includes(format)) {
				return def.coerce ? `z.coerce.string().${format}()` : `z.${format}()`;
			}
			return def.coerce ? "z.coerce.string()" : "z.string()";
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
			return `z.tuple([${(items as ZodTypeAny[]).map(zodTypeToCode).join(", ")}])`;
		}
		case "intersection":
			return `z.intersection(${zodTypeToCode(def.left)}, ${zodTypeToCode(def.right)})`;
		case "record":
			return `z.record(${zodTypeToCode(def.keyType)}, ${zodTypeToCode(def.valueType)})`;
		case "set":
			return `z.set(${zodTypeToCode(def.valueType)})`;
		case "map":
			return `z.map(${zodTypeToCode(def.keyType)}, ${zodTypeToCode(def.valueType)})`;
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
			return `z.union([${(def.options as ZodTypeAny[]).map(zodTypeToCode).join(", ")}])`;
		case "enum": {
			const entries = def.entries
				? Object.keys(def.entries)
				: Array.isArray(def.values)
				? def.values
				: [];
			return `z.enum(${JSON.stringify(entries)})`;
		}
		case "optional":
			return `${zodTypeToCode(def.innerType)}.optional()`;
		case "nullable":
			return `${zodTypeToCode(def.innerType)}.nullable()`;
		case "default": {
			const defaultVal = typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue;
			return `${zodTypeToCode(def.innerType)}.default(${JSON.stringify(defaultVal)})`;
		}
		case "array":
			return `z.array(${zodTypeToCode(def.element)})`;
		case "object": {
			const shape = def.shape;
			const fields = Object.entries(shape)
				.map(
					([key, val]) =>
						`  ${JSON.stringify(key)}: ${zodTypeToCode(val as ZodTypeAny)},`,
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

export function drizzleZodVirtual(options: DrizzleZodVirtualOptions): Plugin {
	const moduleId = options.moduleId ?? "virtual:drizzle-zod";
	const resolvedId = RESOLVED_PREFIX + moduleId;

	let cachedCode: string | null = null;

	// Resolve once, relative to the project root (cwd), NOT relative to
	// wherever Vite happens to bundle this plugin file at runtime
	// (e.g. node_modules/.vite-temp/...), which was causing ERR_MODULE_NOT_FOUND.
	const absoluteSchemaPath = isAbsolute(options.schemaPath)
		? options.schemaPath
		: resolvePath(process.cwd(), options.schemaPath);

	// Real file the generated Zod source is written to. Defaulted (not just
	// optional) because a matching .d.ts shim needs it to exist in order to
	// give the virtual module real, inferred TypeScript types.
	const absoluteOutputPath = isAbsolute(options.outputPath ?? "")
		? (options.outputPath as string)
		: resolvePath(
				process.cwd(),
				options.outputPath ?? "./.drizzle-zod-generated/schemas.ts",
			);
	const dtsPath = resolvePath(
		dirname(absoluteOutputPath),
		"virtual-drizzle-zod.d.ts",
	);

	// Temp output location. Placed inside node_modules so that when we
	// dynamic-import it, Node's normal bare-specifier resolution (walking up
	// directories looking for node_modules) finds your real drizzle-orm, zod,
	// etc. installs — those are marked external below, not bundled.
	const tmpDir = joinPath(
		process.cwd(),
		"node_modules",
		".drizzle-zod-virtual-tmp",
	);

	async function generate(): Promise<{
		code: string;
		exportNames: string[];
		tableCodes: Map<string, { code: string; exportNames: string[] }>;
	}> {
		// Dynamic import so drizzle-orm/drizzle-zod are only ever touched
		// inside this Node-only plugin process, never bundled for the client.
		const { createInsertSchema, createSelectSchema, createUpdateSchema } =
			await import("drizzle-orm/zod");
		const { is, Table } = await import("drizzle-orm");

		// Bundle ONLY the schema file's local/aliased imports with esbuild.
		// esbuild auto-detects tsconfig.json and natively resolves
		// "compilerOptions.paths" aliases (e.g. "@/database/..."), which is
		// exactly what raw Node import() and Vite's ssrLoadModule both failed
		// to do in this project's setup (non-runnable ssr environment).
		// `packages: 'external'` keeps real node_modules deps (drizzle-orm, etc.)
		// as plain imports instead of inlining them, so Node resolves them
		// normally from node_modules after the fact.
		const result = await esbuild.build({
			entryPoints: [absoluteSchemaPath],
			bundle: true,
			platform: "node",
			format: "esm",
			packages: "external",
			write: false,
			logLevel: "silent",
		});

		const bundledCode = result.outputFiles[0]?.text;
		if (!bundledCode) {
			throw new Error("[drizzle-zod-virtual] Failed to bundle schema file");
		}

		mkdirSync(tmpDir, { recursive: true });
		const tmpFile = joinPath(tmpDir, `schema-${Date.now()}.mjs`);
		writeFileSync(tmpFile, bundledCode);

		let schemaModule: any;
		try {
			schemaModule = await import(pathToFileURL(tmpFile).href);
		} finally {
			rmSync(tmpFile, { force: true });
		}

		const chunks: string[] = [
			"// AUTO-GENERATED by vite-plugin-drizzle-zod-virtual. Do not edit.",
			"import * as z from 'zod'",
			"",
		];

		// Auto-detect: if no explicit table list, keep every export that is
		// actually a Drizzle Table instance (skips enums, helper fns, etc.
		// that a schema barrel file might also export).
		const tableNames =
			options.tables ??
			Object.entries(schemaModule)
				.filter(([, value]) => is(value, Table))
				.map(([key]) => key);

		if (tableNames.length === 0) {
			throw new Error(
				`[drizzle-zod-virtual] No Drizzle tables found in ${absoluteSchemaPath}. ` +
					`Either export some pgTable(...) values from it, or pass an explicit "tables" option.`,
			);
		}

		const exportNames: string[] = [];
		const tableCodes = new Map<
			string,
			{ code: string; exportNames: string[] }
		>();

		for (const tableName of tableNames) {
			const table = schemaModule[tableName];
			if (!table) {
				throw new Error(
					`[drizzle-zod-virtual] Table "${tableName}" not exported from ${options.schemaPath}`,
				);
			}

			const insertSchema = createInsertSchema(table);
			const selectSchema = createSelectSchema(table);
			const updateSchema = createUpdateSchema(table);

			const names = [
				`${tableName}InsertSchema`,
				`${tableName}SelectSchema`,
				`${tableName}UpdateSchema`,
			];
			exportNames.push(...names);

			const insertCode = zodTypeToCode(insertSchema);
			const selectCode = zodTypeToCode(selectSchema);
			const updateCode = zodTypeToCode(updateSchema);

			chunks.push(`export const ${names[0]} = ${insertCode}`);
			chunks.push(`export const ${names[1]} = ${selectCode}`);
			chunks.push(`export const ${names[2]} = ${updateCode}`);
			chunks.push("");

			const subModuleChunks = [
				"// AUTO-GENERATED by vite-plugin-drizzle-zod-virtual. Do not edit.",
				"import * as z from 'zod'",
				"",
				`export const insertSchema = ${insertCode}`,
				`export const selectSchema = ${selectCode}`,
				`export const updateSchema = ${updateCode}`,
			];

			tableCodes.set(tableName, {
				code: subModuleChunks.join("\n"),
				exportNames: names,
			});
		}

		return { code: chunks.join("\n"), exportNames, tableCodes };
	}

	let cachedData: {
		code: string;
		exportNames: string[];
		tableCodes: Map<string, { code: string; exportNames: string[] }>;
	} | null = null;

	async function generateAndMaybeWrite() {
		const data = await generate();
		cachedData = data;

		mkdirSync(dirname(absoluteOutputPath), { recursive: true });
		writeFileSync(absoluteOutputPath, data.code);

		// Compute a relative import path from the .d.ts location to the real
		// schema file, POSIX-style and without extension (TS module specifier
		// conventions), e.g. "./schemas".
		let relImport = relative(dirname(dtsPath), absoluteOutputPath)
			.replace(/\\/g, "/")
			.replace(/\.ts$/, "");
		if (!relImport.startsWith(".")) relImport = `./${relImport}`;

		// IMPORTANT: neither `export * from '...'` NOR a static `import {x as
		// _x} from '...'; export const x: typeof _x` inside a `declare module
		// 'bare-specifier' { ... }` block preserves the real type here — both
		// were verified (via isolated tsc repros) to silently degrade to `any`
		// even though the member "exists" with no compile error. The pattern
		// that actually works is the `import()` TYPE QUERY form below — a
		// genuinely different TS mechanism (no static import binding at all).
		const rootExportLines = data.exportNames
			.map(
				(name) =>
					`export const ${name}: (typeof import('${relImport}'))['${name}']`,
			)
			.join("\n  ");

		const subModuleDeclarations: string[] = [];
		for (const tableName of data.tableCodes.keys()) {
			const insertName = `${tableName}InsertSchema`;
			const selectName = `${tableName}SelectSchema`;
			const updateName = `${tableName}UpdateSchema`;

			const aliasLines = [
				`export const insertSchema: (typeof import('${relImport}'))['${insertName}']`,
				`export const selectSchema: (typeof import('${relImport}'))['${selectName}']`,
				`export const updateSchema: (typeof import('${relImport}'))['${updateName}']`,
			].join("\n  ");

			subModuleDeclarations.push(
				`declare module '${moduleId}/${tableName}' {\n  ${aliasLines}\n}`,
			);
		}

		const dts =
			`// AUTO-GENERATED by vite-plugin-drizzle-zod-virtual. Do not edit.\n` +
			`// Gives '${moduleId}' real, fully-inferred TypeScript types via the\n` +
			`// "(typeof import('...'))['x']" type-query form.\n` +
			`declare module '${moduleId}' {\n` +
			`  ${rootExportLines}\n` +
			`}\n\n` +
			subModuleDeclarations.join("\n\n") +
			"\n";

		writeFileSync(dtsPath, dts);

		try {
			const nodeTypesDir = joinPath(
				process.cwd(),
				"node_modules",
				"@types",
				"virtual-drizzle-zod",
			);
			mkdirSync(nodeTypesDir, { recursive: true });
			writeFileSync(joinPath(nodeTypesDir, "index.d.ts"), dts);
		} catch {
			// Ignore if node_modules/@types cannot be written to
		}

		console.log(
			`[drizzle-zod-virtual] wrote ${absoluteOutputPath} + ${dtsPath} (cwd: ${process.cwd()})`,
		);

		return data;
	}

	return {
		name: "vite-plugin-drizzle-zod-virtual",
		enforce: "pre",

		resolveId(id) {
			if (id === moduleId) return resolvedId;
			if (id.startsWith(`${moduleId}/`)) return `${RESOLVED_PREFIX}${id}`;
		},

		async load(id) {
			if (!id.startsWith(RESOLVED_PREFIX + moduleId)) return;
			if (!cachedData) {
				await generateAndMaybeWrite();
			}

			if (id === resolvedId) {
				return cachedData?.code;
			}

			const subPath = id.slice(RESOLVED_PREFIX.length + moduleId.length + 1);
			const subModule = cachedData?.tableCodes.get(subPath);
			if (subModule) {
				return subModule.code;
			}

			throw new Error(
				`[drizzle-zod-virtual] Table "${subPath}" not found in schema module exports.`,
			);
		},

		configureServer(server) {
			// Regenerate + trigger HMR when the schema file changes in dev.
			server.watcher.add(absoluteSchemaPath);
			server.watcher.on("change", async (file) => {
				if (resolvePath(file) === absoluteSchemaPath) {
					await generateAndMaybeWrite();
					const mod = server.moduleGraph.getModuleById(resolvedId);
					if (mod) {
						server.moduleGraph.invalidateModule(mod);
					}
					if (cachedData) {
						for (const tableName of cachedData.tableCodes.keys()) {
							const subMod = server.moduleGraph.getModuleById(
								`${RESOLVED_PREFIX}${moduleId}/${tableName}`,
							);
							if (subMod) {
								server.moduleGraph.invalidateModule(subMod);
							}
						}
					}
					server.ws.send({ type: "full-reload" });
				}
			});
		},
	};
}
