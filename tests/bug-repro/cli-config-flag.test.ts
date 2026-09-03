/**
 * C3 — CLI -c/--config flag is miswired: config path passed as schemaPath.
 *
 * See BUG-REPORT.md, finding C3.
 */
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { runCli } from "../../src/cli";

const OUT_DIR = resolve("./.drizzle-zod-generated/bug-c3");

test("C3: --config accepts a drizzle config file and extracts its schema path", async () => {
	rmSync(OUT_DIR, { recursive: true, force: true });

	// The repo root has a real drizzle.config.ts exporting `schema`.
	// BUG: today this fails with "Could not resolve .../drizzle.config.ts"
	// because the config path is passed as schemaPath to esbuild.
	await runCli([
		"generate",
		"--config",
		resolve("./drizzle.config.ts"),
		"--output",
		OUT_DIR,
	]);

	// If the flag worked, generation succeeds and writes the barrel.
	expect(existsSync(resolve(OUT_DIR, "index.ts"))).toBe(true);
	rmSync(OUT_DIR, { recursive: true, force: true });
});

import { existsSync } from "node:fs";
