import { createServer } from "vite";
import { drizzleZodVirtual } from "./plugin";

export const loadModule = async (id: string) => {
	const server = await createServer({
		plugins: [
			drizzleZodVirtual({
				schemaPath: "./tests/fixtures/complex-schemas.ts",
				outputPath: "./validators.ts",
			}),
		],
		server: { middlewareMode: true },
		optimizeDeps: { noDiscovery: true },
	});

	try {
		return await server.ssrLoadModule(id);
	} catch (error) {
		console.error(error);
		return null;
	}
};
