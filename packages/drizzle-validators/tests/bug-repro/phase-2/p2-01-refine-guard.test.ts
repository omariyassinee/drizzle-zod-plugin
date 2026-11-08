import { zodTypeToCode } from "../../../src/zod-serializer";
import { expect, test } from "bun:test";
import { z } from "zod";

// P2-01: `.refine(fn)`/`.custom(fn)` predicates were only guarded on
// string/number/bigint/array/object — every other type silently dropped the
// predicate. The guard now runs before the type dispatch (fail loud on ALL
// types).

test("P2-01: refine on date fails loud instead of silently dropping checks", () => {
	const schema = z.date().refine((d) => d instanceof Date, "must be Date");
	expect(() => zodTypeToCode(schema)).toThrow(
		/Custom.*refine\(\)\/\.custom\(\) predicate|Unserializable.*refine|refine\(\)\/\.custom\(\) predicate/i,
	);
});

test("P2-01: refine on enum fails loud", () => {
	expect(() => zodTypeToCode(z.enum(["a", "b"]).refine((s) => true))).toThrow(
		/refine\(\)\/\.custom\(\) predicate/i,
	);
});

test("P2-01: refine on union fails loud", () => {
	expect(() =>
		zodTypeToCode(z.union([z.string(), z.number()]).refine(() => true)),
	).toThrow(/refine\(\)\/\.custom\(\) predicate/i);
});

test("P2-01: refine on literal fails loud", () => {
	expect(() => zodTypeToCode(z.literal("x").refine(() => true))).toThrow(
		/refine\(\)\/\.custom\(\) predicate/i,
	);
});

test("P2-01: refine on record/set/map/intersection fail loud", () => {
	expect(() =>
		zodTypeToCode(z.record(z.string(), z.number()).refine(() => true)),
	).toThrow(/refine\(\)\/\.custom\(\) predicate/i);
	expect(() => zodTypeToCode(z.set(z.string()).refine(() => true))).toThrow(
		/refine\(\)\/\.custom\(\) predicate/i,
	);
	expect(() =>
		zodTypeToCode(z.map(z.string(), z.number()).refine(() => true)),
	).toThrow(/refine\(\)\/\.custom\(\) predicate/i);
	expect(() =>
		zodTypeToCode(z.intersection(z.string(), z.number()).refine(() => true)),
	).toThrow(/refine\(\)\/\.custom\(\) predicate/i);
});

test("P2-01: refine on tuple fails loud", () => {
	expect(() =>
		zodTypeToCode(z.tuple([z.string()]).refine(() => true)),
	).toThrow(/refine\(\)\/\.custom\(\) predicate/i);
});

test("P2-01: refine through wrapper types (optional/nullable/default) fails loud", () => {
	expect(() =>
		zodTypeToCode(z.string().optional().refine(() => true)),
	).toThrow(/refine\(\)\/\.custom\(\) predicate/i);
	expect(() =>
		zodTypeToCode(z.string().nullable().refine(() => true)),
	).toThrow(/refine\(\)\/\.custom\(\) predicate/i);
});

test("P2-01 regression: refine on string/number/bigint/array/object still fails loud", () => {
	expect(() =>
		zodTypeToCode(z.string().refine((s) => s.length > 2)),
	).toThrow(/refine\(\)\/\.custom\(\) predicate/i);
	expect(() => zodTypeToCode(z.number().refine((n) => n > 0))).toThrow(
		/refine\(\)\/\.custom\(\) predicate/i,
	);
	expect(() => zodTypeToCode(z.bigint().refine(() => true))).toThrow(
		/refine\(\)\/\.custom\(\) predicate/i,
	);
	expect(() =>
		zodTypeToCode(z.array(z.string()).refine(() => true)),
	).toThrow(/refine\(\)\/\.custom\(\) predicate/i);
	expect(() =>
		zodTypeToCode(z.object({ a: z.string() }).refine(() => true)),
	).toThrow(/refine\(\)\/\.custom\(\) predicate/i);
});
