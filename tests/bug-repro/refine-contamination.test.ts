/**
 * C1 — setError() mutates the SHARED def → contaminates base schema + siblings.
 * C2 — .asEmail()/.format()/.as() silently discard existing checks.
 *
 * See BUG-REPORT.md, findings C1 and C2.
 */
import { expect, test } from "bun:test";
import { z } from "zod";
import { refineSchema } from "../../src/refine";

test("C1: setError does not contaminate sibling validators refining the same base", async () => {
	const baseInsert = z.object({ email: z.string().min(5), age: z.number() });

	const validatorA = refineSchema(baseInsert, (f) => ({
		email: f.email.setError("EMAIL A"),
	}));
	const validatorB = refineSchema(baseInsert, (f) => ({
		email: f.email.setError("EMAIL B"),
	}));

	const bad = { email: "x@y", age: 1 }; // email too short

	// BUG: all three report "EMAIL B" (last write wins on the shared def)
	expect(firstIssue(validatorA.safeParse(bad))).toBe("EMAIL A");
	expect(firstIssue(validatorB.safeParse(bad))).toBe("EMAIL B");
	// The untouched base schema must not be corrupted either.
	expect(firstIssue(baseInsert.safeParse(bad))).toBe(
		"Too small: expected string to have >=5 characters",
	);
});

test("C1: setError on one field does not leak into other untouched fields", async () => {
	const base = z.object({ email: z.string().min(5), name: z.string().min(2) });
	const refined = refineSchema(base, (f) => ({
		email: f.email.setError("EMAIL A"),
	}));

	// email is valid, name is too short — name must keep the original zod default.
	// (Using a valid email matters: with an invalid email, the email issue would
	// land at issues[0] and mask name's error.)
	expect(
		firstIssue(refined.safeParse({ email: "valid@email.com", name: "x" })),
	).toBe("Too small: expected string to have >=2 characters");
});

test("C2: .asEmail() preserves existing checks (min/max/regex) on the field", async () => {
	const base = z.object({ email: z.string().min(10) });
	const refined = refineSchema(base, (f) => ({
		email: f.email.asEmail(),
	}));

	// "a@b.co" is a valid email of length 6 (< 10 chars) — min(10) must still reject.
	// BUG: passes today (check silently dropped).
	const r = refined.safeParse({ email: "a@b.co" });
	expect(r.success).toBe(false);
});

test("C2: .format() preserves existing checks", async () => {
	const base = z.object({ email: z.string().max(5) });
	const refined = refineSchema(base, (f) => ({
		email: f.email.format("email"),
	}));

	// "someone@example.com" is a valid email but > 5 chars — max(5) must reject.
	const r = refined.safeParse({ email: "someone@example.com" });
	expect(r.success).toBe(false);
});

test("C2: .as() preserves existing checks", async () => {
	const base = z.object({ email: z.string().min(10) });
	const refined = refineSchema(base, (f) => ({
		email: f.email.as(z.email()),
	}));

	// "a@b.co" is a valid email of length 6 (< 10 chars) — min(10) must reject.
	const r = refined.safeParse({ email: "a@b.co" });
	expect(r.success).toBe(false);
});

function firstIssue(result: {
	success: boolean;
	error?: { issues: Array<{ message: string }> };
}): string | undefined {
	return result.error?.issues?.[0]?.message;
}
