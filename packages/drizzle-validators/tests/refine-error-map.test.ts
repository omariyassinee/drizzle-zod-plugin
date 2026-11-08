import { expect, test } from "bun:test";
import { z } from "zod";
import { refineZSchema } from "../src/refine";

function messageOf(result: z.ZodSafeParseResult<unknown>): string {
	if (result.success) throw new Error("expected failure");
	return result.error.issues[0]?.message ?? "";
}

// ───────────────────────── Map-Only Overload (2-arg) ─────────────────────────

test("string shorthand styles undefined, null, wrong type, and failed checks", () => {
	const base = z.object({
		name: z.string().min(3),
	});
	const refined = refineZSchema(base, {
		name: "Name is invalid",
	});

	expect(messageOf(refined.safeParse({}))).toBe("Name is invalid");
	expect(messageOf(refined.safeParse({ name: null }))).toBe("Name is invalid");
	expect(messageOf(refined.safeParse({ name: 42 }))).toBe("Name is invalid");
	expect(messageOf(refined.safeParse({ name: "ab" }))).toBe("Name is invalid");
});

test("function shorthand receives the raw issue with input and code", () => {
	const base = z.object({
		age: z.number(),
	});
	const refined = refineZSchema(base, {
		age: (issue) => `bad ${issue.code} for ${String(issue.input)}`,
	});

	expect(messageOf(refined.safeParse({ age: "x" }))).toBe(
		"bad invalid_type for x",
	);
});

test("presence chain: required, null, invalid_type, and fallbacks", () => {
	const base = z.object({
		a: z.string(),
		b: z.string(),
		c: z.string(),
	});
	const refined = refineZSchema(base, {
		a: { required: "A required", null: "A null", invalid_type: "A type" },
		b: { null: "B null" }, // required falls back to invalid_type
		c: { invalid_type: "C type" }, // required falls back to invalid_type
	});

	expect(messageOf(refined.safeParse({}))).toBe("A required");
	expect(messageOf(refined.safeParse({ a: null, b: "x", c: "x" }))).toBe(
		"A null",
	);
	expect(messageOf(refined.safeParse({ a: 1, b: "x", c: "x" }))).toBe("A type");

	// b: only `null` key -> missing (undefined) falls through to Zod native
	const bMissing = messageOf(refined.safeParse({ a: "x", c: "x" }));
	expect(bMissing).not.toBe("B null");
	expect(messageOf(refined.safeParse({ a: "x", b: null, c: "x" }))).toBe(
		"B null",
	);
	// b: wrong type -> no invalid_type key -> Zod native
	const bWrongType = messageOf(refined.safeParse({ a: "x", b: 1, c: "x" }));
	expect(bWrongType).not.toBe("B null");

	// c: only `invalid_type` key -> missing, null, and wrong type all use it
	expect(messageOf(refined.safeParse({ a: "x", b: "x" }))).toBe("C type");
	expect(messageOf(refined.safeParse({ a: "x", b: "x", c: null }))).toBe(
		"C type",
	);
	expect(messageOf(refined.safeParse({ a: "x", b: "x", c: 1 }))).toBe("C type");
});

test("string bounds: min_length > min > too_small > default", () => {
	const base = z.object({
		a: z.string().min(3),
		b: z.string().min(3),
		c: z.string().min(3),
		d: z.string().min(3),
	});
	const refined = refineZSchema(base, {
		a: { min_length: "A min_length", min: "A min", too_small: "A too_small" },
		b: { min: "B min", too_small: "B too_small" },
		c: { too_small: "C too_small" },
		d: { default: "D default" },
	});

	expect(
		messageOf(refined.safeParse({ a: "ab", b: "xy", c: "xy", d: "xy" })),
	).toBe("A min_length");
	expect(
		messageOf(refined.safeParse({ a: "abc", b: "x", c: "xy", d: "xy" })),
	).toBe("B min");
	expect(
		messageOf(refined.safeParse({ a: "abc", b: "xyz", c: "x", d: "xy" })),
	).toBe("C too_small");
	expect(
		messageOf(refined.safeParse({ a: "abc", b: "xyz", c: "xyz", d: "x" })),
	).toBe("D default");
});

