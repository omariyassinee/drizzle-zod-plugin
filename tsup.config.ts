import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts", "src/cli.ts", "src/refine.ts"],
	format: ["esm"],
	dts: false,
	clean: true,
	sourcemap: false,
	minify: true,
	splitting: true,
	external: [
		"vite",
		"esbuild",
		"drizzle-orm",
		"drizzle-zod",
		"zod",
		"node:fs",
		"node:path",
		"node:url",
		"node:util",
		"node:fs/promises",
	],
});
