import { expect, test } from "bun:test";
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { drizzleValidators } from "../src/plugin";
import type { DrizzleValidatorsOptions } from "../src/types";

const OUT = "./.drizzle-validators-generated/skip-build-regen-test";
// Points at a file that does NOT exist anywhere: if any code path tried to
// generate, esbuild would fail on the entry point — a successful load under
// this path proves the skip path never generated.
const NONEXISTENT_SCHEMA = "./tests/fixtures/this-file-does-not-exist.ts";

function pluginWithCommand(
	command: "build" | "serve",
	options: DrizzleValidatorsOptions,
) {
	const plugin = drizzleValidators("zod", options) as any;
	plugin.configResolved({ root: process.cwd(), command });
	return plugin;
}

async function warmArtifacts() {
	// One normal run (no skip) writes the files the skip path will serve.
	const warm = pluginWithCommand("build", {
		schemaPath: "./tests/fixtures/complex-schemas.ts",
		outputPath: OUT,
		bufferAs: "keep",
		regenOnBuild: true,
	});
	await warm.buildStart();
}

test("default build: serves virtual modules from previously generated files without generating", async () => {
	rmSync(OUT, { recursive: true, force: true });
	await warmArtifacts();
	expect(existsSync(resolve(process.cwd(), OUT, "index.ts"))).toBe(true);

	const plugin = pluginWithCommand("build", {
		schemaPath: NONEXISTENT_SCHEMA,
		outputPath: OUT,
	});
	await plugin.buildStart(); // must be a no-op, not a generation attempt

	const code = (await plugin.load("\0virtual:drizzle-validators")) as string;
	expect(code).toContain("pgComplexTableInsertSchema");
	expect(code).toContain("virtual:drizzle-validators/pgComplexTable");
	expect(code).toContain("refineZSchema");

	// Per-table submodule served verbatim from the written file
	const sub = (await plugin.load(
		"\0virtual:drizzle-validators/pgComplexTable",
	)) as string;
	expect(sub).toContain("import * as z from 'zod'");
	expect(sub).toContain("export const pgComplexTableInsertSchema = insertSchema");

	// The served artifact imports and evaluates cleanly (it is the real
	// written file — parse behavior is covered by the generation suites).
	const mod = await import(
		pathToFileURL(resolve(process.cwd(), OUT, "pgComplexTable.ts")).href
	);
	expect(mod.pgComplexTableSelectSchema).toBeDefined();
	expect(mod.pgComplexTableInsertSchema).toBeDefined();
	expect(mod.refineZSchema).toBeDefined();
});

test("default build fails with an actionable error when no artifacts exist", async () => {
	const missingOut = "./.drizzle-validators-generated/definitely-missing-dir";
	rmSync(missingOut, { recursive: true, force: true });

	const plugin = pluginWithCommand("build", {
		schemaPath: NONEXISTENT_SCHEMA,
		outputPath: missingOut,
	});

	expect(plugin.load("\0virtual:drizzle-validators")).rejects.toThrow(
		/No generated files were found/,
	);
});

test("dev (serve) always regenerates — build behavior is irrelevant there", async () => {
	rmSync(OUT, { recursive: true, force: true });

	const plugin = pluginWithCommand("serve", {
		// A REAL schema file: if serve mode were (wrongly) skipping, load
		// would fail on missing artifacts instead of generating.
		schemaPath: "./tests/fixtures/complex-schemas.ts",
		outputPath: OUT,
		bufferAs: "keep",
	});

	const code = (await plugin.load("\0virtual:drizzle-validators")) as string;
	expect(code).toContain("pgComplexTableInsertSchema");
});

test("default build works in single-file mode", async () => {
	const singleOut = "./.drizzle-validators-generated/skip-single-file.ts";
	rmSync(singleOut, { recursive: true, force: true });

	const warm = pluginWithCommand("build", {
		schemaPath: "./tests/fixtures/complex-schemas.ts",
		outputPath: singleOut,
		bufferAs: "keep",
		splitByTable: false,
		regenOnBuild: true,
	});
	await warm.buildStart();

	const plugin = pluginWithCommand("build", {
		schemaPath: NONEXISTENT_SCHEMA,
		outputPath: singleOut,
		splitByTable: false,
	});

	const code = (await plugin.load("\0virtual:drizzle-validators")) as string;
	expect(code).toContain("export const pgComplexTableInsertSchema");
	expect(code).toContain("/* @__PURE__ */");

	// Submodule imports must resolve too — dts-builder declares them and
	// dev serves them. Each submodule is a re-export shim over the root.
	const sub = (await plugin.load(
		"\0virtual:drizzle-validators/pgComplexTable",
	)) as string;
	expect(sub).toContain(
		"export { pgComplexTableInsertSchema as insertSchema, pgComplexTableSelectSchema as selectSchema, pgComplexTableUpdateSchema as updateSchema } from 'virtual:drizzle-validators';",
	);
});

test("no-regen build survives Prettier/Biome formatting of generated files", async () => {
	const fmtOut = "./.drizzle-validators-generated/skip-formatted-test";
	rmSync(resolve(process.cwd(), fmtOut), { recursive: true, force: true });

	const warm = pluginWithCommand("build", {
		schemaPath: "./tests/fixtures/complex-schemas.ts",
		outputPath: fmtOut,
		bufferAs: "keep",
		regenOnBuild: true,
	});
	await warm.buildStart();

	// Simulate a formatter/lint-staged pass over the committed artifacts:
	// trailing semicolons on every statement line. The alias parser must
	// tolerate them or every no-regen build crashes on formatted repos.
	const dir = resolve(process.cwd(), fmtOut);
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
		const p = join(dir, file);
		const formatted = readFileSync(p, "utf8")
			.split("\n")
			.map((l) =>
				l.startsWith("export ") || l.startsWith("import ") ? `${l};` : l,
			)
			.join("\n");
		writeFileSync(p, formatted);
	}

	const plugin = pluginWithCommand("build", {
		schemaPath: NONEXISTENT_SCHEMA,
		outputPath: fmtOut,
	});
	await plugin.buildStart();

	const code = (await plugin.load("\0virtual:drizzle-validators")) as string;
	expect(code).toContain("pgComplexTableInsertSchema");

	// Split mode serves each per-table file verbatim — the load succeeding
	// at all is the regression guard (formatted alias lines used to parse
	// as zero tables → "No generated files were found").
	const sub = (await plugin.load(
		"\0virtual:drizzle-validators/pgComplexTable",
	)) as string;
	expect(sub).toContain("= insertSchema;");
});

test("regenOnBuild: true restores build-time generation", async () => {
	const out = join(OUT, "..", "regen-on-build-test");
	rmSync(resolve(process.cwd(), out), { recursive: true, force: true });

	const plugin = pluginWithCommand("build", {
		schemaPath: "./tests/fixtures/complex-schemas.ts",
		outputPath: "tmp-out/regen-on-build-test",
		bufferAs: "keep",
		regenOnBuild: true,
	});
	await plugin.buildStart(); // must actually generate now
	expect(existsSync(resolve(process.cwd(), "tmp-out/regen-on-build-test/index.ts"))).toBe(true);
});
