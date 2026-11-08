import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { refineVSchema } from "../src/valibot-refine";

// ───────────────────────── Fix 3: setError ─────────────────────────

describe("setError overrides (Fix 3)", () => {
	test("setError overrides the base schema message (wrong primitive type)", () => {
		const base = v.object({
			name: v.pipe(v.string(), v.minLength(3)),
		});
		const refined = refineVSchema(base, (f) => ({
			name: f.name.setError("Custom name error"),
		}));
		// wrong primitive type (123) — base schema fails
		const r = v.safeParse(refined, { name: 123 });
		expect(r.success).toBe(false);
		expect(r.issues?.[0]?.message).toBe("Custom name error");
	});

	test("setError overrides null input", () => {
		const base = v.object({
			name: v.pipe(v.string(), v.minLength(3)),
		});
		const refined = refineVSchema(base, (f) => ({
			name: f.name.setError("Custom name error"),
		}));
		const r = v.safeParse(refined, { name: null });
		expect(r.success).toBe(false);
		expect(r.issues?.[0]?.message).toBe("Custom name error");
	});

	test("setError overrides an inline authored message", () => {
		const base = v.object({
			name: v.pipe(v.string(), v.minLength(5, "Inline message")),
		});
		const refined = refineVSchema(base, (f) => ({
			name: f.name.setError("Override message"),
		}));
		const r = v.safeParse(refined, { name: "ab" });
		expect(r.success).toBe(false);
		expect(r.issues?.[0]?.message).toBe("Override message");
	});

	test("chained setError: last call wins", () => {
		const base = v.object({
			name: v.pipe(v.string(), v.minLength(3)),
		});
		const refined = refineVSchema(base, (f) => ({
			name: f.name.setError("First").setError("Second"),
		}));
		const r = v.safeParse(refined, { name: "ab" });
		expect(r.success).toBe(false);
		expect(r.issues?.[0]?.message).toBe("Second");
	});

	test("setError on a required field overrides missing-key issue", () => {
		const base = v.object({
			name: v.string(),
		});
		const refined = refineVSchema(base, (f) => ({
			name: f.name.setError("Name is required"),
		}));
		const r = v.safeParse(refined, {});
		expect(r.success).toBe(false);
		expect(r.issues?.[0]?.message).toBe("Name is required");
	});
});

// ───────────────────────── Fix 4: pipe execution order ─────────────────────────

describe("pipe execution order (Fix 4)", () => {
	test("fields.col.pipe() runs inherited column checks BEFORE new actions", () => {
		const base = v.object({
			nickname: v.pipe(v.string(), v.maxLength(32)),
		});
		const refined = refineVSchema(base, (f) => ({
			nickname: f.nickname.pipe(v.trim(), v.minLength(3)),
		}));
		// maxLength(32) from the column still enforced
		expect(v.safeParse(refined, { nickname: "x".repeat(40) }).success).toBe(
			false,
		);
		// minLength(3) from the new action enforced
		expect(v.safeParse(refined, { nickname: "ab" }).success).toBe(false);
		// valid
		expect(v.safeParse(refined, { nickname: "abc" }).success).toBe(true);
	});

	test("native v.pipe(fields.col, ...) runs inherited checks before new actions", () => {
		const base = v.object({
			nickname: v.pipe(v.string(), v.maxLength(32)),
		});
		const refined = refineVSchema(base, (f) => ({
			nickname: v.pipe(f.nickname, v.minLength(3)),
		}));
		expect(v.safeParse(refined, { nickname: "x".repeat(40) }).success).toBe(
			false,
		);
		expect(v.safeParse(refined, { nickname: "ab" }).success).toBe(false);
		expect(v.safeParse(refined, { nickname: "abc" }).success).toBe(true);
	});
});

// ───────────────────────── Fix 5: error map keys ─────────────────────────

describe("error map keys (Fix 5)", () => {
	test("too_small / too_big work in errorMap", () => {
		const base = v.object({
			age: v.pipe(v.number(), v.minValue(18)),
			name: v.pipe(v.string(), v.maxLength(5)),
		});
		const refined = refineVSchema(base, {
			age: { too_small: "Too young" },
			name: { too_big: "Too long" },
		});
		const r1 = v.safeParse(refined, { age: 10, name: "abc" });
		expect(r1.issues?.[0]?.message).toBe("Too young");
		const r2 = v.safeParse(refined, { age: 20, name: "abcdef" });
		expect(r2.issues?.[0]?.message).toBe("Too long");
	});

	test("not_multiple_of works in errorMap", () => {
		const base = v.object({
			n: v.pipe(v.number(), v.multipleOf(3)),
		});
		const refined = refineVSchema(base, {
			n: { not_multiple_of: "Not a multiple of 3" },
		});
		const r = v.safeParse(refined, { n: 7 });
		expect(r.success).toBe(false);
		expect(r.issues?.[0]?.message).toBe("Not a multiple of 3");
	});

	test("min_value works in errorMap", () => {
		const base = v.object({
			age: v.pipe(v.number(), v.minValue(18)),
		});
		const refined = refineVSchema(base, {
			age: { min_value: "Must be at least 18" },
		});
		const r = v.safeParse(refined, { age: 10 });
		expect(r.issues?.[0]?.message).toBe("Must be at least 18");
	});

	test("v.enum failures match invalid_value in errorMap", () => {
		const base = v.object({
			status: v.picklist(["active", "banned"]),
		});
		const refined = refineVSchema(base, {
			status: { invalid_value: "Invalid status" },
		});
		const r = v.safeParse(refined, { status: "unknown" });
		expect(r.success).toBe(false);
		expect(r.issues?.[0]?.message).toBe("Invalid status");
	});
});

// ───────────────────────── Fix 7: piped object errorMap ─────────────────────────

describe("piped object errorMap (Fix 7)", () => {
	test("errorMap required works on a piped object", () => {
		const base = v.pipe(
			v.object({ name: v.string() }),
			v.check((val) => (val as any).name !== "blocked", "Name is blocked"),
		);
		const refined = refineVSchema(base, {
			name: { required: "Name is required" },
		});
		const r = v.safeParse(refined, {});
		expect(r.success).toBe(false);
		expect(r.issues?.[0]?.message).toBe("Name is required");
		// object-level pipe action still works
		expect(v.safeParse(refined, { name: "blocked" }).success).toBe(false);
		expect(v.safeParse(refined, { name: "ok" }).success).toBe(true);
	});
});
