import { createServer } from "vite";
import { drizzleZodVirtual } from "./plugin";

export const loadModule = async (id: string) => {
	const server = await createServer({
		plugins: [
			drizzleZodVirtual({
				schemaPath:
					"/home/null/Space/Project/drizzle-zod-plugin/playground/tables.ts",
				outputPath: "/home/null/Space/Project/drizzle-zod-plugin/validators.ts",
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

