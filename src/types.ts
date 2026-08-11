export interface DrizzleZodVirtualOptions {
	/**
	 * Path to the file exporting your Drizzle tables (server-only file).
	 *
	 * If omitted, the plugin attempts to read `schema` from `drizzle.config.ts`
	 * (or `.js`, `.mjs`) in the project root. Throws if neither is available
	 * or if the config's `schema` field is not a single string.
	 */
	schemaPath?: string;
	/**
	 * Names of the exported table objects to generate schemas for.
	 * Omit to auto-detect every exported Drizzle table in schemaPath.
	 */
	tables?: string[];
	/** Virtual module id clients will import from. Defaults to 'virtual:drizzle-zod'. */
	moduleId?: string;
	/**
	 * Optional path to write the generated Zod source to disk (relative to
	 * project root).
	 *
	 * When `splitByTable` is `true` (default), this is treated as a **directory**
	 * path. Each table gets its own file (e.g. `validators/users.ts`) plus a
	 * barrel `index.ts` that re-exports everything. If the path ends in `.ts`,
	 * the extension is stripped and the base name is used as the directory.
	 *
	 * When `splitByTable` is `false`, this is treated as a single **file** path
	 * and all schemas are written to one file (e.g. `validators.ts`).
	 *
	 * When omitted entirely, everything is kept internal inside
	 * `node_modules/.drizzle-zod-plugin/`, while `.d.ts` types are emitted
	 * to `virtual-drizzle-zod.d.ts` in your project root so TypeScript gets
	 * full, inferred types without cluttering your project tree.
	 */
	outputPath?: string;
	/**
	 * When `true` (default), each Drizzle table gets its own generated file
	 * containing its Insert, Select, and Update Zod schemas, plus a barrel
	 * `index.ts` that re-exports everything.
	 *
	 * When `false`, all schemas are written to a single file.
	 */
	splitByTable?: boolean;
	/**
	 * Disable the in-memory result cache.
	 *
	 * When `true`, the plugin rebuilds schemas from scratch on every
	 * module load, build start, and file change. This is useful when you're
	 * debugging staleness issues or working in an environment where file
	 * watchers behave unreliably.
	 *
	 * Concurrent requests are still deduplicated so two parallel imports
	 * of `virtual:drizzle-zod` won't trigger two simultaneous esbuild
	 * rebuilds.
	 *
	 * @default false
	 */
	noCache?: boolean;
}

export type ResolvedPaths = {
	absoluteSchemaPath: string;
	absoluteOutputPath: string;
	absoluteOutputDir: string;
	dtsPath: string;
	tmpDir: string;
};

export type TableCodeData = {
	code: string;
	exportNames: string[];
	zodCodes: [string, string, string];
};

export type GeneratedData = {
	code: string;
	singleFileCode: string;
	exportNames: string[];
	tableCodes: Map<string, TableCodeData>;
	depPaths: string[];
};
