import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const CANDIDATE_NAMES = [
	"drizzle.config.ts",
	"drizzle.config.js",
	"drizzle.config.mjs",
];

/**
 * Resolves the Drizzle schema path.
 *
 * If `schemaPath` is provided, returns it resolved against `projectRoot`.
 * Otherwise, looks for `drizzle.config.{ts,js,mjs}` in `projectRoot`,
 * bundles it with esbuild, imports it, and extracts the `schema` field.
 */
export async function resolveSchemaPath(opts: {
	schemaPath?: string;
	projectRoot: string;
}): Promise<string> {
	// 1. Explicit schemaPath wins
	if (opts.schemaPath) return opts.schemaPath;

	// 2. Look for drizzle.config.*
	let configPath: string | undefined;
	for (const name of CANDIDATE_NAMES) {
		const full = resolvePath(opts.projectRoot, name);
		if (await fileExists(full)) {
			configPath = full;
			break;
		}
	}

	if (!configPath) {
		throw new Error(
			`[drizzle-zod-virtual] No schemaPath provided, and no drizzle config file found ` +
				`(tried ${CANDIDATE_NAMES.join(", ")}) in ${opts.projectRoot}.`,
		);
	}

	// 3. Bundle + import the config (same technique as schema bundling)
	const result = await esbuild.build({
		entryPoints: [configPath],
		absWorkingDir: opts.projectRoot,
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		write: false,
		logLevel: "silent",
	});

	const bundledCode = result.outputFiles?.[0]?.text;
	if (!bundledCode) {
		throw new Error(
			`[drizzle-zod-virtual] Failed to bundle drizzle config ${configPath}`,
		);
	}

	const tmpDir = resolvePath(
		opts.projectRoot,
		"node_modules",
		".drizzle-zod-virtual-tmp",
	);
	await mkdir(tmpDir, { recursive: true });
	const tmpFile = joinPath(tmpDir, `drizzle-config-${Date.now()}.mjs`);
	await writeFile(tmpFile, bundledCode);

	let config: Record<string, unknown>;
	try {
		const mod = await import(pathToFileURL(tmpFile).href);
		config = mod.default ?? mod;
	} finally {
		await rm(tmpFile, { force: true });
	}

	const rawSchema = config?.schema;

	if (typeof rawSchema === "string") {
		return rawSchema;
	}

	if (Array.isArray(rawSchema) && rawSchema.length > 0) {
		throw new Error(
			`[drizzle-zod-virtual] drizzle config (${configPath}) has a "schema" field ` +
				`that is a string[] (${rawSchema.length} entries). ` +
				`Please provide a single string path, or pass schemaPath explicitly to the plugin.`,
		);
	}

	throw new Error(
		`[drizzle-zod-virtual] drizzle config (${configPath}) has no valid "schema" field ` +
			`(got ${typeof rawSchema}). ` +
			`Please set a schema path in your drizzle config, or pass schemaPath explicitly to the plugin.`,
	);
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
