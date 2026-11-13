import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

import { DEPENDENCY_PACKAGES, type ValidatorTarget } from "./adapters/types";
import type { GeneratedData, TableCodeData } from "./types";

/**
 * Reads this plugin's own package version (findings P2-09).
 *
 * Resolution order:
 *  1. `__PLUGIN_VERSION__` — a build-time constant tsup injects via esbuild
 *     `define`, so the bundled dist (ESM *and* CJS) always carries the exact
 *     released version.
 *  2. Walk up from the module location to the package dir — used when the
 *     sources run under `bun test` (where no define exists).
 *
 * This version MUST participate in the cache key: serializer/service fixes
 * shipped in a new release would otherwise be served stale output from the
 * user's disk cache (`node_modules/.cache/drizzle-validators/`),
 * resurrecting bugs the release fixed.
 */
declare const __PLUGIN_VERSION__: any;

export const PLUGIN_VERSION: string =
	typeof __PLUGIN_VERSION__ === "undefined"
		? readPluginPackageVersion()
		: String(__PLUGIN_VERSION__);

function readPluginPackageVersion(): string {
	try {
		let dir = dirname(fileURLToPath(import.meta.url));
		for (let i = 0; i < 8; i++) {
			try {
				const pkg = JSON.parse(
					readFileSync(joinPath(dir, "package.json"), "utf8"),
				) as { name?: string; version?: string };
				if (
					(pkg.name === "drizzle-validators" ||
						pkg.name === "@vacuus/drizzle-validators") &&
					typeof pkg.version === "string"
				) {
					return pkg.version;
				}
			} catch {
				// not a package.json (or no match) — keep walking up
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		// import.meta.url unavailable in this runtime — degrade silently
	}
	return "unknown";
}

/**
 * Validates a disk-cache hit by re-hashing the recorded dependency files.
 * Returns the cached GeneratedData on a hit, or null on any miss.
 */
export async function loadCachedData(
	projectRoot: string,
	key: string,
): Promise<GeneratedData | null> {
	try {
		const raw = await readFile(
			joinPath(cacheDir(projectRoot), `${key}.json`),
			"utf8",
		);
		const envelope = JSON.parse(raw) as unknown;
		if (!isEnvelope(envelope) || envelope.key !== key) return null;
		const currentHash = await hashInputFiles(envelope.data.depPaths);
		if (currentHash === null || currentHash !== envelope.inputsHash) {
			return null;
		}
		return {
			code: envelope.data.code,
			singleFileCode: envelope.data.singleFileCode,
			exportNames: envelope.data.exportNames,
			tableCodes: new Map(envelope.data.tableCodes),
			depPaths: envelope.data.depPaths,
			target: envelope.data.target,
			importStatement: envelope.data.importStatement,
		};
	} catch {
		return null;
	}
}

/** Persists a generation result. Atomic-ish: temp sibling + rename. */
export async function saveCachedData(
	projectRoot: string,
	key: string,
	data: GeneratedData,
	inputsHash: string,
): Promise<void> {
	const envelope: CacheEnvelope = {
		version: CACHE_VERSION,
		key,
		inputsHash,
		data: {
			code: data.code,
			singleFileCode: data.singleFileCode,
			exportNames: data.exportNames,
			tableCodes: [...data.tableCodes.entries()],
			depPaths: data.depPaths,
			target: data.target,
			importStatement: data.importStatement,
		},
	};
	const dir = cacheDir(projectRoot);
	const filePath = joinPath(dir, `${key}.json`);
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	await mkdir(dir, { recursive: true });
	await writeFile(tmpPath, JSON.stringify(envelope));
	await rename(tmpPath, filePath);
}

/** Structural equality of two GeneratedData results (for no-op detection, P2). */
export function generatedEquals(
	a: GeneratedData | null,
	b: GeneratedData | null,
): boolean {
	if (!a || !b) return false;
	if (a.code !== b.code) return false;
	if (a.singleFileCode !== b.singleFileCode) return false;
	if (a.exportNames.length !== b.exportNames.length) return false;
	for (let i = 0; i < a.exportNames.length; i++) {
		if (a.exportNames[i] !== b.exportNames[i]) return false;
	}
	if (a.tableCodes.size !== b.tableCodes.size) return false;
	for (const [tableName, tableData] of a.tableCodes) {
		const other = b.tableCodes.get(tableName);
		if (!other) return false;
		if (tableData.code !== other.code) return false;
		if (
			tableData.exportNames.join("\u0000") !== other.exportNames.join("\u0000")
		) {
			return false;
		}
		for (let i = 0; i < tableData.codes.length; i++) {
			if (tableData.codes[i] !== other.codes[i]) return false;
		}
	}
	return true;
}

/**
 * Persistent, content-addressed generation cache (finding P1).
 *
 * Key: a hash of (schema entry path + table filter + module id + dependency
 * package versions). The stored envelope records every project-local
 * dependency file discovered by the esbuild bundling step (`depPaths`, from
 * the esbuild metafile) plus a hash over those files' CONTENTS.
 *
 * On a cache hit the plugin skips the esbuild bundle + dynamic import +
 * full serialization entirely — dev-server restarts and CI builds become
 * near-instant. A hit is only served when every recorded dependency file
 * still exists with byte-identical content. Dependency package versions
 * (externalized from the bundle, so invisible to file hashing) are folded
 * into the key, so upgrades invalidate the cache.
 *
 * Cache location: `node_modules/.cache/drizzle-validators/` (best-effort;
 * any read/write failure degrades to a full regeneration).
 */

/**
 * CACHE_VERSION also stays versioned with the plugin release so historical
 * envelopes (from before this code existed) are never served.
 */
const CACHE_VERSION = 5;

type CacheEnvelope = {
	version: number;
	key: string;
	inputsHash: string;
	data: {
		code: string;
		singleFileCode: string;
		exportNames: string[];
		tableCodes: [string, TableCodeData][];
		depPaths: string[];
		target: ValidatorTarget;
		importStatement: string;
	};
};

/**
 * Envelope shape validation also covers the per-table payload (finding
 * P2-15): top-level type checks alone let hand-corrupted/partially-written
 * envelopes flow structurally-garbage `tableCodes` entries into the file
 * writer, which emitted `export const updateSchema = undefined;` into user
 * files with no error. Void any structural deviation ⇒ cache miss (recompute).
 */
function isEnvelope(value: unknown): value is CacheEnvelope {
	if (typeof value !== "object" || value === null) return false;
	const v = value as CacheEnvelope;
	if (v.version !== CACHE_VERSION) return false;
	if (
		typeof v.key !== "string" ||
		typeof v.inputsHash !== "string" ||
		typeof v.data?.code !== "string" ||
		typeof v.data?.singleFileCode !== "string" ||
		typeof v.data?.target !== "string" ||
		typeof v.data?.importStatement !== "string"
	) {
		return false;
	}
	if (
		!Array.isArray(v.data?.exportNames) ||
		!Array.isArray(v.data?.tableCodes) ||
		!Array.isArray(v.data?.depPaths) ||
		!v.data.exportNames.every((n) => typeof n === "string") ||
		!v.data.depPaths.every((d) => typeof d === "string")
	) {
		return false;
	}
	// Per-table structure: [tableName, { code, exportNames, codes }]
	// where exportNames and codes must be aligned string arrays (the
	// file writer destructures one name/code per index).
	for (const entry of v.data.tableCodes) {
		if (!Array.isArray(entry)) return false;
		const [name, table] = entry as unknown[];
		if (
			typeof name !== "string" ||
			typeof table !== "object" ||
			table === null
		) {
			return false;
		}
		const t = table as Partial<TableCodeData>;
		if (typeof t.code !== "string") return false;
		if (
			!Array.isArray(t.exportNames) ||
			t.exportNames.some((n) => typeof n !== "string")
		) {
			return false;
		}
		if (
			!Array.isArray(t.codes) ||
			t.codes.some((c) => typeof c !== "string") ||
			t.codes.length !== t.exportNames.length
		) {
			return false;
		}
	}
	return true;
}

function cacheDir(projectRoot: string): string {
	return joinPath(projectRoot, "node_modules", ".cache", "drizzle-validators");
}

/**
 * Best-effort read of the dependency package versions that participate in
 * generation (they are `external` in esbuild, so their code is NOT captured
 * by the input-file hash). A version bump invalidates the cache.
 *
 * The package list is target-specific: only the libraries whose code ends up
 * (via the serializer) or feeds (via the creators) the generated output for
 * that target participate.
 */
function dependencyFingerprint(
	projectRoot: string,
	target: ValidatorTarget,
): string {
	const parts: string[] = [];
	for (const name of DEPENDENCY_PACKAGES[target]) {
		let version: string | undefined;
		// Walk UP from the project root: the package may be installed in a
		// workspace ancestor (hoisted/monorepo layouts), not in the
		// project's own node_modules — a flat lookup degraded the
		// fingerprint to `name@?`, desensitizing the cache key.
		let dir = projectRoot;
		while (true) {
			try {
				const pkgPath = joinPath(dir, "node_modules", name, "package.json");
				version = (
					JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }
				).version;
				break;
			} catch {
				const parent = dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
		}
		parts.push(`${name}@${version ?? "?"}`);
	}
	return parts.join("|");
}

/**
 * Stable cache key for a generation configuration.
 *
 * Includes the plugin's own version (finding P2-09) so a plugin upgrade —
 * with any serializer behavior change — invalidates previously persisted
 * entries; without this, a schema unchanged since the previous release gets
 * the old (buggy) serialized output served from `node_modules/.cache/`.
 */
export function computeCacheKey(opts: {
	projectRoot: string;
	absoluteSchemaPath: string;
	tables: string[] | undefined;
	moduleId: string;
	target: ValidatorTarget;
	/** Serializer policy — changes output, so it must change the key. */
	bufferAs?: "throw" | "keep";
}): string {
	const key = createHash("sha1");
	key.update(opts.absoluteSchemaPath);
	key.update("\0");
	key.update(opts.tables ? [...opts.tables].sort().join(",") : "*");
	key.update("\0");
	key.update(opts.moduleId);
	key.update("\0");
	key.update(opts.target);
	key.update("\0");
	key.update(opts.bufferAs ?? "throw");
	key.update("\0");
	key.update(dependencyFingerprint(opts.projectRoot, opts.target));
	key.update("\0");
	key.update(PLUGIN_VERSION);
	return key.digest("hex");
}

/**
 * Hashes the contents of the given dependency files (sorted for stability).
 * Returns null when any file is missing/unreadable — a cache miss by
 * definition, since a deleted dependency changes the generated output.
 */
export async function hashInputFiles(
	depPaths: string[],
): Promise<string | null> {
	const hash = createHash("sha1");
	for (const p of [...depPaths].sort()) {
		try {
			hash.update(p);
			hash.update(await readFile(p));
		} catch {
			return null;
		}
	}
	return hash.digest("hex");
}
