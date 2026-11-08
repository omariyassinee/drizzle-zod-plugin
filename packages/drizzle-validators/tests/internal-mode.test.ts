import { expect, test } from "bun:test";
import { createServer } from "vite";
import { drizzleValidators } from "../src/plugin";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

test("keeps files internal when outputPath is omitted, still infers types", async () => {
	const plugin = drizzleValidators("zod", {
		schemaPath: "./tests/fixtures/complex-schemas.ts",
		bufferAs: "keep",
	});

	// Spin up a minimal Vite server so the plugin's lifecycle runs.
	const server = await createServer({
		plugins: [plugin],
		server: { middlewareMode: true, ws: false },
		optimizeDeps: { noDiscovery: true },
	});

	try {
		// Trigger generation via virtual module
		const code = (await server.ssrLoadModule("virtual:drizzle-validators")) as Record<
			string,
			any
		>;
		expect(code).toBeDefined();
		// The complex-schemas fixture exposes pgComplexTable, pgCompositePkTable, etc.
		expect(code["pgComplexTableInsertSchema"]).toBeDefined();
		expect(code["pgComplexTableSelectSchema"]).toBeDefined();
		expect(code["pgComplexTableUpdateSchema"]).toBeDefined();

		// Internal files DO land inside node_modules for TypeScript inference
		const cwd = process.cwd();
		// Split mode: barrel index.ts inside .drizzle-validators/
		const internalBarrel = resolve(
			cwd,
			"node_modules",
			".drizzle-validators",
			"index.ts",
		);
		const typesFile = resolve(
			cwd,
			"node_modules",
			"@types",
			"virtual-drizzle-validators",
			"index.d.ts",
		);
		expect(existsSync(internalBarrel)).toBe(true);
		expect(existsSync(typesFile)).toBe(true);
	} finally {
		await server.close();
	}
});