test("string bounds: max_length > max > too_big > default", () => {
	const base = z.object({
		a: z.string().max(3),
		b: z.string().max(3),
		c: z.string().max(3),
	});
	const refined = refineZSchema(base, {
		a: { max_length: "A max_length", max: "A max", too_big: "A too_big" },
		b: { max: "B max", too_big: "B too_big" },
		c: { too_big: "C too_big" },
	});

	expect(messageOf(refined.safeParse({ a: "abcd", b: "x", c: "x" }))).toBe(
		"A max_length",
	);
	expect(messageOf(refined.safeParse({ a: "abc", b: "abcd", c: "x" }))).toBe(
		"B max",
	);
	expect(messageOf(refined.safeParse({ a: "abc", b: "abc", c: "abcd" }))).toBe(
		"C too_big",
	);
});

test("length on .length(5) for both too-short and too-long strings", () => {
	const base = z.object({
		code: z.string().length(5),
	});
	const refined = refineZSchema(base, {
		code: { length: "Code must be exactly 5 chars" },
	});

	expect(messageOf(refined.safeParse({ code: "ab" }))).toBe(
		"Code must be exactly 5 chars",
	);
	expect(messageOf(refined.safeParse({ code: "abcdef" }))).toBe(
		"Code must be exactly 5 chars",
	);
});

test("format checks: email > format > invalid_format > default on both forms", () => {
	const base = z.object({
		a: z.string().email(),
		b: z.string().email(),
		c: z.string().email(),
		d: z.email(),
		e: z.email(),
		f: z.email(),
	});
	const refined = refineZSchema(base, {
		a: {
			email: "A email",
			format: "A format",
			invalid_format: "A invalid_format",
		},
		b: { format: "B format", invalid_format: "B invalid_format" },
		c: { invalid_format: "C invalid_format" },
		d: { email: "D email", format: "D format" },
		e: { format: "E format" },
		f: { default: "F default" },
	});

	const bad = "not-an-email";
	const good = "user@example.com";
	expect(
		messageOf(
			refined.safeParse({ a: bad, b: "x", c: "x", d: "x", e: "x", f: "x" }),
		),
	).toBe("A email");
	expect(
		messageOf(
			refined.safeParse({ a: good, b: bad, c: "x", d: "x", e: "x", f: "x" }),
		),
	).toBe("B format");
	expect(
		messageOf(
			refined.safeParse({
				a: good,
				b: good,
				c: bad,
				d: "x",
				e: "x",
				f: "x",
			}),
		),
	).toBe("C invalid_format");
	expect(
		messageOf(
			refined.safeParse({
				a: good,
				b: good,
				c: good,
				d: bad,
				e: "x",
				f: "x",
			}),
		),
	).toBe("D email");
	expect(
		messageOf(
			refined.safeParse({
				a: good,
				b: good,
				c: good,
				d: good,
				e: bad,
				f: "x",
			}),
		),
	).toBe("E format");
	expect(
		messageOf(
			refined.safeParse({
				a: good,
				b: good,
				c: good,
				d: good,
				e: good,
				f: bad,
			}),
		),
	).toBe("F default");
});

test("versioned/protocol formats: uuidv4 falls back to uuid, httpUrl falls back to url", () => {
	const base = z.object({
		a: z.uuidv4(),
		b: z.uuidv4(),
		c: z.httpUrl(),
		d: z.httpUrl(),
	});
	const refined = refineZSchema(base, {
		a: { uuidv4: "A uuidv4", uuid: "A uuid", format: "A format" },
		b: { uuid: "B uuid", format: "B format" },
		c: { httpUrl: "C httpUrl", url: "C url", format: "C format" },
		d: { url: "D url", format: "D format" },
	});

	const badUuid = "not-a-uuid";
	const badUrl = "not-a-url";
	const goodUuid = "123e4567-e89b-42d3-a456-426614174000"; // v4
	const goodUrl = "https://example.com";
	expect(
		messageOf(
			refined.safeParse({ a: badUuid, b: goodUuid, c: goodUrl, d: goodUrl }),
		),
	).toBe("A uuidv4");
	expect(
		messageOf(
			refined.safeParse({
				a: goodUuid,
				b: badUuid,
				c: goodUrl,
				d: goodUrl,
			}),
		),
	).toBe("B uuid");
	expect(
		messageOf(
			refined.safeParse({
				a: goodUuid,
				b: goodUuid,
				c: badUrl,
				d: goodUrl,
			}),
		),
	).toBe("C httpUrl");
	expect(
		messageOf(
			refined.safeParse({
				a: goodUuid,
				b: goodUuid,
				c: goodUrl,
				d: badUrl,
			}),
		),
	).toBe("D url");
});

