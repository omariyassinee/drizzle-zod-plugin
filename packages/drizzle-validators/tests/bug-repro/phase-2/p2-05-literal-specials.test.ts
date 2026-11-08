import { zodTypeToCode } from "../../../src/zod-serializer";
import { evalDefault, expect, test } from "./_helpers";
import { z } from "zod";

// P2-05: z.literal(NaN) and z.literal(±Infinity) serialized to
// z.literal(null) — JSON.stringify mangles them. zod compares literal
// values with Object.is, so emitting Number.NaN / Number.POSITIVE_INFINITY
// is an exact round-trip.

test("P2-05: z.literal(NaN) round-trips semantically", async () => {
	const schema = z.literal(Number.NaN);
	const code = zodTypeToCode(schema);
	expect(code).toBe("z.literal(Number.NaN)");
	const emitted = await evalDefault(code);
	expect(emitted.safeParse(Number.NaN).success).toBe(true);
	expect(emitted.safeParse(0).success).toBe(false);
});

test("P2-05: z.literal(±Infinity) round-trips semantically", async () => {
	for (const v of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		const code = zodTypeToCode(z.literal(v));
		const emitted = await evalDefault(code);
		expect(emitted.safeParse(v).success).toBe(true);
		expect(emitted.safeParse(1).success).toBe(false);
	}
});

test("P2-05: multi-value literals keep NaN/Infinity through the array form", async () => {
	const schema = z.literal([1, Number.POSITIVE_INFINITY, Number.NaN]);
	const code = zodTypeToCode(schema);
	expect(code).toBe(
		"z.literal([1, Number.POSITIVE_INFINITY, Number.NaN])",
	);
	const emitted = await evalDefault(code);
	expect(emitted.safeParse(Number.NaN).success).toBe(true);
	expect(emitted.safeParse(Number.POSITIVE_INFINITY).success).toBe(true);
	expect(emitted.safeParse(1).success).toBe(true);
	expect(emitted.safeParse(null).success).toBe(false);
});
