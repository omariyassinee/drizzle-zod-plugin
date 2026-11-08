import { expect, test } from "./_helpers";
import { loadEsbuild } from "../../../src/schema-generator";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// P2-11 (downgraded): the original finding — drizzle's `is()` fails on
// nested copies — was NOT reproduced (entityKind-based checks survive
// mismatched copies). The remaining DX issue: a bare `dist/cli.js` shipped
// with a top-level `import * as esbuild` crashed with the raw
// NPM-resolver message `Cannot find package 'esbuild'` when esbuild wasn't
// installed in the consumer's tree. The CLI now resolves esbuild lazily and
// schema-creator loading surfaces an actionable message.

test("P2-11: loadEsbuild() resolves esbuild from the plugin environment", async () => {
	const esbuild = await loadEsbuild();
	expect(typeof esbuild.build).toBe("function");
});

test("P2-11: the CLI entry never statically imports the generator module", () => {
	const cliSource = readFileSync(
		join(process.cwd(), "src", "cli.ts"),
		"utf8",
	);
	// a top-level static import would make the bundled CLI hard-fail on
	// every invocation when the environment is broken — everything that
	// can fail must sit behind await import()
	expect(cliSource).not.toMatch(/^\s*import\s+\{[^}]*generateSchemas[^}]*\}\s+from\s+["']\.\//m);
	expect(cliSource).toMatch(/await import\("\.\/schema-generator"\)/);
});

test("P2-11: schema-generator surfaces an actionable peer-install message", async () => {
	const genSource = readFileSync(
		join(process.cwd(), "src", "schema-generator.ts"),
		"utf8",
	);
	expect(genSource).toContain("drizzle-orm >= 0.43");
	expect(genSource).toContain("then re-run generation");
});
