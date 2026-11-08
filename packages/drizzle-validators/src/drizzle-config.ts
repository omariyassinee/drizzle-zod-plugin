import { access, mkdir, rmdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DrizzleValidatorsError } from "./errors";
import {
	dirname,
	isAbsolute,
	join as joinPath,
	resolve as resolvePath,
} from "node:path";
import { pathToFileURL } from "node:url";
import { loadEsbuild } from "./esbuild-loader";

const CANDIDATE_NAMES = [
	"drizzle.config.ts",
	"drizzle.config.js",
	"drizzle.config.mjs",
	"drizzle.config.json",
];

/**
 * Finds the drizzle config file in `projectRoot` (or the explicitly provided
 * `configPath`), without bundling/importing it. Returns the absolute path,
 * or undefined when no config can be found.
 *
 * Exported so the Vite plugin can watch the config file for changes
 * (finding P5) — a changed config may point at a different schema file.
 */
export async function findDrizzleConfigPath(opts: {
	configPath?: string;
	projectRoot: string;
}): Promise<string | undefined> {
	if (opts.configPath) {
		const resolved = resolvePath(opts.projectRoot, opts.configPath);
		return (await fileExists(resolved)) ? resolved : undefined;
	}
	for (const name of CANDIDATE_NAMES) {
		const full = resolvePath(opts.projectRoot, name);
		if (await fileExists(full)) return full;
	}
	return undefined;
}

/**
 * Resolves the Drizzle schema path.
 *
 * If `schemaPath` is provided, returns it resolved against `projectRoot`.
 * Otherwise, looks for `drizzle.config.{ts,js,mjs}` in `projectRoot`,
 * bundles it with esbuild, imports it, and extracts the `schema` field.
 */
export async function resolveSchemaPath(opts: {
	schemaPath?: string;
	configPath?: string;
	projectRoot: string;
}): Promise<string> {
	// 1. Explicit schemaPath wins (returned as-is; callers resolve it against
	//    the Vite root, matching previous behavior).
	if (opts.schemaPath) return opts.schemaPath;

	// 2. Find the config (explicit --config wins; else scan candidates)
	const configPath = await findDrizzleConfigPath(opts);

	if (!configPath) {
		throw new DrizzleValidatorsError(
			`No schemaPath provided, and no drizzle config file found ` +
				`(tried ${CANDIDATE_NAMES.join(", ")}) in ${opts.projectRoot}.`,
		);
	}

	// 3. Bundle + import the config (same technique as schema bundling)
	const esbuild = await loadEsbuild();
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
		throw new DrizzleValidatorsError(
			`Failed to bundle drizzle config ${configPath}`,
		);
	}

	const tmpDir = resolvePath(opts.projectRoot, ".drizzle-validators-tmp");
	await mkdir(tmpDir, { recursive: true });
	// Unique per write — same reasoning as schema-generator.ts.
	const tmpFile = joinPath(
		tmpDir,
		`drizzle-config-${Date.now()}-${randomUUID().slice(0, 8)}.mjs`,
	);
	await writeFile(tmpFile, bundledCode);

	let config: Record<string, unknown>;
	try {
		const mod = await import(pathToFileURL(tmpFile).href);
		config = mod.default ?? mod;
	} finally {
		// Non-recursive: only an EMPTY dir is removed — concurrent
		// generations sharing this dir keep their in-flight files safe.
		await rm(tmpFile, { force: true });
		await rmdir(tmpDir).catch(() => {});
	}

	const rawSchema = config?.schema;

	if (typeof rawSchema === "string") {
		// Drizzle resolves relative schema paths against the CONFIG FILE'S
		// directory, not the project root — match that so monorepo layouts
		// (e.g. packages/db/drizzle.config.ts with schema './src/schema.ts')
		// resolve correctly (finding C3). Absolute paths pass through.
		return isAbsolute(rawSchema)
			? rawSchema
			: resolvePath(dirname(configPath), rawSchema);
	}

	if (Array.isArray(rawSchema) && rawSchema.length > 0) {
		throw new DrizzleValidatorsError(
			`drizzle config (${configPath}) has a "schema" field ` +
				`that is a string[] (${rawSchema.length} entries). ` +
				`Please provide a single string path, or pass schemaPath explicitly to the plugin.`,
		);
	}

	throw new DrizzleValidatorsError(
		`drizzle config (${configPath}) has no valid "schema" field ` +
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
