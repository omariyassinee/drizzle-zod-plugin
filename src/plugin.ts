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

import { resolve as resolvePath } from "node:path";
import type { Plugin } from "vite";
import { RESOLVED_PREFIX } from "./constants";
import { resolveSchemaPath } from "./drizzle-config";
import { writeGeneratedFiles } from "./file-writer";
import { getResolvedPaths } from "./paths";
import { generateSchemas } from "./schema-generator";
import type { DrizzleZodVirtualOptions, GeneratedData } from "./types";

export type { DrizzleZodVirtualOptions } from "./types";

export function drizzleZodVirtual(
	options: DrizzleZodVirtualOptions = {},
): Plugin {
	const moduleId = options.moduleId ?? "virtual:drizzle-zod";
	const resolvedId = RESOLVED_PREFIX + moduleId;
	const splitByTable = options.splitByTable ?? true;

	const noCache = options.noCache ?? false;

	let viteRoot = process.cwd();
	const watchedDeps = new Set<string>();

	// Resolved once (lazily) — either from options.schemaPath or drizzle config
	let resolvedSchemaPath: string | undefined;

	async function ensureSchemaPath(): Promise<string> {
		if (!resolvedSchemaPath) {
			resolvedSchemaPath = await resolveSchemaPath({
				schemaPath: options.schemaPath,
				projectRoot: viteRoot,
			});
		}
		return resolvedSchemaPath;
	}

	let cachedData: GeneratedData | null = null;

	let pendingGeneration: Promise<GeneratedData> | null = null;

	async function generateAndMaybeWrite(
		forceRegen = false,
	): Promise<GeneratedData> {
		// Hard regeneration: wipe cachedData
		if (forceRegen || noCache) {
			cachedData = null;
			// Wait for any in-flight generation to complete before starting fresh,
			// so we don't have two concurrent builds.
			if (pendingGeneration) await pendingGeneration.catch(() => {});
		}

		// Deduplication layer (unconditional)
		if (pendingGeneration) return pendingGeneration;

		// Soft cache hit (only when caching is on)
		if (!noCache && cachedData) return cachedData;

		pendingGeneration = _generateAndMaybeWrite().finally(() => {
			pendingGeneration = null;
		});

		return pendingGeneration;
	}

	async function _generateAndMaybeWrite(): Promise<GeneratedData> {
		const schemaPath = await ensureSchemaPath();
		const paths = getResolvedPaths(schemaPath, options, viteRoot, splitByTable);
		const data = await generateSchemas({
			absoluteSchemaPath: paths.absoluteSchemaPath,
			schemaPath,
			tmpDir: paths.tmpDir,
			viteRoot,
			tables: options.tables,
			moduleId,
		});
		cachedData = data;

		await writeGeneratedFiles({
			paths,
			options,
			viteRoot,
			splitByTable,
			moduleId,
			data,
		});

		return data;
	}

	return {
		name: "vite-plugin-drizzle-zod-virtual",
		enforce: "pre",

		configResolved(config) {
			if (config.root) {
				viteRoot = config.root;
				// Reset resolved schema path since viteRoot changed
				resolvedSchemaPath = undefined;
			}
		},

		async buildStart() {
			await generateAndMaybeWrite();
		},

		resolveId(id) {
			if (id === moduleId) return resolvedId;
			if (id.startsWith(`${moduleId}/`)) return `${RESOLVED_PREFIX}${id}`;
		},

		async load(id) {
			if (!id.startsWith(RESOLVED_PREFIX + moduleId)) return;
			const data = await generateAndMaybeWrite();

			if (id === resolvedId) {
				return data.code;
			}

			const subPath = id.slice(RESOLVED_PREFIX.length + moduleId.length + 1);
			const subModule = data.tableCodes.get(subPath);
			if (subModule) {
				return subModule.code;
			}

			throw new Error(
				`[drizzle-zod-virtual] Table "${subPath}" not found in schema module exports.`,
			);
		},

		async configureServer(server) {
			const schemaPath = await ensureSchemaPath();
			const { absoluteSchemaPath } = getResolvedPaths(
				schemaPath,
				options,
				viteRoot,
				splitByTable,
			);

			const warmUp = async () => {
				const data = await generateAndMaybeWrite();
				if (!data) return;
				for (const p of data.depPaths) {
					if (!watchedDeps.has(p)) {
						watchedDeps.add(p);
						server.watcher.add(p);
					}
				}
			};
			warmUp().catch(() => {});

			let debounceTimer: ReturnType<typeof setTimeout> | undefined;

			server.watcher.on("change", (file) => {
				const resolvedFile = resolvePath(file);
				if (
					resolvedFile === absoluteSchemaPath ||
					watchedDeps.has(resolvedFile)
				) {
					if (debounceTimer) clearTimeout(debounceTimer);
					debounceTimer = setTimeout(async () => {
						debounceTimer = undefined;
						const data = await generateAndMaybeWrite(true);
						if (!data) return;
						for (const p of data.depPaths) {
							if (!watchedDeps.has(p)) {
								watchedDeps.add(p);
								server.watcher.add(p);
							}
						}
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
					}, 150);
				}
			});
		},
	};
}
