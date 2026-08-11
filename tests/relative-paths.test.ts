import path from "node:path";
import { expect, test } from "bun:test";
import { createServer } from "vite";
import { drizzleZodVirtual } from "../src/plugin";

test("resolves relative schemaPath relative to Vite config root", async () => {
	const testsDir = path.resolve(process.cwd(), "tests");

	const server = await createServer({
		root: testsDir,
		plugins: [
			drizzleZodVirtual({
				schemaPath: "./fixtures/complex-schemas.ts", // relative to Vite root (testsDir)
				outputPath: "./.drizzle-zod-generated/relative-test.ts",
			}),
		],
		server: { middlewareMode: true },
		optimizeDeps: { noDiscovery: true },
	});

	try {
		const mod = (await server.ssrLoadModule("virtual:drizzle-zod")) as Record<
			string,
			any
		>;
		expect(mod).toBeDefined();
		expect(mod.pgComplexTableInsertSchema).toBeDefined();
	} finally {
		await server.close();
	}
});
