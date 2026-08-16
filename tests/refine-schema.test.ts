import { expect, test } from "bun:test";
import { z } from "zod";
import { refineSchema } from "../src/refine";

test("refineSchema overrides field validation and custom errors on required fields", () => {
	const baseSchema = z.object({
		id: z.number(),
		email: z.string(),
		role: z.enum(["admin", "user"]),
	});

	const refined = refineSchema(baseSchema, (fields) => ({
		email: fields.email.email({ error: "Please enter a valid email address" }),
		role: fields.role.or(z.literal("superadmin")),
	}));

	// Original fields remain intact
	const validUser = refined.safeParse({
		id: 1,
		email: "alex@example.com",
		role: "admin",
	});
	expect(validUser.success).toBe(true);

	// Refined field validation with custom error
	const invalidEmail = refined.safeParse({
		id: 1,
		email: "not-an-email",
		role: "admin",
	});
	expect(invalidEmail.success).toBe(false);
	if (!invalidEmail.success) {
		expect((invalidEmail as any).error.issues[0].message).toBe(
			"Please enter a valid email address",
		);
	}

	// Refined enum or union extension
	const superadminUser = refined.safeParse({
		id: 1,
		email: "super@example.com",
		role: "superadmin",
	});
	expect(superadminUser.success).toBe(true);
});

test("refineSchema setError overrides error messages on pre-existing checks without duplicates", () => {
	const baseSchema = z.object({
		id: z.number(),
		email: z.string().email(),
	});

	const customMessage =
		"You sir are noob because you don't know what emails are like";

	const refined = refineSchema(baseSchema, (fields) => ({
		email: fields.email.setError(customMessage),
	}));

	const invalidEmail = refined.safeParse({ id: 1, email: "invalid-email" });
	expect(invalidEmail.success).toBe(false);
	if (!invalidEmail.success) {
		const issues = (invalidEmail as any).error.issues;
		expect(issues.length).toBe(1);
		expect(issues[0].message).toBe(customMessage);
	}
});

test("refineSchema transparently handles optional and nullable fields", () => {
	const baseSchema = z.object({
		id: z.number(),
		age: z.number().optional(),
		bio: z.string().nullable(),
	});

	const refined = refineSchema(baseSchema, (fields) => ({
		age: fields.age.min(18, { error: "Must be 18 or older to register" }),
		bio: fields.bio.max(100, { error: "Bio cannot exceed 100 characters" }),
	}));

	// Valid optional/null inputs still pass
	expect(
		refined.safeParse({ id: 1, age: undefined, bio: null }).success,
	).toBe(true);
	expect(
		refined.safeParse({ id: 1, age: 25, bio: "Developer" }).success,
	).toBe(true);

	// Custom error on optional field constraint failure
	const invalidAge = refined.safeParse({ id: 1, age: 16, bio: null });
	expect(invalidAge.success).toBe(false);
	if (!invalidAge.success) {
		expect((invalidAge as any).error.issues[0].message).toBe(
			"Must be 18 or older to register",
		);
	}

	// Custom error on nullable field constraint failure
	const invalidBio = refined.safeParse({
		id: 1,
		age: 20,
		bio: "a".repeat(101),
	});
	expect(invalidBio.success).toBe(false);
	if (!invalidBio.success) {
		expect((invalidBio as any).error.issues[0].message).toBe(
			"Bio cannot exceed 100 characters",
		);
	}
});

test("refineSchema allows extending the schema with completely new fields", () => {
	const userSchema = z.object({
		id: z.number(),
		email: z.string(),
	});

	const extendedSchema = refineSchema(userSchema, (fields) => ({
		email: fields.email.setError("Invalid email address"),
		// New fields:
		confirmPassword: z.string().min(8, { error: "Password must be at least 8 chars" }),
		agreedToTerms: z.boolean(),
	}));

	// 1. Valid payload with original and new fields
	const valid = extendedSchema.safeParse({
		id: 1,
		email: "user@example.com",
		confirmPassword: "password123",
		agreedToTerms: true,
	});
	expect(valid.success).toBe(true);

	// 2. Missing new field fails
	const missingNewField = extendedSchema.safeParse({
		id: 1,
		email: "user@example.com",
	});
	expect(missingNewField.success).toBe(false);

	// 3. Inferred type check
	type ExtendedType = z.infer<typeof extendedSchema>;
	const sample: ExtendedType = {
		id: 10,
		email: "alex@example.com",
		confirmPassword: "securepassword",
		agreedToTerms: true,
	};
	expect(sample.confirmPassword).toBe("securepassword");
});

test("refineSchema preserves optional and nullable TypeScript inference when checks are applied", () => {
	const serviceSchema = z.object({
		id: z.string(),
		name: z.string(),
		description: z.string().max(300).optional(),
		bio: z.string().nullable(),
		isActive: z.boolean().optional(),
	});

	const refined = refineSchema(serviceSchema, (fields) => ({
		id: fields.id.setError("Invalid ID"),
		name: fields.name.min(3).max(50),
		description: fields.description.max(300, { error: "Description max 300" }),
		bio: fields.bio.setError("Invalid bio"),
		confirmPassword: z.string().min(8),
	}));

	type Inferred = z.infer<typeof refined>;

	// Check that description is optional in TypeScript
	const payload: Inferred = {
		id: "svc_1",
		name: "Dental Cleaning",
		// description omitted (optional)
		bio: null, // nullable
		confirmPassword: "password123",
	};

	expect(payload.description).toBeUndefined();

	const parseResult = refined.safeParse(payload);
	expect(parseResult.success).toBe(true);
});


