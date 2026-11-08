import path from "node:path";
import { expect, test } from "bun:test";
import { createServer } from "vite";
import { drizzleValidators } from "../src/plugin";

test("resolves relative schemaPath relative to Vite config root", async () => {
	const testsDir = path.resolve(process.cwd(), "tests");

	const server = await createServer({
		root: testsDir,
		plugins: [
			drizzleValidators("zod", {
				schemaPath: "./fixtures/complex-schemas.ts", // relative to Vite root (testsDir)
				bufferAs: "keep",
				outputPath: "./.drizzle-validators-generated/relative-test.ts",
			}),
		],
		server: { middlewareMode: true, ws: false },
		optimizeDeps: { noDiscovery: true },
	});

	try {
		const mod = (await server.ssrLoadModule("virtual:drizzle-validators")) as Record<
			string,
			any
		>;
		expect(mod).toBeDefined();
		expect(mod.pgComplexTableInsertSchema).toBeDefined();
	} finally {
		await server.close();
	}
});
