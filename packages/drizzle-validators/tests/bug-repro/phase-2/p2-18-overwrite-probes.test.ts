import { zodTypeToCode } from "../../../src/zod-serializer";
import { evalDefault, expect, test } from "./_helpers";
import { z } from "zod";

// P2-18: any overwrite/transform in the schema was silently replaced with
// `.trim()` AT CODEGEN — the emitted transform blindly hardcoded a marker.
// The serializer now emits a builtin .chain() only after PROBING that the
// transform behaves exactly like the builtin on sample inputs; anything
// else fails loud instead of silently corrupting expectations.

test("P2-18: builtin-like overwrite (trim) round-trips exactly", async () => {
	const schema = z.string().overwrite((v) => v.trim());
	const code = zodTypeToCode(schema);
	expect(code).toBe("z.string().trim()");
	const emitted = await evalDefault(code);
	expect(emitted.safeParse("  a  ").data?.length).toBe(1);
});

test("P2-18: builtin-like overwrite (toLowerCase) round-trips exactly", async () => {
	const code = zodTypeToCode(z.string().overwrite((v) => v.toLowerCase()));
	expect(code).toBe("z.string().toLowerCase()");
	const emitted = await evalDefault(code);
	expect(emitted.safeParse("AB").data).toBe("ab");
});

test("P2-18: builtin-like overwrite (toUpperCase) round-trips exactly", async () => {
	const code = zodTypeToCode(z.string().overwrite((v) => v.toUpperCase()));
	expect(code).toBe("z.string().toUpperCase()");
	const emitted = await evalDefault(code);
	expect(emitted.safeParse("ab").data).toBe("AB");
});

test("P2-18: non-builtin overwrite fails loud instead of pretending to be .trim()", () => {
	const schema = z.string().overwrite((v) => `${v}!`);
	// the original bug emitted `z.string().trim()` for ANY overwrite check —
	// dropping the appended "!" entirely — the fix must not do that
	expect(() => zodTypeToCode(schema as never)).toThrow(
		/Cannot serialize|overwrite|transform/i,
	);
});

test("P2-18 regression: real .trim() (no overwrite check) is unchanged", async () => {
	const code = zodTypeToCode(z.string().trim());
	expect(code).toBe("z.string().trim()");
});
