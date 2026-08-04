import path from "node:path";
import { expect, test } from "bun:test";
import { createServer } from "vite";
import { drizzleZodVirtual } from "../src/plugin";

test("resolves relative schemaPath relative to Vite config root", async () => {
	const playgroundDir = path.resolve(process.cwd(), "playground");

	const server = await createServer({
		root: playgroundDir,
		plugins: [
			drizzleZodVirtual({
				schemaPath: "./tables.ts", // relative to Vite root (playgroundDir)
				outputPath: "./validators.ts",
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
		expect(mod.usersInsertSchema).toBeDefined();
	} finally {
		await server.close();
	}
});
