import { zodTypeToCode } from "../../../src/zod-serializer";
import { expect, test } from "./_helpers";
import { z } from "zod";

// P2-16: symbol-keyed object fields were silently dropped by
// Object.entries(shape) — the emitted z.object({}) accepted inputs the
// original rejected. Fail loud now.

test("P2-16: symbol-keyed field fails loud at generation", () => {
	const sym = Symbol("hidden");
	const base = z.object({ a: z.string() });
	// inject a symbol-keyed field into the raw shape (zod keeps it there)
	(base as any)._zod.def.shape[sym] = z.string();
	// zod exposes the field through the symbol key as well
	(base as any).shape?.[sym];
	expect(() => zodTypeToCode(base)).toThrow(/[Ss]ymbol/);
});