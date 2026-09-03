/**
 * H1 — Serializer silently drops string transform checks (trim, startsWith,
 *       endsWith, includes, toLowerCase, normalize, refine).
 * H2 — Formats outside KNOWN_FORMATS are silently dropped (nanoid, jwt,
 *       base64, e164, datetime, guid, httpUrl, ...).
 * H3 — z.custom(fn) → z.custom() (accepts anything).
 * H4 — Multi-value z.literal(["a","b"]) → z.literal("a").
 * H5 — z.strictObject / z.looseObject → z.object (strictness lost).
 * M1 — serializeDefaultValue mangles NaN/Infinity/undefined.
 * M6 — KNOWN_FORMATS (9) diverges from advertised StringFormat (22).
 *
 * See BUG-REPORT.md, findings H1–H5, M1, M6.
 */
import { expect, test } from "bun:test";
import { z } from "zod";
import { zodTypeToCode } from "../../src/zod-serializer";
import { KNOWN_FORMATS } from "../../src/constants";
import { roundtripEval } from "./_helpers";

test("H1: z.string().trim() round-trips with trim preserved", async () => {
	const code = zodTypeToCode(z.string().trim());
	// BUG: emits "z.string()" — trim silently dropped.
	expect(code).toContain(".trim()");
	const rt = await roundtripEval(code);
	expect(rt.safeParse("  hi  ").data).toBe("hi");
});

test("H1: z.string().startsWith() round-trips", async () => {
	const code = zodTypeToCode(z.string().startsWith("abc"));
	// BUG: emits "z.string()" — check silently dropped.
	expect(code).toContain(".startsWith(");
	expect((await roundtripEval(code)).safeParse("xyz").success).toBe(false);
});

test("H1: z.string().endsWith() round-trips", async () => {
	const code = zodTypeToCode(z.string().endsWith(".ts"));
	expect(code).toContain(".endsWith(");
	expect((await roundtripEval(code)).safeParse("file.js").success).toBe(false);
});

test("H1: z.string().includes() round-trips", async () => {
	const code = zodTypeToCode(z.string().includes("drizzle"));
	expect(code).toContain(".includes(");
	expect((await roundtripEval(code)).safeParse("plain").success).toBe(false);
});

test("H1: z.string().toLowerCase() round-trips", async () => {
	const code = zodTypeToCode(z.string().toLowerCase());
	// BUG: emits "z.string()" — transform silently dropped.
	expect(code).toContain(".toLowerCase()");
	const rt = await roundtripEval(code);
	expect(rt.safeParse("ABC").data).toBe("abc");
});

test("H2: every format in the advertised StringFormat union survives serialization", async () => {
	// The 22 formats advertised by refine.ts's StringFormat type.
	const advertised = [
		"email",
		"url",
		"httpUrl",
		"uuid",
		"uuidv4",
		"uuidv6",
		"uuidv7",
		"guid",
		"cuid",
		"cuid2",
		"ulid",
		"emoji",
		"nanoid",
		"jwt",
		"ipv4",
		"ipv6",
		"cidrv4",
		"cidrv6",
		"base64",
		"base64url",
		"xid",
		"ksuid",
		"e164",
	] as const;

	for (const fmt of advertised) {
		const schema = (z as any)[fmt]();
		const code = zodTypeToCode(schema);
		// BUG: formats outside KNOWN_FORMATS emit bare "z.string()".
		expect(code, `format "${fmt}" was dropped`).toMatch(
			new RegExp(`z\\.${fmt}\\(`),
		);
	}
});

test("H2: KNOWN_FORMATS matches the advertised StringFormat union", () => {
	// BUG: 9 vs 22 divergence — the two lists must not drift.
	const advertised = [
		"email",
		"url",
		"httpUrl",
		"uuid",
		"uuidv4",
		"uuidv6",
		"uuidv7",
		"guid",
		"cuid",
		"cuid2",
		"ulid",
		"emoji",
		"nanoid",
		"jwt",
		"ipv4",
		"ipv6",
		"cidrv4",
		"cidrv6",
		"base64",
		"base64url",
		"xid",
		"ksuid",
		"e164",
	];
	for (const fmt of advertised) {
		expect(KNOWN_FORMATS.has(fmt), `KNOWN_FORMATS is missing "${fmt}"`).toBe(
			true,
		);
	}
});