test("pattern checks: regex, starts_with, ends_with, includes", () => {
	const base = z.object({
		a: z.string().regex(/^[a-z]+$/),
		b: z.string().startsWith("pre"),
		c: z.string().endsWith("suf"),
		d: z.string().includes("mid"),
	});
	const refined = refineZSchema(base, {
		a: { regex: "A regex" },
		b: { starts_with: "B starts_with" },
		c: { ends_with: "C ends_with" },
		d: { includes: "D includes" },
	});

	expect(
		messageOf(refined.safeParse({ a: "ABC", b: "pre", c: "suf", d: "mid" })),
	).toBe("A regex");
	expect(
		messageOf(refined.safeParse({ a: "abc", b: "xpre", c: "suf", d: "mid" })),
	).toBe("B starts_with");
	expect(
		messageOf(refined.safeParse({ a: "abc", b: "pre", c: "sufx", d: "mid" })),
	).toBe("C ends_with");
	expect(
		messageOf(refined.safeParse({ a: "abc", b: "pre", c: "suf", d: "xyz" })),
	).toBe("D includes");
});

test("int on .int() and z.int() with a decimal; never invalid_type", () => {
	const base = z.object({
		a: z.number().int(),
		b: z.int(),
		c: z.number().int(),
	});
	const refined = refineZSchema(base, {
		a: { int: "A int", invalid_type: "A invalid_type" },
		b: { int: "B int", invalid_type: "B invalid_type" },
		c: { invalid_type: "C invalid_type" }, // no int key -> native message
	});

	expect(messageOf(refined.safeParse({ a: 1.5, b: 1, c: 1 }))).toBe("A int");
	expect(messageOf(refined.safeParse({ a: 1, b: 1.5, c: 1 }))).toBe("B int");
	// c has no `int` key: the decimal must NOT use invalid_type
	const cMsg = messageOf(refined.safeParse({ a: 1, b: 1, c: 1.5 }));
	expect(cMsg).not.toBe("C invalid_type");
});

test("z.int() range overflow uses min/max, not int", () => {
	const base = z.object({
		a: z.int().gte(-2147483648).lte(2147483647),
	});
	const refined = refineZSchema(base, {
		a: { int: "A int", min: "A min", max: "A max" },
	});

	expect(messageOf(refined.safeParse({ a: 3e9 }))).toBe("A max");
	expect(messageOf(refined.safeParse({ a: -3e9 }))).toBe("A min");
});

test("multiple_of and not_multiple_of on .multipleOf(5)", () => {
	const base = z.object({
		a: z.number().multipleOf(5),
		b: z.number().multipleOf(5),
	});
	const refined = refineZSchema(base, {
		a: { multiple_of: "A multiple_of", not_multiple_of: "A not_multiple_of" },
		b: { not_multiple_of: "B not_multiple_of" },
	});

	expect(messageOf(refined.safeParse({ a: 7, b: 5 }))).toBe("A multiple_of");
	expect(messageOf(refined.safeParse({ a: 5, b: 7 }))).toBe(
		"B not_multiple_of",
	);
});

test("invalid_value on z.enum and z.literal", () => {
	const base = z.object({
		role: z.enum(["a", "b"]),
		kind: z.literal("x"),
	});
	const refined = refineZSchema(base, {
		role: { invalid_value: "Role invalid" },
		kind: { invalid_value: "Kind invalid" },
	});

	expect(messageOf(refined.safeParse({ role: "c", kind: "x" }))).toBe(
		"Role invalid",
	);
	expect(messageOf(refined.safeParse({ role: "a", kind: "y" }))).toBe(
		"Kind invalid",
	);
});

