import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import type { GeneratedData, TableCodeData } from "./types";

/**
 * Validates a disk-cache hit by re-hashing the recorded dependency files.
 * Returns the cached GeneratedData on a hit, or null on any miss.
 */
export async function loadCachedData(
	projectRoot: string,
	key: string,
): Promise<GeneratedData | null> {
	try {
		const raw = await readFile(joinPath(cacheDir(projectRoot), `${key}.json`), "utf8");
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
			tableData.exportNames.join("\u0000") !==
			other.exportNames.join("\u0000")
		) {
			return false;
		}
		for (let i = 0; i < tableData.zodCodes.length; i++) {
			if (tableData.zodCodes[i] !== other.zodCodes[i]) return false;
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
 * Cache location: `node_modules/.cache/drizzle-zod-plugin/` (best-effort;
 * any read/write failure degrades to a full regeneration).
 */

const CACHE_VERSION = 1;

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
	};
};

function isEnvelope(value: unknown): value is CacheEnvelope {
	if (typeof value !== "object" || value === null) return false;
	const v = value as CacheEnvelope;
	return (
		v.version === CACHE_VERSION &&
		typeof v.key === "string" &&
		typeof v.inputsHash === "string" &&
		typeof v.data?.code === "string" &&
		typeof v.data?.singleFileCode === "string" &&
		Array.isArray(v.data?.exportNames) &&
		Array.isArray(v.data?.tableCodes) &&
		Array.isArray(v.data?.depPaths)
	);
}

function cacheDir(projectRoot: string): string {
	return joinPath(projectRoot, "node_modules", ".cache", "drizzle-zod-plugin");
}

/**
 * Best-effort read of the dependency package versions that participate in
 * generation (they are `external` in esbuild, so their code is NOT captured
 * by the input-file hash). A version bump invalidates the cache.
 */
function dependencyFingerprint(projectRoot: string): string {
	const parts: string[] = [];
	for (const name of ["drizzle-orm", "drizzle-zod", "zod"]) {
		try {
			const pkgPath = joinPath(projectRoot, "node_modules", name, "package.json");
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
				version?: string;
			};
			parts.push(`${name}@${pkg.version ?? "?"}`);
		} catch {
			parts.push(`${name}@?`);
		}
	}
	return parts.join("|");
}

/** Stable cache key for a generation configuration. */
export function computeCacheKey(opts: {
	projectRoot: string;
	absoluteSchemaPath: string;
	tables: string[] | undefined;
	moduleId: string;
}): string {
	const key = createHash("sha1");
	key.update(opts.absoluteSchemaPath);
	key.update("\0");
	key.update(opts.tables ? [...opts.tables].sort().join(",") : "*");
	key.update("\0");
	key.update(opts.moduleId);
	key.update("\0");
	key.update(dependencyFingerprint(opts.projectRoot));
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
