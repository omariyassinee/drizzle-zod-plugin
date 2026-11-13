import { zodTypeToCode } from "../zod-serializer";
import type {
	EmitContext,
	SchemaCreators,
	SerializerAdapter,
} from "./types";
import { DEPENDENCY_PACKAGES } from "./types";

/**
 * Zod adapter — wraps the existing Zod 4 serializer unchanged. This is the
 * historical behavior of the package; `target: "zod"` must remain
 * byte-for-byte identical to pre-adapter output.
 */
export const zodAdapter: SerializerAdapter = {
	target: "zod",
	importStatement: "import * as z from 'zod'",
	dependencyPackages: DEPENDENCY_PACKAGES.zod,
	refineExportStatement:
		"export { refineZSchema } from 'drizzle-validators/refine'",
	refineDtsStatement:
		"export const refineZSchema: (typeof import('drizzle-validators/refine'))['refineZSchema']",

	async loadCreators(): Promise<SchemaCreators> {
		try {
			const mod = await import("drizzle-orm/zod");
			return {
				createInsertSchema: mod.createInsertSchema,
				createSelectSchema: mod.createSelectSchema,
				createUpdateSchema: mod.createUpdateSchema,
			};
		} catch {
			const mod = await import("drizzle-zod");
			return {
				createInsertSchema: mod.createInsertSchema,
				createSelectSchema: mod.createSelectSchema,
				createUpdateSchema: mod.createUpdateSchema,
			};
		}
	},

	emit(schema: unknown, ctx: EmitContext): string {
		return zodTypeToCode(schema as any, undefined, ctx.depth, {
			bufferAs: ctx.bufferAs,
		});
	},
};
