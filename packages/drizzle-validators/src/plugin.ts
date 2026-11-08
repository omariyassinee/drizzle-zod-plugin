// plugin.ts
//
// Generates validation schemas (Zod by default; Valibot/TypeBox via `target`)
// from your Drizzle tables at build/dev time (Node/server context only) and
// exposes them as a virtual module containing PLAIN validator code.
// No `drizzle-orm` / `drizzle-zod` import ever reaches client bundles.
//
// Usage in vite.config.ts:
//
//   import { drizzleValidators } from '@vacuus/drizzle-validators'
//
//   export default defineConfig({
//     plugins: [
//       drizzleValidators("zod", {
//         schemaPath: './src/server/db/schema.ts',
//         // tables: ['users', 'appointments'],  // omit to auto-detect ALL tables
//         outputPath: './validators', // optional: real files for inspection
//       }),
//     ],
//   })
//
// Then anywhere in client OR server code:
//
//   import { usersInsertSchema, appointmentsSelectSchema } from 'virtual:drizzle-validators'
//
// That module contains only plain schema calls — safe to import from
// client components, forms, React Hook Form resolvers, etc.

import { rmdir } from "node:fs/promises";
import { DrizzleValidatorsError } from "./errors";
import { resolve as resolvePath } from "node:path";
import type { Plugin } from "vite";
import {
	computeCacheKey,
	generatedEquals,
	hashInputFiles,
	loadCachedData,
	saveCachedData,
} from "./cache";
import { defaultModuleId, isValidTarget, loadAdapter } from "./adapters";
import { readGeneratedArtifacts } from "./artifacts";
import { formatError } from "./errors";
import { RESOLVED_PREFIX } from "./constants";
import {
	findDrizzleConfigPath,
	resolveSchemaPath,
} from "./drizzle-config";
import { writeGeneratedFiles } from "./file-writer";
import { getResolvedPaths } from "./paths";
import { generateSchemas } from "./schema-generator";
import type { ValidatorTarget } from "./adapters/types";
import type { DrizzleValidatorsOptions, GeneratedData } from "./types";

export type { DrizzleValidatorsOptions } from "./types";
export type { ValidatorTarget } from "./adapters/types";

