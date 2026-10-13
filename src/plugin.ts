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

import { rm } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { Plugin } from "vite";
import {
	computeCacheKey,
	generatedEquals,
	hashInputFiles,
	loadCachedData,
	saveCachedData,
} from "./cache";
import { RESOLVED_PREFIX } from "./constants";
import {
	findDrizzleConfigPath,
	resolveSchemaPath,
} from "./drizzle-config";
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

	// The drizzle config file that resolved the schema path (auto-detected
	// only — when schemaPath is explicit there is nothing to watch, P5).
	let watchedConfigPath: string | undefined;

	let cachedData: GeneratedData | null = null;

	let pendingGeneration: Promise<GeneratedData> | null = null;

	async function generateAndMaybeWrite(
		forceRegen = false,
	): Promise<GeneratedData> {
		// Hard regeneration: wipe the in-memory cache
		if (forceRegen || noCache) {
			cachedData = null;
			// Wait for any in-flight generation to complete before starting
			// fresh, so we don't have two concurrent builds.
			if (pendingGeneration) await pendingGeneration.catch(() => {});
		}

		// Deduplication layer (unconditional)
		if (pendingGeneration) return pendingGeneration;

		// Soft cache hit (only when caching is on)
		if (!noCache && cachedData) return cachedData;

		pendingGeneration = _generateAndMaybeWrite(forceRegen).finally(() => {
			pendingGeneration = null;
		});

		return pendingGeneration;
	}

	async function _generateAndMaybeWrite(
		forceRegen = false,
	): Promise<GeneratedData> {
		const schemaPath = await ensureSchemaPath();
		const paths = getResolvedPaths(schemaPath, options, viteRoot, splitByTable);
		const key = computeCacheKey({
			projectRoot: viteRoot,
			absoluteSchemaPath: paths.absoluteSchemaPath,
			tables: options.tables,
			moduleId,
		});

		let data: GeneratedData | null = null;

		// Persistent disk-cache fast path (P1): skip the esbuild bundle +
		// dynamic import + serialization when a recorded dependency graph with
		// identical contents has been generated before (e.g. dev-server
		// restart, same-schema CI run). Skipped on forceRegen so the watcher
		// always rebuilds from the real files, then detects no-op via
		// generatedEquals in the caller.
		if (!noCache && !forceRegen) {
			data = await loadCachedData(viteRoot, key).catch(() => null);
			if (data) cachedData = data;
		}

		if (data === null) {
			data = await generateSchemas({
				absoluteSchemaPath: paths.absoluteSchemaPath,
				schemaPath,
				tmpDir: paths.tmpDir,
				viteRoot,
				tables: options.tables,
				moduleId,
			});
			cachedData = data;
			if (!noCache) {
				// Version the cache entry with the hashed dependency contents.
				const inputsHash = await hashInputFiles(data.depPaths);
				if (inputsHash) {
					await saveCachedData(viteRoot, key, data, inputsHash).catch(
						() => {},
					);
				}
			}
		}

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
			// Mutable copy so a config-file change can repoint us at a new
			// schema path (P5).
			let currentAbsoluteSchemaPath = absoluteSchemaPath;

			// Watch the drizzle config file when the schema path was
			// auto-detected (P5): an edit there can point at a new schema, so
			// we drop the cached schema path and re-run auto-detection, then
			// regenerate. Explicit schemaPath has nothing to watch.
			if (!options.schemaPath) {
				try {
					const configPath = await findDrizzleConfigPath({
						projectRoot: viteRoot,
					});
					if (configPath) {
						watchedConfigPath = configPath;
						server.watcher.add(configPath);
					}
				} catch {
					// best-effort; nothing to watch
				}
			}

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

			// Unified handler for change/add/unlink events (finding M5):
			//  - "add"/"change" on the schema or a watched dependency triggers
			//    regeneration (a newly created file can satisfy an import that
			//    previously failed).
			//  - "unlink" cleans up the tracked path so a re-created file gets
			//    re-added to the watcher.
			//  - regeneration errors are caught so a transient failure (e.g.
			//    mid-edit syntax error) doesn't crash the dev server; the next
			//    successful save regenerates.
			const handleFileEvent = (file: string) => {
				const resolvedFile = resolvePath(file);
				if (
					resolvedFile === currentAbsoluteSchemaPath ||
					resolvedFile === watchedConfigPath ||
					watchedDeps.has(resolvedFile)
				) {
					if (debounceTimer) clearTimeout(debounceTimer);
					debounceTimer = setTimeout(async () => {
						debounceTimer = undefined;
						try {
							// Snapshot BEFORE regen wipes the in-memory cache —
							// used for no-op detection below.
							const prevData = cachedData;

							// A config edit may change the schema path, so forget
							// the resolved path and any dependency watchers that
							// belonged to the previous configuration.
							if (resolvedFile === watchedConfigPath) {
								resolvedSchemaPath = undefined;
								for (const p of watchedDeps) {
									server.watcher.unwatch(p);
								}
								watchedDeps.clear();
							}

							const data = await generateAndMaybeWrite(true);
							if (!data) return;

							// Refresh which schema path we track after a config
							// change (the freshly resolved one).
							if (resolvedFile === watchedConfigPath) {
								ensureSchemaPath()
									.then((sp) => {
										currentAbsoluteSchemaPath = getResolvedPaths(
											sp,
											options,
											viteRoot,
											splitByTable,
										).absoluteSchemaPath;
									})
									.catch(() => {});
							}

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
							// P2: no-op detection — skip the browser reload when
							// the regenerated output is byte-identical to what
							// we had (e.g. a schema comment edit, or a touched
							// dependency that doesn't change generated code).
							if (generatedEquals(prevData, data)) return;
							server.ws.send({ type: "full-reload" });
						} catch (err) {
							server.config.logger.error(
								`[drizzle-zod-virtual] Regeneration failed (will retry on next change): ${err instanceof Error ? err.message : String(err)}`,
							);
						}
					}, 150);
				}
			};

			server.watcher.on("change", handleFileEvent);
			server.watcher.on("add", handleFileEvent);
			server.watcher.on("unlink", (file) => {
				const resolvedFile = resolvePath(file);
				watchedDeps.delete(resolvedFile);
			});
		},

		// Best-effort tmp cleanup (P4) at the end of a library build.
		// configureServer also cleans up when the dev server closes. Any
		// failure is ignored.
		async buildEnd() {
			const schemaPath = await ensureSchemaPath().catch(() => undefined);
			if (!schemaPath) return;
			const { tmpDir } = getResolvedPaths(
				schemaPath,
				options,
				viteRoot,
				splitByTable,
			);
			await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		},
	};
}
