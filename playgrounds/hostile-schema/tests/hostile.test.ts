import { expect, test, afterAll } from "bun:test";

import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
	statSync,
} from "node:fs";

import { drizzleValidators } from "@vacuus/drizzle-validators";
import { join } from "node:path";

import type { Plugin } from "vite";

// Hostile Schema: every fail-loud path, exercised from a real plugin
// context (vite command + plugin hooks — not direct serializer calls).
// The contract under test: errors are loud, actionable, and atomic —
// a failed generation never corrupts previously generated artifacts.

const ROOT = process.cwd();
const SCHEMAS = join(ROOT, "tmp-schemas");
const OUT = join(ROOT, "tmp-out");

type TestPlugin = Plugin & {
	configResolved: (c: unknown) => void;
	buildStart: () => Promise<void>;
	load: (id: string) => Promise<string>;
};

function plugin(schemaPath: string, options: Record<string, unknown> = {}) {
	const p = drizzleValidators("zod", {
		schemaPath,
		outputPath: join(
			OUT,
			`${schemaPath.split("/").pop()}-${Math.random().toString(36).slice(2, 7)}`,
		),
		...options,
	}) as unknown as TestPlugin;
	p.configResolved({ root: ROOT, command: "serve" });
	return p;
}

function hostileSchema(name: string, code: string): string {
	mkdirSync(SCHEMAS, { recursive: true });
	writeFileSync(join(SCHEMAS, name), code, "utf8");
	return `./tmp-schemas/${name}`;
}

