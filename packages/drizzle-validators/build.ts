// build.ts — replaces tsup. Two Bun.build passes:
//   1. Library ESM (index + refine, code-split chunks)
//   2. CLI ESM (self-contained, keeps its shebang, executable bit)
// The package is ESM-only — no CJS output is produced.
// d.ts emission stays with tsc (bun does not generate declarations):
//   "build": "bun ./build.ts && tsc -p tsconfig.build.json"
import { chmod, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";

// Build-time constant injected into the bundles (finding P2-09): the cache
// key must be versioned with the released package version, independent of
// the runtime location-walking fallback.
const PKG = JSON.parse(
	readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

const DEFINE = { __PLUGIN_VERSION__: JSON.stringify(PKG.version) };

// Everything the library links against at runtime stays external so the
// published bundle never inlines peer/vendor code.
const EXTERNAL = [
	"vite",
	"esbuild",
	"drizzle-orm",
	"drizzle-zod",
	"zod",
	"valibot",
	"typebox",
	"arktype",
	"drizzle-valibot",
	"drizzle-typebox",
	"drizzle-arktype",
];

await rm("dist", { recursive: true, force: true });

function assertSuccess(
	label: string,
	result: Awaited<ReturnType<typeof Bun.build>>,
): void {
	if (result.success) return;
	console.error(`[${label}] build failed:`);
	for (const log of result.logs) console.error(String(log));
	process.exit(1);
}

const [libResult, cliResult] = await Promise.all([
	Bun.build({
		entrypoints: ["src/index.ts", "src/refine.ts", "src/refine/valibot.ts"],
		outdir: "dist",
		target: "node",
		format: "esm",
		splitting: true,
		minify: true,
		sourcemap: false,
		external: EXTERNAL,
		define: DEFINE,
		root: "src",
	}),
	Bun.build({
		entrypoints: ["src/cli.ts"],
		outdir: "dist",
		target: "node",
		format: "esm",
		splitting: false,
		minify: true,
		sourcemap: false,
		external: EXTERNAL,
		define: DEFINE,
		root: "src",
	}),
]);

assertSuccess("ESM library", libResult);
assertSuccess("ESM CLI", cliResult);

// The CLI bin must be directly executable (npm preserves the mode from the
// tarball when linking bins).
await chmod("dist/cli.js", 0o755);

console.log("built dist/ (ESM library + ESM CLI) via Bun.build");
