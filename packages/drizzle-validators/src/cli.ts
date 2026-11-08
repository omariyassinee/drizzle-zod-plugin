#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join as joinPath, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { defaultModuleId, isValidTarget, VALIDATOR_TARGETS } from "./adapters";
import { formatError } from "./errors";
import { resolveSchemaPath } from "./drizzle-config";
import { writeGeneratedFiles } from "./file-writer";
import { getResolvedPaths } from "./paths";

// NOTE: schema-generator is imported lazily inside runCli so a missing
// optional peer (esbuild) fails with an actionable message instead of the
// raw Node "Cannot find package" stack at module load (finding P2-11).

/**
 * Reads the version from package.json at runtime rather than hardcoding it
 * (finding L1). `import.meta.url` is module-relative, so this resolves both
 * when running from src/ (bun test) and from dist/cli.js in the published
 * package (npm always ships package.json alongside dist/).
 */
function readVersion(): string {
	try {
		const pkgPath = joinPath(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"package.json",
		);
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		return typeof pkg.version === "string" ? pkg.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

const VERSION = readVersion();

const HELP_TEXT = `
dv - CLI for drizzle-validators

Usage:
  bunx dv [command] [options]
  bunx dv generate [options]
  npx dv generate [options]

Commands:
  generate                  Generate Zod schemas from Drizzle tables (default)

Options:
  -s, --schema <path>      Path to Drizzle schema file (auto-detects from drizzle.config.* if omitted)
  -o, --output <path>      Output directory or file path for generated schemas (default: ./validators)
  -t, --tables <names>     Comma-separated list of table names to include
  --split                  Generate separate files per table (default: true)
  --no-split               Generate all schemas in a single file
  -m, --module-id <id>     Virtual module ID (default: virtual:drizzle-validators)
      --target <name>      Validation library to emit: zod (default), valibot, or typebox
  -r, --root <path>        Project root directory (default: current working directory)
  -c, --config <path>      Explicit path to drizzle.config file
      --buffer-as <mode>   Blob buffer serialization policy: throw (default) or keep
  -v, --version            Show version
  -h, --help               Show this help message

Examples:
  bunx dv generate
  bunx dv generate --schema ./src/db/schema.ts --output ./src/validators
  bunx dv generate --no-split --output ./src/validators.ts
  bunx dv generate --tables users,posts
`;

export async function runCli(
	args: string[] = process.argv.slice(2),
): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			schema: { type: "string", short: "s" },
			output: { type: "string", short: "o" },
			tables: { type: "string", short: "t" },
			split: { type: "boolean", default: true },
			"no-split": { type: "boolean" },
			"module-id": { type: "string", short: "m" },
			target: { type: "string" },
			root: { type: "string", short: "r" },
			config: { type: "string", short: "c" },
			"buffer-as": { type: "string" },
			version: { type: "boolean", short: "v" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: true,
		strict: false,
	});

	if (values.help) {
		console.log(HELP_TEXT);
		return;
	}

	if (values.version) {
		console.log(`dv v${VERSION}`);
		return;
	}

	const command = positionals[0] ?? "generate";

	if (command === "help") {
		console.log(HELP_TEXT);
		return;
	}

	if (
		command !== "generate" &&
		command !== "dv:generate" &&
		command !== "dv-generate"
	) {
		console.error(`[dv] Unknown command "${command}"\n`);
		console.log(HELP_TEXT);
		process.exitCode = 1;
		return;
	}

	const projectRoot = values.root
		? resolvePath(process.cwd(), values.root as string)
		: process.cwd();

	const targetRaw = values.target as string | undefined;
	if (targetRaw !== undefined && !isValidTarget(targetRaw)) {
		console.error(
			`[dv] Unknown --target value "${targetRaw}" (expected one of: ${VALIDATOR_TARGETS.map((t) => `"${t}"`).join(", ")}).`,
		);
		process.exitCode = 1;
		return;
	}
	const target = targetRaw ?? "zod";

	let schemaPath = values.schema as string | undefined;

	if (!schemaPath) {
		schemaPath = await resolveSchemaPath({
			configPath: values.config ? (values.config as string) : undefined,
			projectRoot,
		});
	}

	const outputPath = (values.output as string | undefined) ?? "./validators";
	const splitByTable = values["no-split"] ? false : values.split !== false;
	const moduleId =
		(values["module-id"] as string | undefined) ?? defaultModuleId();
	const tables = values.tables
		? (values.tables as string)
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean)
		: undefined;

	const startTime = performance.now();

	const paths = getResolvedPaths(
		schemaPath,
		{ outputPath },
		projectRoot,
		splitByTable,
	);

	// Lazy imports: a missing optional peer must fail with actionable
	// guidance, not the unresolvable-module stack (finding P2-11).
	const bufferRaw = (values["buffer-as"] as string | undefined) ?? "throw";
	if (bufferRaw !== "keep" && bufferRaw !== "throw") {
		console.error(
			`[dv] Unknown --buffer-as value "${bufferRaw}" (expected "throw" or "keep"), using "throw".`,
		);
	}
	const bufferAs = bufferRaw === "keep" ? "keep" : "throw";

	// The CLI intentionally performs a full regeneration on every run — no
	// in-memory or disk cache is read or written (the plugin owns caching).
	const { generateSchemas } = await import("./schema-generator");
	const generated = await generateSchemas({
		absoluteSchemaPath: paths.absoluteSchemaPath,
		schemaPath,
		tmpDir: paths.tmpDir,
		viteRoot: projectRoot,
		tables,
		moduleId,
		target,
		serializer: { bufferAs },
	});
	const data = generated;

	await writeGeneratedFiles({
		paths,
		options: { outputPath, splitByTable },
		viteRoot: projectRoot,
		splitByTable,
		moduleId,
		data,
	});

	const duration = (performance.now() - startTime).toFixed(0);
	console.log(`[dv] generated ${data.exportNames.length} schemas in ${duration}ms`);
}

// Auto-run if executed directly as entrypoint. Covers both bin names
// (`dv` and the long-form `drizzle-validators`) plus dev invocations of the
// source file.
const isMain =
	(typeof import.meta.main === "boolean" && import.meta.main) ||
	(process.argv[1] &&
		(process.argv[1].endsWith("cli.ts") ||
			process.argv[1].endsWith("cli.js") ||
			process.argv[1].endsWith("dv") ||
			process.argv[1].endsWith("drizzle-validators") ||
			process.argv[1].endsWith("dv-generate") ||
			process.argv[1].endsWith("dv:generate")));

if (isMain) {
	runCli().catch((err) => {
		console.error(`[dv] ${formatError(err)}`);
		process.exit(1);
	});
}