test("custom on .refine() without an inline message", () => {
	const base = z.object({
		name: z.string().refine((v) => v !== "bad"),
	});
	const refined = refineZSchema(base, {
		name: { custom: "Name is not allowed" },
	});

	expect(messageOf(refined.safeParse({ name: "bad" }))).toBe(
		"Name is not allowed",
	);
});

// ───────────────────────── Callback + Map Overload (3-arg) ─────────────────────────

test("callback adds a virtual field and the map styles it", () => {
	const base = z.object({
		email: z.string(),
	});
	const refined = refineZSchema(
		base,
		(fields) => ({
			confirmPassword: z.string().min(8),
		}),
		{
			confirmPassword: {
				required: "Please confirm your password",
				min: "Password needs 8+ characters",
			},
		},
	);

	expect(messageOf(refined.safeParse({ email: "a@b.c" }))).toBe(
		"Please confirm your password",
	);
	expect(
		messageOf(refined.safeParse({ email: "a@b.c", confirmPassword: "short" })),
	).toBe("Password needs 8+ characters");
});

test("callback swaps type with .as(z.email()) and map styles required/email/max", () => {
	const base = z.object({
		email: z.string().max(120),
	});
	const refined = refineZSchema(
		base,
		(fields) => ({
			email: fields.email.as(z.email()),
		}),
		{
			email: {
				required: "Email is required",
				email: "Enter a valid work email",
				max: "Email too long",
			},
		},
	);

	expect(messageOf(refined.safeParse({}))).toBe("Email is required");
	expect(messageOf(refined.safeParse({ email: "not-an-email" }))).toBe(
		"Enter a valid work email",
	);
	expect(
		messageOf(refined.safeParse({ email: `${"a".repeat(121)}@example.com` })),
	).toBe("Email too long");
});

test("inline check error beats map.min while map.required still styles undefined", () => {
	const base = z.object({
		age: z.number(),
	});
	const refined = refineZSchema(
		base,
		(fields) => ({
			age: fields.age.min(18, { error: "Inline 18+" }),
		}),
		{
			age: {
				required: "Age is required",
				min: "Map min",
			},
		},
	);

	expect(messageOf(refined.safeParse({}))).toBe("Age is required");
	expect(messageOf(refined.safeParse({ age: 15 }))).toBe("Inline 18+");
});

test(".setError() beats all keys in errorMap for that field", () => {
	const base = z.object({
		email: z.string(),
	});
	const refined = refineZSchema(
		base,
		(fields) => ({
			email: fields.email.setError("Field override"),
		}),
		{
			email: {
				required: "Map required",
				email: "Map email",
			},
		},
	);

	expect(messageOf(refined.safeParse({}))).toBe("Field override");
	expect(messageOf(refined.safeParse({ email: 42 }))).toBe("Field override");
});

// ───────────────────────── Multi-Stage Cascade & Idempotence ─────────────────────────

test("chained refineZSchema cascades per key without erasing untouched keys", () => {
	const base = z.object({
		email: z.string().email(),
	});
	const step1 = refineZSchema(base, {
		email: { required: "R1", email: "E1" },
	});
	const step2 = refineZSchema(step1, {
		email: { required: "R2" },
	});

	expect(messageOf(step2.safeParse({}))).toBe("R2");
	expect(messageOf(step2.safeParse({ email: "not-an-email" }))).toBe("E1");

	// step1 remains unmutated
	expect(messageOf(step1.safeParse({}))).toBe("R1");
	expect(messageOf(step1.safeParse({ email: "not-an-email" }))).toBe("E1");
});

test("applying the same map twice is idempotent", () => {
	const base = z.object({
		email: z.string().email(),
	});
	const map = { email: { required: "R", email: "E" } } as const;
	const once = refineZSchema(base, map);
	const twice = refineZSchema(once, map);

	expect(messageOf(twice.safeParse({}))).toBe("R");
	expect(messageOf(twice.safeParse({ email: "not-an-email" }))).toBe("E");
});