export function drizzleValidators(
	target: ValidatorTarget,
	options: DrizzleValidatorsOptions = {},
): Plugin {
	if (!isValidTarget(target)) {
		throw new DrizzleValidatorsError(
			`Unknown validator target "${String(target)}". ` +
				`Expected "zod", "valibot", or "typebox".`,
		);
	}
	const moduleId = options.moduleId ?? defaultModuleId();
	const resolvedId = RESOLVED_PREFIX + moduleId;
	const splitByTable = options.splitByTable ?? true;

	const useCache = options.useCache ?? false;
	const regenOnBuild = options.regenOnBuild ?? false;

	let viteRoot = process.cwd();
	// Set from configResolved: the skip path only applies to production
	// builds — dev servers always regenerate.
	let isBuild = false;
	// Memoized artifact read for the build artifact path (failure included —
	// a missing-artifact error stays memoized so every load surfaces it).
	let skippedArtifacts: Promise<GeneratedData> | null = null;
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
		if (forceRegen) {
			cachedData = null;
			// Wait for any in-flight generation to complete before starting
			// fresh, so we don't have two concurrent builds.
			if (pendingGeneration) await pendingGeneration.catch(() => {});
		}

		// Deduplication layer (unconditional)
		if (pendingGeneration) return pendingGeneration;

		// Soft cache hit (dev only — caches are disabled in builds)
		if (useCache && !isBuild && cachedData) return cachedData;

		pendingGeneration = _generateAndMaybeWrite(forceRegen).finally(() => {
			pendingGeneration = null;
		});

		return pendingGeneration;
	}

	/**
	 * Build serving path (regenOnBuild off): reconstruct the
	 * virtual-module content from previously written generated files.
	 * Never generates — if no artifacts exist the memoized rejection
	 * surfaces an actionable error on every load.
	 */
	function loadSkippedArtifacts(): Promise<GeneratedData> {
		if (!skippedArtifacts) {
			skippedArtifacts = (async () => {
				const schemaPath = await ensureSchemaPath();
				const paths = getResolvedPaths(
					schemaPath,
					options,
					viteRoot,
					splitByTable,
				);
				const adapter = await loadAdapter(target);
				const data = await readGeneratedArtifacts({
					outputDir: paths.absoluteOutputDir,
					absoluteOutputPath: paths.absoluteOutputPath,
					splitByTable,
					moduleId,
					target: adapter.target,
					importStatement: adapter.importStatement,
					refineExportStatement: adapter.refineExportStatement,
				});
				if (!data) {
					throw new DrizzleValidatorsError(
						`No generated files were found in ` +
							`${paths.absoluteOutputDir}. Run \`dv generate\` first (or one build with ` +
							`regenOnBuild: true), or point outputPath at the directory holding them.`,
					);
				}
				return data;
			})();
		}
		return skippedArtifacts;
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
			target,
			bufferAs: options.bufferAs,
		});

		let data: GeneratedData | null = null;

		// Persistent disk-cache fast path (P1): skip the esbuild bundle +
		// dynamic import + serialization when a recorded dependency graph with
		// identical contents has been generated before (e.g. dev-server
		// restart, same-schema CI run). Skipped on forceRegen so the watcher
		// always rebuilds from the real files, then detects no-op via
		// generatedEquals in the caller.
		if (useCache && !isBuild && !forceRegen) {
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
				target,
				serializer: {
					bufferAs: options.bufferAs ?? "throw",
				},
			});
			cachedData = data;
			if (useCache) {
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
		name: "drizzle-validators",
		enforce: "pre",

		configResolved(config) {
			if (config.root) {
				viteRoot = config.root;
				// Reset resolved schema path since viteRoot changed
				resolvedSchemaPath = undefined;
			}
			// Build behavior is opt-in (regenOnBuild); dev servers always
			// regenerate (that is the plugin's job).
			isBuild = config.command === "build";
		},

		async buildStart() {
			if (isBuild && !regenOnBuild) return;
			await generateAndMaybeWrite();
		},

		resolveId(id) {
			if (id === moduleId) return resolvedId;
			if (id.startsWith(`${moduleId}/`)) return `${RESOLVED_PREFIX}${id}`;
		},

		async load(id) {
			if (!id.startsWith(RESOLVED_PREFIX + moduleId)) return;
			const data =
				isBuild && !regenOnBuild
					? await loadSkippedArtifacts()
					: await generateAndMaybeWrite();

			if (id === resolvedId) {
				return data.code;
			}

			const subPath = id.slice(RESOLVED_PREFIX.length + moduleId.length + 1);
			const subModule = data.tableCodes.get(subPath);
			if (subModule) {
				return subModule.code;
			}

			throw new DrizzleValidatorsError(
				`Table "${subPath}" not found in schema module exports.`,
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

			/**
			 * Re-runs config auto-detection and re-binds the watcher
			 * (finding P2-13). A config RENAME (write drizzle.config.prod.ts
			 * + delete the old one) permanently orphans the old binding —
			 * the plugin then silently ignores every config change until
			 * restart. Called from unlink/add handlers.
			 */
			const rebindConfigWatcher = async (): Promise<void> => {
				if (options.schemaPath) return;
				try {
					const configPath = await findDrizzleConfigPath({
						projectRoot: viteRoot,
					});
					if (configPath && configPath !== watchedConfigPath) {
						watchedConfigPath = configPath;
						server.watcher.add(configPath);
					}
				} catch {
					// best-effort; no config present right now
				}
			};

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
								`Regeneration failed (will retry on next change): ${err instanceof Error ? err.message : String(err)}`,
							);
						}
					}, 150);
				}
			};

			server.watcher.on("change", handleFileEvent);
			server.watcher.on("add", (file) => {
				// A (re-)added config file after a rename (finding P2-13): the
				// old binding is gone, so re-run auto-detection and re-bind.
				if (!options.schemaPath && !watchedConfigPath) {
					void rebindConfigWatcher().then(() => {
						if (resolvePath(file) === watchedConfigPath) {
							handleFileEvent(file);
						}
					});
				}
				handleFileEvent(file);
			});
			server.watcher.on("unlink", (file) => {
				const resolvedFile = resolvePath(file);
				if (resolvedFile === watchedConfigPath) {
					// The watched config was deleted/renamed away (finding
					// P2-13): re-run detection shortly, since the replacement
					// config usually lands a moment later.
					watchedConfigPath = undefined;
					resolvedSchemaPath = undefined;
					setTimeout(() => {
						void rebindConfigWatcher();
					}, 300);
				}
				watchedDeps.delete(resolvedFile);
			});

			/**
			 * Explicit dev-server shutdown cleanup (finding P2-12). The
			 * original claim — "configureServer also cleans up when the dev
			 * server closes" — had no code behind it; on vite ≥5 close-path
			 * `buildEnd` happens to fire, but that is a contract rental.
			 * vite dev servers emit a "close" event of their own; bind the
			 * cleanup to it (and to the underlying httpServer's "close") so
			 * the tmp dir never outlives the session.
			 */
			const cleanupTmpOnClose = async (): Promise<void> => {
				try {
					const schemaPath = await ensureSchemaPath();
					const { tmpDir } = getResolvedPaths(
						schemaPath,
						options,
						viteRoot,
						splitByTable,
					);
					// Non-recursive on purpose: multi-instance configs stage
					// bundles into the shared tmp dir concurrently, and a
					// recursive rm here can delete another instance's
					// in-flight file mid-import. rmdir only removes an EMPTY
					// dir; per-generation cleanup already removed each file.
					await rmdir(tmpDir).catch(() => {});
				} catch {
					// best-effort shutdown cleanup
				}
			};
			let cleanupRan = false;
			const runCleanupOnce = () => {
				if (cleanupRan) return;
				cleanupRan = true;
				void cleanupTmpOnClose();
			};
			(server as unknown as { on?: (ev: string, cb: () => void) => void }).on?.(
				"close",
				runCleanupOnce,
			);
			const httpServer = (
				server as unknown as {
					httpServer?: { once?: (ev: string, cb: () => void) => void };
				}
			).httpServer;
			httpServer?.once?.("close", runCleanupOnce);
		},

			// Best-effort tmp cleanup (P4) at the end of a library build.
			// configureServer also cleans up when the dev server closes. Any
			// failure is ignored. Non-recursive (see cleanupTmpOnClose): only
			// an empty dir is removed, never another instance's files.
			async buildEnd() {
				const schemaPath = await ensureSchemaPath().catch(() => undefined);
				if (!schemaPath) return;
				const { tmpDir } = getResolvedPaths(
					schemaPath,
					options,
					viteRoot,
					splitByTable,
				);
				await rmdir(tmpDir).catch(() => {});
			},
	};
}
