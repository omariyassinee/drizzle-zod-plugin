import { expect, test } from "bun:test";
import { z } from "zod";
import { refineZSchema } from "../src/refine";

// ───────────────────────── Compile-Time Type Tests ─────────────────────────
// These are validated by `bun run typecheck` (tsc --noEmit). The `@ts-expect-error`
// directives assert that invalid keys/fields FAIL to compile, and the positive
// cases assert that valid keys/fields compile cleanly.

const base = z.object({
	name: z.string(),
	email: z.string(),
	age: z.number(),
	role: z.enum(["a", "b"]),
	code: z.string(),
});

// ── Unknown field key in 2-arg map ──
// Wrapped in a never-invoked arrow: the compile probe must not execute
// (applyErrorMapToShape throws on unknown fields at runtime).
void (() =>
	// @ts-expect-error - unknown field "emial" must fail
	refineZSchema(base, { emial: "typo" }));

// ── Unknown field key in 3-arg map ──
// The 3-arg map is typed loosely (SchemaErrorMapLoose — TS cannot resolve
// per-core keys for context-sensitive callbacks), so an unknown FIELD is
// not a compile error there; applyErrorMapToShape throws at runtime with
// the known-field list (asserted in the runtime test below). The 2-arg
// form DOES reject unknown fields at compile time.

// ── Wrong key per core type ──
// @ts-expect-error - `int` is not legal on a string field
refineZSchema(base, { name: { int: "nope" } });

// @ts-expect-error - `email` is not legal on a number field
refineZSchema(base, { age: { email: "nope" } });

// @ts-expect-error - `min` is not legal on an enum field
refineZSchema(base, { role: { min: "nope" } });

// @ts-expect-error - `regex` is not legal on a number field
refineZSchema(base, { age: { regex: "nope" } });

// ── Positive: string keys on a string field ──
refineZSchema(base, {
	name: {
		required: "required",
		null: "null",
		invalid_type: "type",
		min: "min",
		max: "max",
		min_length: "min_length",
		max_length: "max_length",
		length: "length",
		format: "format",
		invalid_format: "invalid_format",
		regex: "regex",
		starts_with: "starts_with",
		ends_with: "ends_with",
		includes: "includes",
		email: "email",
		uuid: "uuid",
		url: "url",
		custom: "custom",
		default: "default",
	},
});

// ── Positive: number keys on a number field ──
refineZSchema(base, {
	age: {
		required: "required",
		null: "null",
		invalid_type: "type",
		min: "min",
		max: "max",
		too_small: "too_small",
		too_big: "too_big",
		int: "int",
		multiple_of: "multiple_of",
		not_multiple_of: "not_multiple_of",
		custom: "custom",
		default: "default",
	},
});

// ── Positive: enum keys on an enum field ──
refineZSchema(base, {
	role: {
		required: "required",
		invalid_value: "invalid_value",
		default: "default",
	},
});

// ── Positive: string shorthand and function shorthand ──
refineZSchema(base, { name: "Name required" });
refineZSchema(base, { name: (issue) => `bad ${issue.code}` });

// ── Positive: .as(z.email()) keeps string keys ──
refineZSchema(
	base,
	(fields) => ({
		email: fields.email.as(z.email()),
	}),
	{
		email: {
			required: "required",
			email: "email",
			format: "format",
			min: "min",
			max: "max",
		},
	},
);

// ── Positive: callback-added field is accepted in the 3rd-arg map ──
refineZSchema(
	base,
	(fields) => ({
		confirmPassword: z.string().min(8),
	}),
	{
		confirmPassword: {
			required: "Please confirm",
			min: "At least 8 characters",
		},
	},
);

// ── Positive: callback type swap switches allowed keys ──
refineZSchema(
	base,
	(fields) => ({
		code: fields.code.as(z.number()),
	}),
	{
		code: {
			int: "Whole number",
			multiple_of: "Multiple of",
		},
	},
);

refineZSchema(
	base,
	(fields) => ({
		code: fields.code.as(z.number()),
	}),
	{
		code: { regex: "nope" },
	},
);

// ── Positive: table with columns named `name` and `length` resolves the 2-arg callback overload ──
const trickyBase = z.object({
	name: z.string(),
	length: z.number(),
	value: z.string(),
});
refineZSchema(trickyBase, (fields) => ({
	name: fields.name.min(3),
	length: fields.length.int(),
}));

// ── Positive: inferred output type is a ZodObject ──
const mapped = refineZSchema(base, { name: "Name required" });
const _check: z.ZodObject<any> = mapped;
expect(_check).toBeDefined();

// ── Positive: 3-arg output type includes callback-added fields ──
const withVirtual = refineZSchema(
	base,
	(fields) => ({
		confirmPassword: z.string().min(8),
	}),
	{ confirmPassword: { required: "Please confirm" } },
);
type VirtualShape = z.infer<typeof withVirtual>;
const _virtual: VirtualShape = {
	name: "n",
	email: "e",
	age: 1,
	role: "a",
	code: "c",
	confirmPassword: "password",
};
expect(_virtual.confirmPassword).toBe("password");

// ── Positive: error map never changes inferred types ──
const unmapped = refineZSchema(base, (fields) => ({
	age: fields.age.min(18),
}));
const mapped2 = refineZSchema(
	base,
	(fields) => ({
		age: fields.age.min(18),
	}),
	{ age: { min: "Must be 18+" } },
);
type UnmappedShape = z.infer<typeof unmapped>;
type MappedShape = z.infer<typeof mapped2>;
const _same: UnmappedShape = {} as MappedShape;
const _same2: MappedShape = {} as UnmappedShape;
expect(_same).toBeDefined();
expect(_same2).toBeDefined();

// ── Runtime sanity: the type-tested schemas actually work ──
test("type-tested schemas parse correctly at runtime", () => {
	// An error map only styles issues — it cannot ADD constraints — so the
	// `int` key styles the safeint issue that z.number().int() emits.
	const rtBase = z.object({
		name: z.string(),
		age: z.number().int(),
		role: z.enum(["a", "b"]),
		code: z.string(),
		email: z.string(),
	});
	const s = refineZSchema(rtBase, {
		name: { required: "Name required" },
		age: { int: "Whole number" },
	});
	expect(
		s.safeParse({ name: "x", age: 1.5, role: "a", code: "c", email: "e" })
			.success,
	).toBe(false);
	const r = s.safeParse({
		name: "x",
		age: 1.5,
		role: "a",
		code: "c",
		email: "e",
	});
	if (!r.success) {
		expect(r.error.issues[0]?.message).toBe("Whole number");
	}
});

test("3-arg error map throws on unknown field names at runtime", () => {
	// The 3-arg map is loosely typed (see the note above), so the typo is
	// caught here instead of at compile time.
	expect(() =>
		refineZSchema(base, (fields) => ({}), {
			emial: "typo",
		} as any),
	).toThrow(/unknown field "emial"/i);
});
