import { describe, expect, test } from "bun:test";
import { z } from "zod";
import * as v from "valibot";
import { zodTypeToCode } from "../../src/zod-serializer";
import { valibotAdapter } from "../../src/adapters/valibot";

describe("Chain 2: Serializer Heuristic Reverse-Engineering Stress Suite", () => {
	test("H-01: lazy default with coarse timer or runtime env lookup must NOT freeze at build time", () => {
		// A lazy getter that returns the same value within a 3ms window
		// (e.g., second-precision timestamp or runtime environment lookup)
		const secondTimestampSchema = z
			.number()
			.default(() => Math.floor(Date.now() / 10_000));

		// BUG TARGET: Because `Math.floor(Date.now() / 10_000)` rarely changes inside a 3ms spin loop,
		// the current serializer fails to detect that `defaultValue` is a getter and freezes the number!
		expect(() => zodTypeToCode(secondTimestampSchema)).toThrow(
			/Cannot serialize a lazy \.default/,
		);
	});

	test("H-03: 50 static .default('x') fields should serialize in < 25ms (no 3ms spin-loop per field)", () => {
		const shape: Record<string, z.ZodTypeAny> = {};
		for (let i = 0; i < 50; i++) {
			shape[`col_${i}`] = z.string().default("static_val");
		}
		const bigObject = z.object(shape);

		const start = performance.now();
		const code = zodTypeToCode(bigObject);
		const elapsedMs = performance.now() - start;

		expect(code).toContain('.default("static_val")');
		// BUG TARGET: Currently takes > 150ms (50 * 3ms busy-wait) because the spin loop
		// executes even on static defaults!
		expect(elapsedMs).toBeLessThan(25);
	});

	test("H-04: custom .overwrite() that happens to trim short strings but truncates long ones must NOT silently become .trim()", () => {
		const customTruncateAndTrim = z
			.string()
			.overwrite((val: string) => (val.length > 20 ? val.slice(0, 20).trim() : val.trim()));

		// BUG TARGET: All 3 probes in CANDIDATES for .trim() are < 20 chars, so the probe
		// currently misidentifies this custom transform as plain `.trim()`!
		expect(() => zodTypeToCode(customTruncateAndTrim)).toThrow(
			/Cannot serialize a custom string transform/,
		);
	});

	test("H-06: z.custom((v) => typeof v === 'object' && v !== null) must NOT be misclassified as z.instanceof(Buffer)", () => {
		const anyObjectSchema = z.custom<object>(
			(v) => typeof v === "object" && v !== null,
		);

		// BUG TARGET: In probeInstanceofClass, `Buffer.from("x")` is an object (returns true)
		// and `"not-an-instance"` is a string (returns false).
		// So `probeInstanceofClass` returns "Buffer" and throws the P2-02 Buffer error (or emits z.instanceof(Buffer) with bufferAs: "keep")!
		expect(() =>
			zodTypeToCode(anyObjectSchema, undefined, 0, { bufferAs: "keep" }),
		).toThrow(/Cannot serialize z\.custom\(\) with a runtime predicate/);
	});

	test("H-06b: z.custom((v) => ArrayBuffer.isView(v)) (e.g. Uint8Array) must NOT be misclassified as Buffer", () => {
		const uint8Schema = z.custom<ArrayBufferView>((v) =>
			ArrayBuffer.isView(v),
		);

		// Buffer is a Uint8Array subclass, so fn(Buffer.from("x")) === true!
		// With bufferAs: "keep", it would falsely emit `z.instanceof(Buffer)` which rejects plain Uint8Arrays!
		expect(() =>
			zodTypeToCode(uint8Schema, undefined, 0, { bufferAs: "keep" }),
		).toThrow(/Cannot serialize z\.custom\(\)/);
	});

	test("H-07: Valibot v.custom((v) => v instanceof Uint8Array) must NOT be misclassified as v.instance(Buffer)", () => {
		const uint8Valibot = v.custom<Uint8Array>(
			(input) => input instanceof Uint8Array,
		);

		// Buffer extends Uint8Array, so `Buffer.alloc(0) instanceof Uint8Array` is true!
		// `isBufferCheck` in src/adapters/valibot.ts falsely returns true and emits `v.instance(Buffer)`!
		expect(() =>
			valibotAdapter.emit(uint8Valibot, { bufferAs: "keep", depth: 0 }),
		).toThrow(/Unserializable valibot schema node/);
	});
});
