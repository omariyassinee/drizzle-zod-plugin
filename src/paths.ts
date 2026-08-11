import {
	dirname,
	isAbsolute,
	join as joinPath,
	resolve as resolvePath,
} from "node:path";
import type { DrizzleZodVirtualOptions, ResolvedPaths } from "./types";

/**
 * Resolve all output/tmp paths. `schemaPath` must already be resolved
 * (either from options or from drizzle config auto-detection).
 */
export function getResolvedPaths(
	schemaPath: string,
	options: Pick<DrizzleZodVirtualOptions, "outputPath">,
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
		: resolvePath(viteRoot, "node_modules", ".drizzle-zod-plugin");

	const userOutput = options.outputPath;
	const absoluteOutputPath = splitByTable
		? joinPath(absoluteOutputDir, "index.ts")
		: userOutput
			? isAbsolute(userOutput)
				? userOutput
				: resolvePath(viteRoot, userOutput)
			: joinPath(absoluteOutputDir, "__internal-schemas.ts");

	const dtsPath = hasUserOutput
		? splitByTable
			? resolvePath(absoluteOutputDir, "virtual-drizzle-zod.d.ts")
			: resolvePath(dirname(absoluteOutputPath), "virtual-drizzle-zod.d.ts")
		: resolvePath(viteRoot, "virtual-drizzle-zod.d.ts");

	const tmpDir = joinPath(viteRoot, "node_modules", ".drizzle-zod-virtual-tmp");

	return {
		absoluteSchemaPath,
		absoluteOutputPath,
		absoluteOutputDir,
		dtsPath,
		tmpDir,
	};
}
