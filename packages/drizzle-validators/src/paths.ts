import {
	dirname,
	isAbsolute,
	join as joinPath,
	resolve as resolvePath,
} from "node:path";
import type { DrizzleValidatorsOptions, ResolvedPaths } from "./types";

/**
 * Resolve all output/tmp paths. `schemaPath` must already be resolved
 * (either from options or from drizzle config auto-detection).
 */
export function getResolvedPaths(
	schemaPath: string,
	options: Pick<DrizzleValidatorsOptions, "outputPath" | "moduleId">,
	viteRoot: string,
	splitByTable: boolean,
): ResolvedPaths {
	const absoluteSchemaPath = isAbsolute(schemaPath)
		? schemaPath
		: resolvePath(viteRoot, schemaPath);

	const hasUserOutput = typeof options.outputPath === "string";

	// When splitByTable is on, outputPath is a directory.
	// Strip .ts extension if present so "./validators.ts" → "./validators/".
	let rawOutput = options.outputPath ?? "";
	if (splitByTable && rawOutput.endsWith(".ts")) {
		rawOutput = rawOutput.replace(/\.ts$/, "");
	}

	const absoluteOutputDir = hasUserOutput
		? isAbsolute(rawOutput)
			? rawOutput
			: resolvePath(viteRoot, rawOutput)
		: resolvePath(viteRoot, "node_modules", ".drizzle-validators");

	const userOutput = options.outputPath;
	const absoluteOutputPath = splitByTable
		? joinPath(absoluteOutputDir, "index.ts")
		: userOutput
			? isAbsolute(userOutput)
				? userOutput
				: resolvePath(viteRoot, userOutput)
			: joinPath(absoluteOutputDir, "__internal-schemas.ts");

	// d.ts name derives from the moduleId (sanitized) so multi-instance
	// setups don't overwrite each other's declarations. The default id
	// keeps the historical filename.
	const sanitizedModuleId = (options.moduleId ?? "virtual:drizzle-validators").replace(
		/[^a-zA-Z0-9-]/g,
		"-",
	);
	const dtsName = `${sanitizedModuleId}.d.ts`;
	const dtsPath = hasUserOutput
		? splitByTable
			? resolvePath(absoluteOutputDir, dtsName)
			: resolvePath(dirname(absoluteOutputPath), dtsName)
		: resolvePath(viteRoot, dtsName);

		// Keep the bundled module inside the project root so package self-references
		// and workspace exports resolve from the package that owns the schema.
		const tmpDir = joinPath(viteRoot, ".drizzle-validators-tmp");

	return {
		absoluteSchemaPath,
		absoluteOutputPath,
		absoluteOutputDir,
		dtsPath,
		tmpDir,
	};
}
