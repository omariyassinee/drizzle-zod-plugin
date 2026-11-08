import type { ValidatorTarget } from "./adapters/types";

export type { ValidatorTarget } from "./adapters/types";

export interface DrizzleValidatorsOptions {
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
	/** Virtual module id clients will import from. Defaults to 'virtual:drizzle-validators'. */
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
	 * `node_modules/.drizzle-validators/`, while `.d.ts` types are emitted
	 * to `virtual-drizzle-validators.d.ts` in your project root so TypeScript gets
	 * full, inferred types without cluttering your project tree.
	 */
	outputPath?: string;
	/**
	 * Policy for columns that serialize to a Node-only class (finding
	 * P2-02). Drizzle's `blob({ mode: "buffer" })` columns round-trip to
	 * `z.instanceof(Buffer)`, which crashes browser bundles at import time.
	 *
	 *  - `"throw"` (default): generation fails with an actionable message.
	 *  - `"keep"`: emit `z.instanceof(Buffer)` deliberately (Node-only
	 *    codebases that never ship these validators to the browser).
	 *
	 * @default "throw"
	 */
	bufferAs?: "throw" | "keep";
	/**
	 * When `true` (default), each Drizzle table gets its own generated file
	 * containing its Insert, Select, and Update Zod schemas, plus a barrel
	 * `index.ts` that re-exports everything.
	 *
	 * When `false`, all schemas are written to a single file.
	 */
	splitByTable?: boolean;
	/**
	 * **Dev-only.** Enable the result caches (in-memory session cache +
	 * the content-addressed disk cache at `node_modules/.cache/`).
	 *
	 * Caches are disabled during production builds regardless of this
	 * option. Off by default: every dev load/change regenerates from
	 * scratch. With `true`, repeated dev generations are served from
	 * validated cache entries and dev no-op reload suppression activates.
	 *
	 * @default false
	 */
	useCache?: boolean;
	/**
	 * Regenerate schemas during production builds.
	 *
	 * @default false — builds never generate; the virtual modules are
	 * served from previously written generated files (run `dv generate`
	 * first, or the build fails with guidance). Dev servers always
	 * regenerate regardless of this option.
	 */
	regenOnBuild?: boolean;
	/**
	 * Also emit the ambient `virtual-drizzle-validators.d.ts` declaration
	 * next to your output (or in the project root in internal mode).
	 *
	 * By default types are provided solely by the hidden
	 * `node_modules/@types/virtual-drizzle-validators` shim, which
	 * TypeScript auto-includes. Only set this when your setup opts out of
	 * `@types` auto-inclusion (`types: []` or custom `typeRoots`) or
	 * `node_modules` is read-only.
	 *
	 * @default false
	 */
	emitRootDts?: boolean;
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
	codes: [string, string, string];
};

export type GeneratedData = {
	code: string;
	singleFileCode: string;
	exportNames: string[];
	tableCodes: Map<string, TableCodeData>;
	depPaths: string[];
	/** The validator target this data was generated for. */
	target: ValidatorTarget;
	/** Import line embedded at the top of generated per-table modules. */
	importStatement: string;
	refineExportStatement?: string;
	refineDtsStatement?: string;
};
