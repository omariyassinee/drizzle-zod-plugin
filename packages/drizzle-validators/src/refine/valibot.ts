// Subpath entrypoint for `@vacuus/drizzle-validators/refine/valibot`.
// Isolated from the Zod engine on purpose: importing this module must
// never pull zod, and `@vacuus/drizzle-validators/refine` must never pull
// valibot. Only valibot-target consumers reach this file.
export {
	refineVSchema,
	type AnyValibotSchema,
	type VAsOptions,
	type VFieldProxy,
	type RefinableVShape,
	type VRefinementCallbackResult,
	type RefinedVEntries,
	type RebuiltVObject,
	type VEntriesOf,
	type VErrorMessage,
} from "../valibot-refine";
export type { FieldErrorMapV } from "../valibot-error-map";
