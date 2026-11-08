import { zodTypeToCode } from "../../../src/zod-serializer";
import { evalDefault, expect, test } from "./_helpers";
import { z } from "zod";

// P2-06: tuple rest was dropped — extra items were rejected by the emitted
// schema while the original accepted them.

test("P2-06: tuple with rest round-trips", async () => {
	const schema = z.tuple([z.string()], z.number());
	const code = zodTypeToCode(schema);
	expect(code).toBe("z.tuple([z.string()], z.number())");
	const emitted = await evalDefault(code);
	expect(emitted.safeParse(["a", 1]).success).toBe(true);
	expect(emitted.safeParse(["a", 2, 3]).success).toBe(true);
	// rest type constraint still applies
	expect(emitted.safeParse(["a", "b"]).success).toBe(false);
	expect(emitted.safeParse([1]).success).toBe(false);
});

test("P2-06 regression: tuple without rest is unchanged", async () => {
	const code = zodTypeToCode(z.tuple([z.string(), z.number()]));
	expect(code).toBe("z.tuple([z.string(), z.number()])");
	const emitted = await evalDefault(code);
	expect(emitted.safeParse(["a", 1]).success).toBe(true);
	expect(emitted.safeParse(["a", 1, 2]).success).toBe(false);
});