test("H3: z.custom(fn) does not silently become accepts-anything", () => {
	// BUG: emits "z.custom()" which accepts EVERYTHING.
	// Fixed behavior: fail loud at generation time — a runtime predicate
	// function cannot round-trip to static code.
	// NOTE: must be wrapped in expect().toThrow() — a bare call would crash
	// the test synchronously before any catch block runs.
	expect(() => {
		zodTypeToCode(z.custom<string>((v) => typeof v === "string"));
	}).toThrow(/Cannot serialize z\.custom/);
});

test("H4: multi-value z.literal round-trips all values", async () => {
	const code = zodTypeToCode(z.literal(["a", "b"]));
	// BUG: emits z.literal("a") — "b" silently rejected.
	expect(code).toContain('"a"');
	expect(code).toContain('"b"');
	const rt = await roundtripEval(code);
	expect(rt.safeParse("b").success).toBe(true);
});

test("H5: z.strictObject round-trips strictness (rejects unknown keys)", async () => {
	const code = zodTypeToCode(z.strictObject({ a: z.string() }));
	// BUG: emits plain z.object — unknown keys now stripped, not rejected.
	expect(code).toContain("strictObject");
	const rt = await roundtripEval(code);
	expect(rt.safeParse({ a: "x", evil: 1 }).success).toBe(false);
});

test("H5: z.looseObject round-trips catchall behavior", async () => {
	const code = zodTypeToCode(z.looseObject({ a: z.string() }));
	expect(code).toContain("looseObject");
	const rt = await roundtripEval(code);
	// looseObject keeps unknown keys instead of stripping them.
	expect(rt.safeParse({ a: "x", extra: 1 }).data).toEqual({ a: "x", extra: 1 });
});

test("M1: serializeDefaultValue handles NaN/Infinity without emitting null", () => {
	// NaN/Infinity JSON.stringify to null — must not silently become null.
	const code = zodTypeToCode(z.number().default(Number.NaN));
	expect(code).not.toContain(".default(null)");
});

test("M1: serializeDefaultValue handles undefined default", () => {
	// Build via internals so TS accepts it: a default whose value is undefined
	// (JSON.stringify(undefined) === undefined → template emits literal
	// "undefined" text, producing z.string().default(undefined)).
	const schema = z
		.string()
		.default("x")
		.clone({
			...(z.string().default("x") as any)._zod.def,
			defaultValue: undefined,
		} as any);
	const code = zodTypeToCode(schema);
	expect(code).not.toMatch(/\.default\(undefined\)/);
});

test("NEW-1: numeric range checks (int/gte/lte/multipleOf) survive serialization", async () => {
	// BUG: z.int().gte(-2147483648).lte(2147483647) emitted "z.number()" —
	// silently dropping int-ness and range bounds.
	const code = zodTypeToCode(z.int().gte(-2147483648).lte(2147483647));
	expect(code).toContain(".int()");
	expect(code).toContain(".gte(-2147483648)");
	expect(code).toContain(".lte(2147483647)");
	const rt = await roundtripEval(code);
	expect(rt.safeParse(42).success).toBe(true);
	expect(rt.safeParse(3.7).success).toBe(false); // int-ness enforced
	expect(rt.safeParse(2147483648).success).toBe(false); // upper bound enforced
});

test("NEW-1: bigint range checks serialize with n-suffixed literals", async () => {
	const code = zodTypeToCode(
		z.bigint().gte(-9223372036854775808n).lte(9223372036854775807n),
	);
	expect(code).toContain("z.bigint()");
	expect(code).toContain(".gte(-9223372036854775808n)");
	expect(code).toContain(".lte(9223372036854775807n)");
	const rt = await roundtripEval(code);
	expect(rt.safeParse(1n).success).toBe(true);
	expect(rt.safeParse(9223372036854775808n).success).toBe(false);
});
