import { expect, test } from "./_helpers";
import { z } from "zod";
import { refineZSchema } from "../../../src/refine";

// P2-04: `.default(fn)` is zod 4's LAZY default (recomputed per parse).
// refineZSchema's unwrap/apply pipeline read `def.defaultValue` — which zod
// exposes as a getter that RUNS THE FN — freezing one snapshot value into
// every refined schema forever. The pipeline now carries the def by
// reference and re-invokes the getter on every read (i.e. every parse).

test("P2-04: lazy default stays lazy across refineZSchema .as() type change", () => {
	let calls = 0;
	const base = z.object({
		s: z
			.string()
			.default(() => {
				calls++;
				return `call#${calls}`;
			}),
	});
	const refined = refineZSchema(base, (f) => ({ s: f.s.as(z.string()) }));

	// each parse must evaluate the default FRESH, not snapshot it
	const parsed1 = refined.safeParse({}) as { data?: any };
	const parsed2 = refined.safeParse({}) as { data?: any };
	expect(parsed1.data?.s).toBe("call#1");
	expect(parsed2.data?.s).toBe("call#2");
	// both parses shared the closure counters: 2 calls total
	expect(calls).toBe(2);
});

test("P2-04: lazy default stays lazy when only unwrapping+re-applying", () => {
	let calls = 0;
	const base = z.object({
		s: z.string().default(() => {
			calls++;
			return `n${calls}`;
		}),
	});
	const refined = refineZSchema(base, (f) => ({ s: f.s.as(z.string()) }));
	const r1 = (refined.safeParse({}) as any).data;
	const r2 = (refined.safeParse({}) as any).data;
	expect(r1.s).toBe("n1");
	expect(r2.s).toBe("n2");
});

test("P2-04 regression: value defaults stay static", () => {
	const base = z.object({ s: z.string().default("static") });
	const refined = refineZSchema(base, (f) => ({ s: f.s.as(z.string()) }));
	expect(refined.safeParse({}).data?.s).toBe("static");
	expect(refined.safeParse({}).data?.s).toBe("static");
});

test("P2-04 regression: refined schema still validates its core type", () => {
	const base = z.object({ s: z.string().default("x") });
	const refined = refineZSchema(base, (f) => ({ s: f.s.as(z.string()) }));
	expect(refined.safeParse({ s: 3 }).success).toBe(false);
	expect(refined.safeParse({ s: "ok" }).success).toBe(true);
});
