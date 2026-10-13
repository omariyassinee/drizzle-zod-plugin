import { defineConfig } from "tsup";

const SHARED_EXTERNAL = [
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
];

export default defineConfig([
	// Library entries: dual ESM + CJS so CJS-only consumers (Jest, .cjs Vite
	// configs, older SSR tooling) can require() the package (finding B4).
	{
		entry: ["src/index.ts", "src/refine.ts"],
		format: ["esm", "cjs"],
		dts: false,
		clean: true,
		sourcemap: false,
		minify: true,
		splitting: true,
		external: SHARED_EXTERNAL,
	},
	// The CLI must stay ESM-only: it uses `import.meta.url` (version lookup)
	// and a shebang, and never gets imported by bundlers.
	{
		entry: ["src/cli.ts"],
		format: ["esm"],
		dts: false,
		sourcemap: false,
		minify: true,
		splitting: false,
		external: SHARED_EXTERNAL,
	},
]);

