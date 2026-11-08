import { VALIDATOR_TARGETS } from "./types";
import { DrizzleValidatorsError } from "../errors";
import { zodAdapter } from "./zod";

import type { SerializerAdapter, ValidatorTarget } from "./types";

export type { EmitContext, SerializerAdapter, ValidatorTarget } from "./types";
export { VALIDATOR_TARGETS } from "./types";

/**
 * Default virtual-module id. Kept as a pure function (not an adapter field)
 * because the plugin's `resolveId` hook and the CLI must resolve the default
 * synchronously, before any async adapter load. The id is target-agnostic —
 * the generated import line already tells you which library it is.
 */
export function defaultModuleId(): string {
	return "virtual:drizzle-validators";
}

export function isValidTarget(value: unknown): value is ValidatorTarget {
	return (
		typeof value === "string" &&
		(VALIDATOR_TARGETS as readonly string[]).includes(value)
	);
}

/**
 * Resolves the serializer adapter for a target. Non-zod adapters load
 * lazily (dynamic import) so a missing optional peer library surfaces as an
 * actionable error at the adapter's own `loadCreators` — never as a raw
 * unresolvable-module stack at registry load (esbuild-loader pattern,
 * finding P2-11).
 */
export async function loadAdapter(
	target: ValidatorTarget,
): Promise<SerializerAdapter> {
	switch (target) {
		case "zod":
			return zodAdapter;
		case "typebox":
			return (await import("./typebox")).typeboxAdapter;
		case "valibot":
			return (await import("./valibot")).valibotAdapter;
	}
	throw new DrizzleValidatorsError(
		`Unknown validator target "${String(target)}". ` +
			`Expected one of: ${VALIDATOR_TARGETS.map((t) => `"${t}"`).join(", ")}.`,
	);
}
