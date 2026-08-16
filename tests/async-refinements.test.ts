import { expect, test } from "bun:test";
import { z } from "zod";
import { refineSchema } from "../src/refine";

test("Async: refineSchema with async .refine() checks", async () => {
	const takenUsernames = new Set(["admin", "root", "moderator"]);

	const asyncCheckUsername = async (username: string): Promise<boolean> => {
		// Simulate network latency
		await new Promise((r) => setTimeout(r, 10));
		return !takenUsernames.has(username.toLowerCase());
	};

	const userSchema = z.object({
		id: z.number(),
		username: z.string(),
	});

	const refined = refineSchema(userSchema, (fields) => ({
		username: fields.username
			.min(3, { error: "Username must be at least 3 chars" })
			.refine(asyncCheckUsername, { error: "Username is already taken" }),
	}));

	// 1. Valid unique username via safeParseAsync
	const valid = await refined.safeParseAsync({
		id: 1,
		username: "john_doe",
	});
	expect(valid.success).toBe(true);

	// 2. Taken username fails with async error message
	const taken = await refined.safeParseAsync({
		id: 2,
		username: "admin",
	});
	expect(taken.success).toBe(false);
	if (!taken.success) {
		expect(taken.error?.issues[0]?.message).toBe("Username is already taken");
	}
});

test("Async: refineSchema with async .transform() pipeline", async () => {
	const fetchUserRole = async (userId: string): Promise<string> => {
		await new Promise((r) => setTimeout(r, 10));
		return userId.startsWith("dr_") ? "doctor" : "patient";
	};

	const sessionSchema = z.object({
		userId: z.string(),
	});

	const refined = refineSchema(sessionSchema, (fields) => ({
		userId: fields.userId,
		userRole: z.string().optional().transform(async (_, ctx) => {
			return fetchUserRole("dr_123");
		}),
	}));

	const parsed = await refined.parseAsync({
		userId: "dr_123",
	});

	expect(parsed.userId).toBe("dr_123");
	expect(parsed.userRole).toBe("doctor");
});
