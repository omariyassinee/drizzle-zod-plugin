import { defineConfig } from "vite";
import { drizzleValidators } from "@vacuus/drizzle-validators";

export default defineConfig({
	plugins: [
		drizzleValidators("valibot", {
			schemaPath: "./src/db/schema.ts",
			// outputPath: "./src/generated-validators",
			// tables: ["webhooks", "deliveries"],
			bufferAs: "keep",
		}),
	],
	build: {
		target: "esnext",
		outDir: "dist",
		emptyOutDir: true,
		lib: { entry: "./src/worker.ts", formats: ["es"] },
		rollupOptions: { output: { entryFileNames: "worker.js" } },
	},
});
