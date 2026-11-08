import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { refineVSchema } from "../src/valibot-refine";

// refineVSchema — the valibot refinement engine. Same API contract as
// refineZSchema, valibot-native implementation (real builders, no
// hand-rolled pipe runners). Structural claims verified against
// valibot@1.5.0: v.pipe re-anchors to the unpiped base, v.fallback
// attaches a property (not a wrapper), v.readonly is a pipe transformation.

const userSchema = v.object({
	email: v.optional(v.pipe(v.string(), v.maxLength(8)), "dflt"),
	age: v.nullish(v.pipe(v.number(), v.minValue(18))),
	nickname: v.optional(v.pipe(v.string(), v.maxLength(32))),
	status: v.picklist(["active", "banned"]),
});

describe("wrapper preservation", () => {
	test(".as() keeps optional wrapper + default", () => {
		// NOTE: valibot validates the default against the refined core (it
		// applies the default and runs the pipe), so the default must be a
		// valid value for the NEW schema — unlike zod, where defaults
		// short-circuit validation entirely.
		const base = v.object({
			email: v.optional(v.pipe(v.string(), v.maxLength(20)), "ada@clinic.io"),
		});
		const refined = refineVSchema(base, (f) => ({
			email: f.email.as(v.pipe(v.string(), v.email())),
		}));
		const r = v.safeParse(refined, {});
		expect(r.success).toBe(true);
		expect((r.output as any).email).toBe("ada@clinic.io");
	});

	test(".as() keeps nullish wrapper (null passes, undefined passes)", () => {
		const refined = refineVSchema(userSchema, (f) => ({
			age: f.age.as(v.pipe(v.number(), v.integer())),
		}));
		expect(v.safeParse(refined, { status: "active", nickname: "n", age: null }).success).toBe(true);
		expect(v.safeParse(refined, { status: "active", nickname: "n" }).success).toBe(true);
		// integer action transferred? minValue(18) from source must transfer
		expect(v.safeParse(refined, { status: "active", nickname: "n", age: 12 }).success).toBe(false);
		expect(v.safeParse(refined, { status: "active", nickname: "n", age: 20.5 }).success).toBe(false);
	});

	test("fallback wrapper is preserved across .as()", () => {
		const base = v.object({
			code: v.fallback(v.pipe(v.string(), v.maxLength(4)), "XXXX"),
		});
		const refined = refineVSchema(base, (f) => ({
			code: f.code.as(v.pipe(v.string(), v.minLength(2))),
		}));
		expect(v.safeParse(refined, { code: 12345 }).success).toBe(true);
		expect((v.safeParse(refined, { code: 12345 }).output as any).code).toBe("XXXX");
	});

	test("base schema is never mutated (C1 invariant)", () => {
		const base = v.object({ name: v.pipe(v.string(), v.maxLength(8)) });
		const corePipe = (base.entries as any).name.pipe;
		const snapshot = JSON.stringify(corePipe.map((i: any) => i.type));
		refineVSchema(base, (f) => ({
			name: f.name.pipe(v.minLength(2)),
		}));
		expect((base.entries as any).name.pipe).toBe(corePipe);
		expect(JSON.stringify((base.entries as any).name.pipe.map((i: any) => i.type))).toBe(snapshot);
	});
});

