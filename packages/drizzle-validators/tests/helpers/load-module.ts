import { createServer } from "vite";
import { drizzleValidators } from "../../src/plugin";

export const loadModule = async (id: string) => {
	const server = await createServer({
		plugins: [
			drizzleValidators("zod", {
				schemaPath: "./tests/fixtures/complex-schemas.ts",
				outputPath: "./validators.ts",
				bufferAs: "keep",
			}),
		],
		server: { middlewareMode: true, ws: false },
		optimizeDeps: { noDiscovery: true },
	});

	try {
		return await server.ssrLoadModule(id);
	} catch (error) {
		console.error(error);
		return null;
	}
};
