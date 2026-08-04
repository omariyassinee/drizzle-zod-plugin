import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	dts: false,
	clean: true,
	sourcemap: false,
	minify: true,
	splitting: false,
	external: [
		"vite",
		"esbuild",
		"drizzle-orm",
		"drizzle-zod",
		"zod",
		"node:fs",
		"node:path",
		"node:url",
	],
});
