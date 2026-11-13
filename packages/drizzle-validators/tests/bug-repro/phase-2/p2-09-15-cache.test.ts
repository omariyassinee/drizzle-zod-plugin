import { expect, test } from "./_helpers";
import {
	computeCacheKey,
	hashInputFiles,
	loadCachedData,
	saveCachedData,
} from "../../../src/cache";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// P2-09: the disk-cache key was derived WITHOUT the plugin version, so a
// plugin upgrade served stale, bug-laden output from
// node_modules/.cache/drizzle-validators/ for an unchanged schema. The key
// now folds in the plugin version and the envelope carries a FORMAT version,
// so anything written by an older release can never be served.

// P2-15: the envelope was only checked at the top level; hand-corrupted /
// partially-written envelopes let structurally-garbage tableCodes entries
// (misaligned exportNames/codes) flow into the file writer, emitting
// `export const updateSchema = undefined;` into user files silently. The
// envelope is now validated structurally — per table, per entry.

const env = (overrides: Record<string, unknown>) => ({
	version: 2,
	key: "k",
	inputsHash: "",
	data: {
		code: "export const a = 1;",
		singleFileCode: "export const a = 1;",
		exportNames: ["a"],
		tableCodes: [
			[
				"users",
				{
					code: "// table",
					exportNames: [
						"usersInsertSchema",
						"usersSelectSchema",
						"usersUpdateSchema",
					],
					codes: ["/*ins*/", "/*sel*/", "/*upd*/"],
				},
			],
		] as unknown,
		depPaths: [] as string[],
	},
	...overrides,
});

