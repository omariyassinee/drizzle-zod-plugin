import { DrizzleValidatorsError } from "./errors";
type Esbuild = typeof import("esbuild");

let _esbuild: Esbuild | undefined;

/**
 * Resolves the esbuild peer lazily (finding P2-11): a top-level
 * `import * as esbuild` gets hoisted by the ESM bundle, so a consumer
 * without esbuild in their tree crashed with the raw npm-resolver message
 * at IMPORT time. Behind a function call the failure surfaces where it can
 * be caught and explained.
 */
export async function loadEsbuild(): Promise<Esbuild> {
	try {
		_esbuild = await import("esbuild");
		return _esbuild;
	} catch {
		throw new DrizzleValidatorsError(
			`Couldn't load the 'esbuild' peer dependency. ` +
				`esbuild is required for schema bundling — install it in the project you are invoking this plugin/CLI from: ` +
				`npm install --save-dev esbuild  (or bun add --dev esbuild)`,
		);
	}
}
