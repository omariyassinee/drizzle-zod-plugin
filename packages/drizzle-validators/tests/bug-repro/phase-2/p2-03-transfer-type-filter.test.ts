import { expect, test } from "./_helpers";
import { z } from "zod";
import { refineZSchema } from "../../../src/refine";

// P2-03: transferChecks() only worked when the source core type matched
// the target core type; a `.as()` type change made the copied checks_THROW
// at construction (elegantly). min/max length and format checks are only
// valid on strings; gte/lte only on numeric/bigint/date. Cross-type .as()
// now FILTERS incompatible checks instead of crashing.

const strSchema = z.object({
	a: z.string().min(3).max(10),
});

test("P2-03 regression: same-core-type checks still transfer", () => {
	// keep core type string -> email: min/max length survive (constraints)
	const refined = refineZSchema(
		z.object({ a: z.string().max(255) }),
		(f) => ({ a: f.a.as(z.email()) }),
	);
	const shape = refined.shape;
	expect(shape.a.safeParse("not-an-email").success).toBe(false);
	expect(shape.a.safeParse("not-an-email@ok.dev").success).toBe(true);
	// max(255) constraint survived the asEmail()
	expect(shape.a.safeParse(`${"x".repeat(300)}@ok.dev`).success).toBe(false);
});

test("P2-03: string -> number .as() drops string-only checks, no crash", () => {
	const refined = refineZSchema(strSchema, (f) => ({
		a: f.a.as(z.number()),
	}));
	// no crash; the field now parses numbers
	expect(refined.safeParse({ a: 42 }).success).toBe(true);
	// no length semantics on the number (42 would violate min_length(3)/max10)
	expect(refined.safeParse({ a: 1 }).success).toBe(true);
	// the core type legitimately changed so string inputs now fail
	expect(refined.safeParse({ a: "abc" }).success).toBe(false);
});

test("P2-03: uuid-swap keeps string-core length checks (valid within bounds)", () => {
	const refined = refineZSchema(
		z.object({
			id: z.string().min(3).max(40),
		}),
		(f) => ({ id: f.id.as(z.uuid()) }),
	);
	// string core survives: length checks (kept) + uuid format added
	const uuidLike = "0e6c2515-b263-411b-b60d-4b67633de29a";
	expect(refined.safeParse({ id: uuidLike }).success).toBe(true);
	// uuid format applies
	expect(refined.safeParse({ id: "not-a-uuid" }).success).toBe(false);
	// length bounds still apply to strings within the string core
	expect(refined.safeParse({ id: "ab" }).success).toBe(false);
});

test("P2-03: number -> string .as() drops number-only checks", () => {
	const refined = refineZSchema(
		z.object({ n: z.number().gt(3) }),
		(f) => ({ n: f.n.as(z.string()) }),
	);
	// no crash + string validates without requiring > 3 semantics
	expect(refined.safeParse({ n: "abc" }).success).toBe(true);
});

test("P2-03 regression: checks within same core type fully transferred", () => {
	const refined = refineZSchema(
		z.object({ n: z.number().gt(3).lt(10) }),
		(f) => ({ n: f.n.as(z.number()) }),
	);
	expect(refined.safeParse({ n: 5 }).success).toBe(true);
	expect(refined.safeParse({ n: 2 }).success).toBe(false);
	expect(refined.safeParse({ n: 20 }).success).toBe(false);
});
