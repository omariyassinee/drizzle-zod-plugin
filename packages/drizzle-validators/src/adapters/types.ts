/**
 * Target-agnostic contract every validator serializer implements.
 *
 * The generation pipeline (table bundling, discovery, file writing, d.ts,
 * cache, virtual-module serving) is validator-agnostic; only the adapter
 * knows how to (a) load drizzle's `create*Schema` creators for its library
 * and (b) serialize the produced runtime schema object back into plain
 * source code for that library.
 */

export type ValidatorTarget = "zod" | "valibot" | "typebox";

export const VALIDATOR_TARGETS: readonly ValidatorTarget[] = [
	"zod",
	"valibot",
	"typebox",
];

/**
 * Single source of truth for the packages whose installed versions feed the
 * cache dependency fingerprint. The adapters' `dependencyPackages` field
 * and `dependencyFingerprint` in cache.ts both read from here.
 */
export const DEPENDENCY_PACKAGES: Record<ValidatorTarget, string[]> = {
	zod: ["drizzle-orm", "drizzle-zod", "zod"],
	valibot: ["drizzle-orm", "valibot"],
	typebox: ["drizzle-orm", "typebox"],
};

/**
 * Per-target emission policy shared with every adapter.
 *
 * `bufferAs` mirrors the Zod serializer's P2-02 policy: columns that probe a
 * Node-only class (e.g. `Buffer`) either fail generation ("throw") or are
 * emitted deliberately for server-only codebases ("keep").
 */
export interface EmitContext {
	bufferAs: "throw" | "keep";
	/** Current recursion depth (guards cyclic/excessively nested schemas). */
	depth: number;
}

export interface SchemaCreators {
	createInsertSchema: (table: any) => any;
	createSelectSchema: (table: any) => any;
	createUpdateSchema: (table: any) => any;
}

export interface SerializerAdapter {
	target: ValidatorTarget;
	/**
	 * Import line emitted at the top of generated modules, e.g.
	 * `import * as z from 'zod'`.
	 */
	importStatement: string;
	/**
	 * Packages folded into the disk-cache dependency fingerprint (they are
	 * `external` in the esbuild bundle, so a version bump must invalidate
	 * the cache key explicitly).
	 */
	dependencyPackages: string[];
	/**
	 * Runtime re-export emitted into the virtual barrel, submodules, and
	 * generated files for this target (refineZSchema/refineVSchema).
	 * Undefined for targets without a refine engine (typebox).
	 */
	refineExportStatement?: string;
	/** Matching line for the generated .d.ts (ambient module re-export). */
	refineDtsStatement?: string;
	loadCreators(): Promise<SchemaCreators>;
	/**
	 * Serializes a runtime schema object (as produced by this adapter's
	 * creators) into plain source code for the target library.
	 */
	emit(schema: unknown, ctx: EmitContext): string;
}
