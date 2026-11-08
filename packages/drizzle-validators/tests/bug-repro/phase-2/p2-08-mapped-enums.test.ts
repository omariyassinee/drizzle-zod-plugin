import { zodTypeToCode } from "../../../src/zod-serializer";
import { evalDefault, expect, test } from "./_helpers";
import { z } from "zod";

// P2-08: numeric/mapped enums serialized the KEYS of def.entries — turning
// z.enum({ONE:1,TWO:2}) into z.enum(["ONE","TWO"]): values became rejected,
// string keys became accepted (a type swap). Round-trip the values now.

test("P2-08: mapped numeric enum emits the object form and validates values", async () => {
	const schema = z.enum({ ONE: 1, TWO: 2 });
	const code = zodTypeToCode(schema);
	expect(code).toBe('z.enum({ "ONE": 1, "TWO": 2 })');
	const emitted = await evalDefault(code);
	// values are accepted, keys are NOT (no type swap)
	expect(emitted.safeParse(1).success).toBe(true);
	expect(emitted.safeParse(2).success).toBe(true);
	expect(emitted.safeParse("ONE").success).toBe(false);
	expect(emitted.safeParse(3).success).toBe(false);
});

test("P2-08 regression: plain string enums still emit the array form", async () => {
	const code = zodTypeToCode(z.enum(["A", "B"]));
	expect(code).toBe('z.enum(["A","B"])');
	const emitted = await evalDefault(code);
	expect(emitted.safeParse("A").success).toBe(true);
	expect(emitted.safeParse("C").success).toBe(false);
});

test("P2-08: mapped string enum with divergent keys keeps key↔value pairs", async () => {
	const schema = z.enum({ LEFT: "L", RIGHT: "R" });
	const code = zodTypeToCode(schema);
	expect(code).toBe('z.enum({ "LEFT": "L", "RIGHT": "R" })');
	const emitted = await evalDefault(code);
	expect(emitted.safeParse("L").success).toBe(true);
	expect(emitted.safeParse("LEFT").success).toBe(false);
});
