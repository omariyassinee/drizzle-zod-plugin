#!/usr/bin/env node
import { resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { resolveSchemaPath } from "./drizzle-config";
import { writeGeneratedFiles } from "./file-writer";
import { getResolvedPaths } from "./paths";
import { generateSchemas } from "./schema-generator";

const VERSION = "0.1.313";

const HELP_TEXT = `
vdz - CLI for Drizzle Zod Virtual Plugin

Usage:
  bunx vdz [command] [options]
  bunx vdz generate [options]
  npx vdz generate [options]

Commands:
  generate                  Generate Zod schemas from Drizzle tables (default)

Options:
  -s, --schema <path>      Path to Drizzle schema file (auto-detects from drizzle.config.* if omitted)
  -o, --output <path>      Output directory or file path for generated schemas (default: ./validators)
  -t, --tables <names>     Comma-separated list of table names to include
  --split                  Generate separate files per table (default: true)
  --no-split               Generate all schemas in a single file
  -m, --module-id <id>     Virtual module ID (default: virtual:drizzle-zod)
  -r, --root <path>        Project root directory (default: current working directory)
  -c, --config <path>      Explicit path to drizzle.config file
  -v, --version            Show version
  -h, --help               Show this help message

Examples:
  bunx vdz generate
  bunx vdz generate --schema ./src/db/schema.ts --output ./src/validators
  bunx vdz generate --no-split --output ./src/validators.ts
  bunx vdz generate --tables users,posts
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
			root: { type: "string", short: "r" },
			config: { type: "string", short: "c" },
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
		console.log(`vdz v${VERSION}`);
		return;
	}

	const command = positionals[0] ?? "generate";

	if (command === "help") {
		console.log(HELP_TEXT);
		return;
	}

	if (
		command !== "generate" &&
		command !== "vdz:generate" &&
		command !== "vdz-generate"
	) {
		console.error(`[vdz] Unknown command "${command}"\n`);
		console.log(HELP_TEXT);
		process.exitCode = 1;
		return;
	}

	const projectRoot = values.root
		? resolvePath(process.cwd(), values.root as string)
		: process.cwd();

	let schemaPath = values.schema as string | undefined;

	if (!schemaPath) {
		schemaPath = await resolveSchemaPath({
			schemaPath: values.config ? (values.config as string) : undefined,
			projectRoot,
		});
	}

	const outputPath = (values.output as string | undefined) ?? "./validators";
	const splitByTable = values["no-split"] ? false : values.split !== false;
	const moduleId = (values["module-id"] as string | undefined) ?? "virtual:drizzle-zod";
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

	const data = await generateSchemas({
		absoluteSchemaPath: paths.absoluteSchemaPath,
		schemaPath,
		tmpDir: paths.tmpDir,
		viteRoot: projectRoot,
		tables,
		moduleId,
	});

	await writeGeneratedFiles({
		paths,
		options: { outputPath, splitByTable },
		viteRoot: projectRoot,
		splitByTable,
		moduleId,
		data,
	});

	const duration = (performance.now() - startTime).toFixed(0);
	console.log(
		`[vdz] Successfully generated ${data.exportNames.length} schemas across ${data.tableCodes.size} tables in ${duration}ms`,
	);
}

// Auto-run if executed directly as entrypoint
const isMain =
	(typeof (import.meta as any).main === "boolean" && (import.meta as any).main) ||
	(process.argv[1] &&
		(process.argv[1].endsWith("cli.ts") ||
			process.argv[1].endsWith("cli.js") ||
			process.argv[1].endsWith("vdz") ||
			process.argv[1].endsWith("vdz-generate") ||
			process.argv[1].endsWith("vdz:generate")));

if (isMain) {
	runCli().catch((err) => {
		console.error(
			`[vdz] Error: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	});
}