function tmpProject(name: string): string {
	const dir = join(
		process.cwd(),
		"node_modules",
		`.tmp-p2-cache-${name}-${process.pid}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Creates the cache directory so raw envelope fixtures can be written. */
function ensureCacheDir(root: string): void {
	mkdirSync(
		join(root, "node_modules", ".cache", "drizzle-validators"),
		{ recursive: true },
	);
}

const cacheFile = (root: string, key = "k") =>
	join(
		root,
		"node_modules",
		".cache",
		"drizzle-validators",
		`${key ?? "k"}.json`,
	);

test("P2-09: freshly written envelope is version-stamped and the key folds in the plugin version", async () => {
	const root = tmpProject("fresh");
	try {
		const key = computeCacheKey({
			projectRoot: root,
			absoluteSchemaPath: "/x/schema.ts",
			tables: undefined,
			moduleId: "virtual:drizzle-validators",
			target: "zod",
		});
		const done = await hashInputFiles([]);
		await saveCachedData(root, key, {
			code: "export const a = 1;",
			singleFileCode: "export const a = 1;",
			exportNames: ["a"],
			tableCodes: new Map(),
			depPaths: [],
			target: "zod",
			importStatement: "import * as z from 'zod'",
		}, done!);
		const disk = JSON.parse(readFileSync(cacheFile(root, key), "utf8"));
		expect(disk.version).toBe(6);
		expect(disk.key).toBe(key);
		const hit = await loadCachedData(root, key);
		expect(hit?.code).toBe("export const a = 1;");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("P2-09: older-cache-format envelopes (any version != current) are never served", async () => {
	const root = tmpProject("oldver");
	try {
		ensureCacheDir(root);
		const key = computeCacheKey({
			projectRoot: root,
			absoluteSchemaPath: "/x/schema.ts",
			tables: undefined,
			moduleId: "virtual:drizzle-validators",
			target: "zod",
		});
		for (const oldVersion of [1, 0, 999, undefined]) {
			writeFileSync(
				cacheFile(root),
				JSON.stringify(env({ key, version: oldVersion })),
			);
			const hit = await loadCachedData(root, key);
			expect(hit).toBeNull();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("P2-09: cache DIRECTORY is keyed per project root, not by CLI cwd", async () => {
	const rootA = tmpProject("dirA");
	const rootB = tmpProject("dirB");
	try {
		const keyA = computeCacheKey({
			projectRoot: rootA,
			absoluteSchemaPath: "/x/schema.ts",
			tables: undefined,
			moduleId: "mod",
			target: "zod",
		});
		// different deps fingerprint (each root has different node_modules)
		// won't change this assert because both are empty projects — but the
		// file lives under rootA, not a cwd-dependent location
		const done = await hashInputFiles([]);
		await saveCachedData(rootA, keyA, {
			code: "export const a = 1;",
			singleFileCode: "export const a = 1;",
			exportNames: ["a"],
			tableCodes: new Map(),
			depPaths: [],
			target: "zod",
			importStatement: "import * as z from 'zod'",
		}, done!);
		expect(
			readFileSync(cacheFile(rootA, keyA), "utf8"),
		).toContain("export const a");
		// rootB — an independent project root — has no cache entry at all
		expect(existsSync(cacheFile(rootB))).toBe(false);
	} finally {
		rmSync(rootA, { recursive: true, force: true });
		rmSync(rootB, { recursive: true, force: true });
	}
});

test("P2-15: misaligned per-table payload (exportNames/codes mismatch) is voided", async () => {
	const root = tmpProject("misaligned");
	try {
		ensureCacheDir(root);
		const key = "k";
		writeFileSync(
			cacheFile(root),
			JSON.stringify(
				env({
					key,
					data: {
						code: "x",
						singleFileCode: "x",
						exportNames: ["a"],
						depPaths: [],
			target: "zod",
			importStatement: "import * as z from 'zod'",
						tableCodes: [
							[
								"users",
								{
									code: "// ok shape",
									exportNames: [
										"usersSelectSchema",
										"usersInsertSchema",
										"usersUpdateSchema",
									],
									codes: ["/* only two */"],
								},
							],
						],
					},
				}),
			),
		);
		expect(await loadCachedData(root, key)).toBeNull();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("P2-15: non-string codes in the table payload are voided", async () => {
	const root = tmpProject("nonstring");
	try {
		ensureCacheDir(root);
		writeFileSync(
			cacheFile(root),
			JSON.stringify(
				env({
					data: {
						code: "x",
						singleFileCode: "x",
						exportNames: ["a"],
						depPaths: [],
			target: "zod",
			importStatement: "import * as z from 'zod'",
						tableCodes: [
							[
								"users",
								{
									code: "// ok",
									exportNames: ["usersSelectSchema"],
									codes: [undefined],
								},
							],
						],
					},
				}),
			),
		);
		expect(await loadCachedData(root, "k")).toBeNull();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("P2-15: healthy envelopes still resolve a cache hit", async () => {
	const root = tmpProject("healthy");
	try {
		const key = computeCacheKey({
			projectRoot: root,
			absoluteSchemaPath: "/x/schema.ts",
			tables: undefined,
			moduleId: "virtual:drizzle-validators",
			target: "zod",
		});
		const done = await hashInputFiles([]);
		await saveCachedData(root, key, {
			code: "export const a = 1;",
			singleFileCode: "export const a = 1;",
			exportNames: ["a"],
			tableCodes: new Map([
				[
					"users",
					{
					code: "// users",
					exportNames: [
						"usersInsertSchema",
						"usersSelectSchema",
						"usersUpdateSchema",
					],
					codes: ["/* insert */", "/* select */", "/* update */"],
					},
				],
			]),
			depPaths: [],
			target: "zod",
			importStatement: "import * as z from 'zod'",
		}, done!);
		const hit = await loadCachedData(root, key);
		expect(hit?.tableCodes.get("users")).toBeTruthy();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("dependency fingerprint resolves packages hoisted above the project root", () => {
	// tests/fixtures has no node_modules of its own — the packages must be
	// found by walking UP to the workspace node_modules. The key from the
	// node_modules-less subdir must equal the key from the workspace root
	// itself (same resolved versions); a root with nothing resolvable
	// anywhere degrades to name@? and keys differently.
	const base = {
		absoluteSchemaPath: "/x/schema.ts",
		tables: undefined,
		moduleId: "virtual:drizzle-validators",
		target: "zod" as const,
	};
	const fromSubdir = computeCacheKey({
		projectRoot: resolve(import.meta.dir, "../fixtures"),
		...base,
	});
	const fromWorkspaceRoot = computeCacheKey({
		projectRoot: resolve(import.meta.dir, "../.."),
		...base,
	});
	expect(fromSubdir).toBe(fromWorkspaceRoot);

	const fromVoid = computeCacheKey({
		projectRoot: "/definitely-no-node_modules-anywhere-here",
		...base,
	});
	expect(fromVoid).not.toBe(fromWorkspaceRoot);
});