async function loadError(p: TestPlugin): Promise<string> {
	try {
		await p.load("\0virtual:drizzle-validators");
		return "<no error>";
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

test("Buffer columns fail loud naming the P2-02 policy (zod, throw default)", async () => {
	const p = plugin(
		hostileSchema(
			"buffer.ts",
			`import { pgTable, serial, bytea } from "drizzle-orm/pg-core";
			export const blobs = pgTable("blobs", {
				id: serial("id").primaryKey(),
				data: bytea("data").notNull(),
			});`,
		),
	);
	const message = await loadError(p);
	expect(message).toContain("z.instanceof(Buffer)");
	expect(message).toContain('bufferAs: "keep"');
});

test("symbol-keyed entries are ignored by drizzle itself (documented upstream)", async () => {
	// Verified against drizzle-orm rc.5: pgTable never registers symbol-keyed
	// entries (getTableColumns has zero symbol columns), so the column does
	// not exist in DDL either. Generation succeeds and matches the schema.
	// (The P2-16 serializer guard remains for symbol keys reaching a zod
	// shape through other paths, e.g. hand-built z.object fixtures.)
	const p = plugin(
		hostileSchema(
			"symbols.ts",
			`import { pgTable, serial, text } from "drizzle-orm/pg-core";
			const sym = Symbol.for("hostile-probe");
			export const tagged = pgTable("tagged", {
				id: serial("id").primaryKey(),
				[sym]: text("tagged").notNull(),
			});`,
		),
	);
	const code = await p.load("\0virtual:drizzle-validators/tagged");
	expect(code).toContain('"id"');
});

test("non-identifier table names fail loud naming the table (M3)", async () => {
	const p = plugin(
		hostileSchema(
			"dash-table.ts",
			`import { pgTable, serial } from "drizzle-orm/pg-core";
			const userProfile = pgTable("user_profile", { id: serial("id").primaryKey() });
			export { userProfile as "user-profile" };`,
		),
	);
	const message = await loadError(p);
	expect(message).toContain("user-profile");
});

test("empty schema (no tables exported) fails loud with guidance", async () => {
	const p = plugin(
		hostileSchema(
			"empty.ts",
			`export const notATable = { just: "an object" };`,
		),
	);
	const message = await loadError(p);
	expect(message).toContain("No Drizzle tables found");
	expect(message).toContain('"tables" option');
});

test("unknown --tables entry fails loud naming the entry", async () => {
	const schemaPath = hostileSchema(
		"plain.ts",
		`import { pgTable, serial } from "drizzle-orm/pg-core";
		export const users = pgTable("users", { id: serial("id").primaryKey() });`,
	);
	const p = plugin(schemaPath, { tables: ["users", "nonexistent"] });
	const message = await loadError(p);
	expect(message).toContain('Table "nonexistent" not exported');
});

test("schema: string[] drizzle config fails loud (C3, via CLI -c)", () => {
	writeFileSync(
		join(SCHEMAS, "array-config.json"),
		JSON.stringify({
			schema: ["./tmp-schemas/plain.ts", "./tmp-schemas/empty.ts"],
		}),
	);
	const proc = Bun.spawnSync(
		[
			join(ROOT, "node_modules/.bin/dv"),
			"generate",
			"--config",
			"./tmp-schemas/array-config.json",
			"--output",
			"tmp-out/array-config",
		],
		{ cwd: ROOT },
	);
	expect(proc.exitCode).toBe(1);
	expect(new TextDecoder().decode(proc.stderr)).toMatch(/string\[\]/);
});

test("customType columns degrade to z.any() (documented drizzle-zod semantics)", async () => {
	// Verified against drizzle-orm rc.5: the zod creators type customType
	// columns as `any` — arbitrary TS-to-DB mappings carry no validation.
	// Users who want checks refine them (refineZSchema .as()). The generated
	// code states nothing false; it just accepts anything for that column.
	const p = plugin(
		hostileSchema(
			"custom-type.ts",
			`import { pgTable, serial, customType } from "drizzle-orm/pg-core";
			const vector = customType<{ data: number[] }>({
				dataType() { return "vector(3)"; },
			});
			export const embeddings = pgTable("embeddings", {
				id: serial("id").primaryKey(),
				vec: vector("vec").notNull(),
			});`,
		),
	);
	const code = await p.load("\0virtual:drizzle-validators/embeddings");
	expect(code).toContain('"vec": z.any()');
});

test("last-good-wins: failed regeneration leaves prior artifacts untouched", async () => {
	const schemaPath = hostileSchema(
		"atomic.ts",
		`import { pgTable, serial, text } from "drizzle-orm/pg-core";
		export const accounts = pgTable("accounts", {
			id: serial("id").primaryKey(),
			name: text("name").notNull(),
		});`,
	);
	const outDir = join(OUT, "atomic");
	rmSync(outDir, { recursive: true, force: true });
	const p = plugin(schemaPath, { outputPath: "tmp-out/atomic" });

	// first: healthy generation
	await p.buildStart();
	const tableFile = join(outDir, "accounts.ts");
	expect(existsSync(tableFile)).toBe(true);
	// a useCache instance also warms its in-memory cache (rewrites files)
	const cached = plugin(schemaPath, {
		outputPath: "tmp-out/atomic",
		useCache: true,
	});
	const beforeVirtualCode = await cached.load("\0virtual:drizzle-validators");
	const before = Math.floor(statSync(tableFile).mtimeMs);
	const beforeContent = await Bun.file(tableFile).text();

	// then: break the schema and re-attempt — the SAME instance keeps
	// serving its in-memory cache (last-good-wins for the dev session,
	// by design), and the disk artifacts are untouched.
	writeFileSync(
		schemaPath,
		`import { pgTable } from "drizzle-orm/pg-core";
		export const accounts = pgTable("accounts", {
			id: [][0],
		});`,
		"utf8",
	);
	// with the in-memory cache on, the SAME session keeps serving its
	// last-good output (last-good-wins for the dev session, by design)
	const stale = await cached.load("\0virtual:drizzle-validators");
	expect(stale).toBe(beforeVirtualCode);

	// disk files byte-identical and untouched
	expect(existsSync(tableFile)).toBe(true);
	expect(await Bun.file(tableFile).text()).toBe(beforeContent);
	expect(Math.floor(statSync(tableFile).mtimeMs)).toBe(before);

	// without the cache (default), the same session's load regenerates and
	// fails loud on the broken schema...
	await expect(p.load("\0virtual:drizzle-validators")).rejects.toThrow();

	// ...and a FRESH instance fails loud too, instead of inventing output
	const fresh = plugin(schemaPath, { outputPath: "tmp-out/atomic" });
	await expect(fresh.load("\0virtual:drizzle-validators")).rejects.toThrow();
});

test("a first-ever failed generation writes no partial artifacts", async () => {
	const schemaPath = hostileSchema(
		"buffer-fresh.ts",
		`import { pgTable, bytea } from "drizzle-orm/pg-core";
		export const blobs = pgTable("blobs", { data: bytea("data").notNull() });`,
	);
	const outDir = join(OUT, "fresh-fail");
	rmSync(outDir, { recursive: true, force: true });
	const p = plugin(schemaPath, { outputPath: "tmp-out/fresh-fail" });

	await expect(p.load("\0virtual:drizzle-validators")).rejects.toThrow(
		/z\.instanceof\(Buffer\)/,
	);

	// no output dir (or at most an empty shell) — nothing that looks generated
	if (existsSync(outDir)) {
		expect(readdirSync(outDir).filter((f) => f.endsWith(".ts"))).toEqual([]);
	}
});

afterAll(() => {
	rmSync(SCHEMAS, { recursive: true, force: true });
	rmSync(OUT, { recursive: true, force: true });
});