// ───────────────────────── C1 Non-Contamination & Wrappers ─────────────────────────

test("two mapped schemas from the same base never leak into each other or the base", () => {
	const base = z.object({
		email: z.string().email(),
	});
	const a = refineZSchema(base, { email: { required: "A required" } });
	const b = refineZSchema(base, { email: { required: "B required" } });

	expect(messageOf(a.safeParse({}))).toBe("A required");
	expect(messageOf(b.safeParse({}))).toBe("B required");

	// base is untouched: native message
	const baseMsg = messageOf(base.safeParse({}));
	expect(baseMsg).not.toBe("A required");
	expect(baseMsg).not.toBe("B required");
});

test("wrappers behave identically before and after mapping", () => {
	const base = z.object({
		opt: z.string().optional(),
		exact: z.string().exactOptional(),
		null: z.string().nullable(),
		def: z.string().default("d"),
		lazyDef: z.string().default(() => "lazy"),
		catch: z.string().catch("c"),
		readonly: z.string().readonly(),
	});
	const refined = refineZSchema(base, {
		opt: { required: "opt required" },
		exact: { required: "exact required" },
		null: { required: "null required" },
		def: { required: "def required" },
		lazyDef: { required: "lazyDef required" },
		catch: { required: "catch required" },
		readonly: { required: "readonly required" },
	});

	// Optional/nullable/default/catch fields accept their empty forms
	// (exactOptional requires the key to be ABSENT, not present-as-undefined)
	expect(
		refined.safeParse({
			opt: undefined,
			null: null,
			def: undefined,
			lazyDef: undefined,
			catch: undefined,
			readonly: "x",
		}).success,
	).toBe(true);
	expect(
		refined.safeParse({
			opt: undefined,
			exact: undefined,
			null: null,
			def: undefined,
			lazyDef: undefined,
			catch: undefined,
			readonly: "x",
		}).success,
	).toBe(false);

	// Lazy default getter still works
	const parsed = refined.safeParse({
		opt: undefined,
		null: null,
		def: undefined,
		lazyDef: undefined,
		catch: undefined,
		readonly: "x",
	});
	expect(parsed.success).toBe(true);
	if (parsed.success) {
		expect(parsed.data.lazyDef).toBe("lazy");
	}
});

test("array field map styles the container, not the elements", () => {
	const base = z.object({
		tags: z.array(z.string()).min(1),
	});
	const refined = refineZSchema(base, {
		tags: { min: "At least one tag", required: "Tags required" },
	});

	expect(messageOf(refined.safeParse({}))).toBe("Tags required");
	expect(messageOf(refined.safeParse({ tags: [] }))).toBe("At least one tag");

	// Element-level failure keeps its own message, not the field's
	const elementMsg = messageOf(refined.safeParse({ tags: [123 as any] }));
	expect(elementMsg).not.toBe("At least one tag");
	expect(elementMsg).not.toBe("Tags required");
});

// ───────────────────────── Fail-Loud Validation ─────────────────────────

test("unknown field name in errorMap throws DrizzleValidatorsError", () => {
	const base = z.object({ email: z.string() });
	expect(() => refineZSchema(base, { emial: "typo" } as any)).toThrow(
		/unknown field "emial"/,
	);
});

test("unknown key in field map throws DrizzleValidatorsError", () => {
	const base = z.object({ email: z.string() });
	expect(() =>
		refineZSchema(base, { email: { bogus_key: "x" } } as any),
	).toThrow(/Unknown error map key "bogus_key"/);
});

test("reversed arguments throw DrizzleValidatorsError", () => {
	const base = z.object({ email: z.string() });
	expect(
		() =>
			// Arguments deliberately reversed — beyond the type signature, so
			// the call goes through `as any` and asserts the runtime guard.
			(refineZSchema as any)(
				base,
				{ email: { required: "x" } },
				(fields: any) => ({}),
			),
	).toThrow(/callback must come before the error map/);
});

test("non-object errorMap throws DrizzleValidatorsError", () => {
	const base = z.object({ email: z.string() });
	expect(() => refineZSchema(base, "nope" as any)).toThrow(
		/refinement callback function or an error map/,
	);
});