describe("action transfer & conflict resolution", () => {
	test("transferred maxLength(8) coexists with a satisfiable target", () => {
		const refined = refineVSchema(userSchema, (f) => ({
			email: f.email.as(v.pipe(v.string(), v.email())),
		}));
		// 11 chars: valid email form but violates varchar(8)
		expect(v.safeParse(refined, { status: "active", nickname: "n", email: "a@b.co" }).success).toBe(true);
		expect(v.safeParse(refined, { status: "active", nickname: "n", email: "abcdefghijk@b.co" }).success).toBe(false);
	});

	test("source uuid is REPLACED by a target email (primary-format dedup)", () => {
		const base = v.object({ id: v.pipe(v.string(), v.uuid()) });
		const refined = refineVSchema(base, (f) => ({
			id: f.id.as(v.pipe(v.string(), v.email())),
		}));
		// a valid email that is NOT a uuid passes both the replacement and
		// the absence of the transferred uuid
		expect(v.safeParse(refined, { id: "a@b.co" }).success).toBe(true);
		expect(v.safeParse(refined, { id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" }).success).toBe(false);
	});

	test("unsatisfiable bound is dropped: varchar(8) + as(minLength(10))", () => {
		const base = v.object({ code: v.pipe(v.string(), v.maxLength(8)) });
		const refined = refineVSchema(base, (f) => ({
			code: f.code.as(v.pipe(v.string(), v.minLength(10))),
		}));
		// max(8) dropped — 11 chars pass; min(10) still enforced
		expect(v.safeParse(refined, { code: "L1234567890" }).success).toBe(true);
		expect(v.safeParse(refined, { code: "abc" }).success).toBe(false);
	});

	test("satisfiable bound survives: varchar(8) + as(minLength(3))", () => {
		const base = v.object({ code: v.pipe(v.string(), v.maxLength(8)) });
		const refined = refineVSchema(base, (f) => ({
			code: f.code.as(v.pipe(v.string(), v.minLength(3))),
		}));
		expect(v.safeParse(refined, { code: "abcde" }).success).toBe(true);
		expect(v.safeParse(refined, { code: "ab" }).success).toBe(false);
		expect(v.safeParse(refined, { code: "abcdefghij" }).success).toBe(false);
	});

	test("transferChecks: false skips inherited actions", () => {
		const refined = refineVSchema(userSchema, (f) => ({
			email: f.email.as(v.pipe(v.string(), v.email()), { transferChecks: false }),
		}));
		expect(v.safeParse(refined, { status: "active", nickname: "n", email: "abcdefghijk@b.co" }).success).toBe(true);
	});
});

describe("three refinement styles", () => {
	test("style 1: .as(v.pipe(v.string(), ...))", () => {
		const refined = refineVSchema(userSchema, (f) => ({
			nickname: f.nickname.as(v.pipe(v.string(), v.minLength(5))),
		}));
		expect(v.safeParse(refined, { status: "active", nickname: "abc" }).success).toBe(false);
		expect(v.safeParse(refined, { status: "active", nickname: "abcdef" }).success).toBe(true);
	});

	test("style 2: .pipe(v.email(), v.minLength(5))", () => {
		const refined = refineVSchema(userSchema, (f) => ({
			nickname: f.nickname.pipe(v.minLength(5)),
		}));
		expect(v.safeParse(refined, { status: "active", nickname: "abc" }).success).toBe(false);
		// source maxLength(32) still enforced
		expect(v.safeParse(refined, { status: "active", nickname: "x".repeat(40) }).success).toBe(false);
	});

	test("style 3: native v.pipe(fields.col, ...)", () => {
		const refined = refineVSchema(userSchema, (f) => ({
			nickname: v.pipe(f.nickname, v.minLength(5)),
		}));
		expect(v.safeParse(refined, { status: "active", nickname: "abc" }).success).toBe(false);
		expect(v.safeParse(refined, { status: "active", nickname: "abcdef" }).success).toBe(true);
		// wrapper preserved through the native style: optional default flows
		const r = v.safeParse(refined, { status: "active" });
		expect(r.success).toBe(true);
		expect((r.output as any).nickname).toBeUndefined();
	});
});

describe("narrowing modifiers", () => {
	test(".required() on a nullish field rejects undefined, accepts null", () => {
		const refined = refineVSchema(userSchema, (f) => ({
			age: f.age.required(),
		}));
		expect(v.safeParse(refined, { status: "active", nickname: "n" }).success).toBe(false);
		expect(v.safeParse(refined, { status: "active", nickname: "n", age: null }).success).toBe(true);
		expect(v.safeParse(refined, { status: "active", nickname: "n", age: 21 }).success).toBe(true);
	});

	test(".nonnullable() on a nullish field rejects null, accepts undefined", () => {
		const refined = refineVSchema(userSchema, (f) => ({
			age: f.age.nonnullable(),
		}));
		expect(v.safeParse(refined, { status: "active", nickname: "n", age: null }).success).toBe(false);
		expect(v.safeParse(refined, { status: "active", nickname: "n" }).success).toBe(true);
	});
});

describe("setError", () => {
	test("custom message lands on the field's own actions", () => {
		const refined = refineVSchema(userSchema, (f) => ({
			nickname: f.nickname.pipe(v.minLength(5)).setError("Custom nickname error"),
		}));
		const r = v.safeParse(refined, { status: "active", nickname: "abc" });
		expect(r.success).toBe(false);
		expect(r.issues?.[0]?.message).toBe("Custom nickname error");
	});
});

describe("unknown fields & inputs", () => {
	test("callback referencing an unknown field throws with the field list", () => {
		expect(() =>
			refineVSchema(userSchema, (f: any) => ({
				emial: f.emial,
			})),
		).toThrow(/Unknown field "emial"/);
	});

	test("2-arg error map on an unknown field throws", () => {
		// The 2-arg map rejects unknown fields at COMPILE time too (mapped
		// over the shape) — the runtime guard covers loosely-typed callers.
		expect(() =>
			refineVSchema(userSchema, { emial: "typo" } as any),
		).toThrow(/unknown field "emial"/);
	});

	test("reversed arguments throw", () => {
		expect(() =>
			(refineVSchema as any)(userSchema, { status: { required: "x" } }, (f: any) => ({})),
		).toThrow(/callback must come before the error map/);
	});
});

describe("declarative error maps", () => {
	test("specific keys style validation issues", () => {
		const base = v.object({
			age: v.pipe(v.number(), v.integer(), v.minValue(18)),
			email: v.pipe(v.string(), v.email()),
			// REQUIRED: valibot emits missing-key issues from the object node
			// itself, so `required` styling only fires for required fields.
			name: v.string(),
		});
		const refined = refineVSchema(base, {
			age: { int: "Whole number" },
			email: { email: "Bad email" },
			name: { required: "Name is required" },
		});
		const r1 = v.safeParse(refined, { age: 1.5, email: "a@b.co" });
		expect(r1.success).toBe(false);
		expect(r1.issues?.[0]?.message).toBe("Whole number");
		const r2 = v.safeParse(refined, { age: 20, email: "nope" });
		expect(r2.issues?.[0]?.message).toBe("Bad email");
		const r3 = v.safeParse(refined, { age: 20, email: "a@b.co" });
		expect(r3.issues?.[0]?.message).toBe("Name is required");
	});

	test("unhandled issues keep valibot's native message", () => {
		const base = v.object({
			age: v.pipe(v.number(), v.minValue(18)),
			email: v.pipe(v.string(), v.email()),
		});
		const refined = refineVSchema(base, {
			email: { email: "Bad email" }, // age untouched by the map
		});
		const r = v.safeParse(refined, { age: 5 });
		expect(r.success).toBe(false);
		// native text, not a map-driven override
		expect(r.issues?.[0]?.message).not.toBe("Bad email");
		expect((r.issues?.[0]?.message ?? "").length).toBeGreaterThan(0);
	});

	test("inline authored messages are never overwritten", () => {
		const base = v.object({ name: v.pipe(v.string(), v.minLength(5, "Inline message")) });
		const refined = refineVSchema(base, {
			name: { min_length: "Map message" },
		});
		const r = v.safeParse(refined, { name: "ab" });
		expect(r.issues?.[0]?.message).toBe("Inline message");
	});

	test("multi-stage calls cascade maps without erasing earlier keys", () => {
		const base = v.object({
			age: v.pipe(v.number(), v.integer(), v.minValue(18)),
		});
		const stage1 = refineVSchema(base, { age: { int: "Whole number" } });
		const stage2 = refineVSchema(stage1, { age: { min: "Too young" } });
		const r1 = v.safeParse(stage2, { age: 1.5 });
		expect(r1.issues?.[0]?.message).toBe("Whole number");
		const r2 = v.safeParse(stage2, { age: 10 });
		expect(r2.issues?.[0]?.message).toBe("Too young");
	});

	test("unknown error map key throws", () => {
		expect(() =>
			refineVSchema(userSchema, { status: { bogus_key: "x" } } as any),
		).toThrow(/Unknown error map key "bogus_key"/);
	});
});

describe("rebuild semantics", () => {
	test("strictness of the container is preserved", () => {
		const base = v.strictObject({ name: v.string() });
		const refined = refineVSchema(base, { name: { required: "req" } });
		const r = v.safeParse(refined, { name: "a", extra: true });
		expect(r.success).toBe(false);
		expect(r.issues?.[0]?.type).toBe("strict_object");
	});

	test("object-level pipe actions are preserved on rebuild", () => {
		const base = v.pipe(
			v.object({ name: v.string() }),
			v.check((val) => (val as any).name !== "blocked", "Name is blocked"),
		);
		const refined = refineVSchema(base, { name: { required: "req" } });
		expect(v.safeParse(refined, { name: "blocked" }).success).toBe(false);
		expect(v.safeParse(refined, { name: "ok" }).success).toBe(true);
	});

	test("2-arg map output still parses correctly at runtime", () => {
		const refined = refineVSchema(userSchema, {
			email: { required: "Email required" },
		});
		// email is optional in the base; force the required path via non_optional? Instead
		// verify the optional+default flow still holds and parse works.
		const r = v.safeParse(refined, { status: "active", nickname: "abc" });
		expect(r.success).toBe(true);
		expect((r.output as any).email).toBe("dflt");
	});
});
