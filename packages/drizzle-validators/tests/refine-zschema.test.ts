import { expect, test } from "bun:test";
import { z } from "zod";
import { refineZSchema } from "../src/refine";

test("refineZSchema overrides field validation and custom errors on required fields", () => {
	const baseSchema = z.object({
		id: z.number(),
		email: z.string(),
		role: z.enum(["admin", "user"]),
	});

	const refined = refineZSchema(baseSchema, (fields) => ({
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

test("refineZSchema setError overrides error messages on pre-existing checks without duplicates", () => {
	const baseSchema = z.object({
		id: z.number(),
		email: z.string().email(),
	});

	const customMessage =
		"You sir are noob because you don't know what emails are like";

	const refined = refineZSchema(baseSchema, (fields) => ({
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

test("refineZSchema transparently handles optional and nullable fields", () => {
	const baseSchema = z.object({
		id: z.number(),
		age: z.number().optional(),
		bio: z.string().nullable(),
	});

	const refined = refineZSchema(baseSchema, (fields) => ({
		age: fields.age.min(18, { error: "Must be 18 or older to register" }),
		bio: fields.bio.max(100, { error: "Bio cannot exceed 100 characters" }),
	}));

	// Valid optional/null inputs still pass
	expect(refined.safeParse({ id: 1, age: undefined, bio: null }).success).toBe(
		true,
	);
	expect(refined.safeParse({ id: 1, age: 25, bio: "Developer" }).success).toBe(
		true,
	);

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

test("refineZSchema allows extending the schema with completely new fields", () => {
	const userSchema = z.object({
		id: z.number(),
		email: z.string(),
	});

	const extendedSchema = refineZSchema(userSchema, (fields) => ({
		email: fields.email.setError("Invalid email address"),
		// New fields:
		confirmPassword: z
			.string()
			.min(8, { error: "Password must be at least 8 chars" }),
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

test("refineZSchema preserves optional and nullable TypeScript inference when checks are applied", () => {
	const serviceSchema = z.object({
		id: z.string(),
		name: z.string(),
		description: z.string().max(300).optional(),
		bio: z.string().nullable(),
		isActive: z.boolean().optional(),
	});

	const refined = refineZSchema(serviceSchema, (fields) => ({
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

test("refineZSchema .as() converts native formats and preserves wrappers", () => {
	const baseSchema = z.object({
		email: z.string(),
		optionalEmail: z.string().optional(),
		nullableUrl: z.string().nullable(),
		userId: z.string(),
		customUuid: z.string(),
	});

	const refined = refineZSchema(baseSchema, (fields) => ({
		email: fields.email.as(z.email({ error: "Invalid work email" })),
		optionalEmail: fields.optionalEmail.as(z.email({
			error: "Invalid optional email",
		})),
		nullableUrl: fields.nullableUrl.as(z.url({ error: "Invalid website url" })),
		userId: fields.userId.as(z.uuid({ error: "Invalid user uuid" })),
		customUuid: fields.customUuid.as(
			z.string().uuid({ error: "Invalid custom uuid" }),
		),
	}));

	// 1. Valid payload
	const valid = refined.safeParse({
		email: "alex@example.com",
		optionalEmail: undefined,
		nullableUrl: null,
		userId: "123e4567-e89b-12d3-a456-426614174000",
		customUuid: "123e4567-e89b-12d3-a456-426614174000",
	});
	expect(valid.success).toBe(true);

	// 2. Invalid email error message
	const invalidEmail = refined.safeParse({
		email: "invalid-email-format",
		nullableUrl: null,
		userId: "123e4567-e89b-12d3-a456-426614174000",
		customUuid: "123e4567-e89b-12d3-a456-426614174000",
	});
	expect(invalidEmail.success).toBe(false);
	if (!invalidEmail.success) {
		expect((invalidEmail as any).error?.issues[0]?.message).toBe(
			"Invalid work email",
		);
	}

	// 3. Invalid optional email when provided
	const invalidOptionalEmail = refined.safeParse({
		email: "alex@example.com",
		optionalEmail: "not-an-email",
		nullableUrl: null,
		userId: "123e4567-e89b-12d3-a456-426614174000",
		customUuid: "123e4567-e89b-12d3-a456-426614174000",
	});
	expect(invalidOptionalEmail.success).toBe(false);
	if (!invalidOptionalEmail.success) {
		expect((invalidOptionalEmail as any).error?.issues[0]?.message).toBe(
			"Invalid optional email",
		);
	}

	// 4. Invalid nullable URL when provided
	const invalidUrl = refined.safeParse({
		email: "alex@example.com",
		nullableUrl: "not-a-url",
		userId: "123e4567-e89b-12d3-a456-426614174000",
		customUuid: "123e4567-e89b-12d3-a456-426614174000",
	});
	expect(invalidUrl.success).toBe(false);
	if (!invalidUrl.success) {
		expect((invalidUrl as any).error?.issues[0]?.message).toBe(
			"Invalid website url",
		);
	}

	// 5. Invalid UUID
	const invalidUuid = refined.safeParse({
		email: "alex@example.com",
		nullableUrl: null,
		userId: "bad-uuid",
		customUuid: "123e4567-e89b-12d3-a456-426614174000",
	});
	expect(invalidUuid.success).toBe(false);
	if (!invalidUuid.success) {
		expect((invalidUuid as any).error?.issues[0]?.message).toBe(
			"Invalid user uuid",
		);
	}

	// 6. Chaining setError on a native format replacement
	const chainRefined = refineZSchema(baseSchema, (fields) => ({
		email: fields.email.as(z.email()).setError("Chained email error override"),
	}));
	const chainedInvalid = chainRefined.safeParse({
		email: "not-an-email",
		nullableUrl: null,
		userId: "123e4567-e89b-12d3-a456-426614174000",
		customUuid: "123e4567-e89b-12d3-a456-426614174000",
	});
	expect(chainedInvalid.success).toBe(false);
	if (!chainedInvalid.success) {
		expect((chainedInvalid as any).error?.issues[0]?.message).toBe(
			"Chained email error override",
		);
	}
});

test("refineZSchema keeps required-field chains proxied and supports wrapper controls", () => {
	const base = z.object({
		requiredName: z.string(),
		optionalName: z.string().optional(),
		nullableName: z.string().nullable(),
	});

	const refined = refineZSchema(base, (fields) => ({
		requiredName: fields.requiredName.min(3).setError("Name is too short"),
		optionalName: fields.optionalName.required().as(z.string().min(2)),
		nullableName: fields.nullableName.nonnullable().as(z.string().min(2)),
	}));

	expect(
		refined.safeParse({
			requiredName: "ab",
			optionalName: "valid",
			nullableName: "valid",
		}).success,
	).toBe(false);
	expect(
		refined.safeParse({
			requiredName: "valid",
			optionalName: undefined,
			nullableName: null,
		}).success,
	).toBe(false);
	expect(
		refined.safeParse({
			requiredName: "valid",
			optionalName: "valid",
			nullableName: null,
		}).success,
	).toBe(false);
});

// NOTE: the callback intentionally receives ONLY the fields proxy. An
// earlier iteration injected the Zod namespace as a second argument — but
// materializing `z` references zod's full export graph (~454 KB minified
// vs ~85 KB for named imports), busting the package's tree-shaking
// guarantee for every consumer. Users import zod themselves.
test("refineZSchema passes only the fields proxy to the callback", () => {
	const base = z.object({ email: z.string() });
	const refined = refineZSchema(base, (fields) => ({
		email: fields.email.as(z.email()),
		role: z.enum(["admin", "member"]),
	}));

	expect(
		refined.safeParse({ email: "user@example.com", role: "admin" }).success,
	).toBe(true);
	expect(
		refined.safeParse({ email: "invalid", role: "admin" }).success,
	).toBe(false);
});

test("refineZSchema preserves strict object policy and validates callback output", () => {
	const strictBase = z.strictObject({ name: z.string() });
	const refined = refineZSchema(strictBase, (fields) => ({
		name: fields.name,
	}));

	expect(refined.safeParse({ name: "Ada", extra: true }).success).toBe(false);
	expect(() =>
		refineZSchema(strictBase, () => ({ name: "not a schema" } as any)),
	).toThrow(/Invalid refinement for field "name"/);
});

// Cross-constraint satisfiability: a source bound that CONFLICTS with a
// different target bound must be dropped, never synthesized into an
// impossible schema (e.g. varchar(8) column + .as(z.string().min(10))).
test(".as() drops source bounds that conflict with target bounds", () => {
	const base = z.object({ licenseCode: z.string().max(8) });
	const refined = refineZSchema(base, (f) => ({
		licenseCode: f.licenseCode.as(z.string().min(10)),
	}));

	// 11 chars would fail a transferred max(8); the conflict is dropped
	expect(
		refined.safeParse({ licenseCode: "L1234567890" }).success,
	).toBe(true);
	// min(10) from the target is still enforced
	expect(refined.safeParse({ licenseCode: "abc" }).success).toBe(false);
});

test(".as() keeps satisfiable source bounds alongside target bounds", () => {
	const base = z.object({ licenseCode: z.string().max(8) });
	const refined = refineZSchema(base, (f) => ({
		licenseCode: f.licenseCode.as(z.string().min(3)),
	}));

	expect(refined.safeParse({ licenseCode: "abcde" }).success).toBe(true);
	expect(refined.safeParse({ licenseCode: "ab" }).success).toBe(false);
	expect(refined.safeParse({ licenseCode: "abcdefghij" }).success).toBe(
		false,
	);
});

test(".as() length_equals vs min/max conflicts resolve in both directions", () => {
	// column emits length(8); target raises min above it -> drop equals
	const raised = refineZSchema(
		z.object({ code: z.string().length(8) }),
		(f) => ({ code: f.code.as(z.string().min(10)) }),
	);
	expect(raised.safeParse({ code: "L1234567890" }).success).toBe(true);

	// target lowers min below it -> equals still transferred and binding
	const lowered = refineZSchema(
		z.object({ code: z.string().length(8) }),
		(f) => ({ code: f.code.as(z.string().min(4)) }),
	);
	expect(lowered.safeParse({ code: "12345678" }).success).toBe(true);
	expect(lowered.safeParse({ code: "1234" }).success).toBe(false);
});

test(".as() numeric min/max conflicts drop the unsatisfiable source bound", () => {
	const base = z.object({ score: z.number().max(100) });
	const refined = refineZSchema(base, (f) => ({
		score: f.score.as(z.number().min(200)),
	}));

	expect(refined.safeParse({ score: 250 }).success).toBe(true);
	// the dropped max(100) would have rejected 250
	expect(refined.safeParse({ score: 50 }).success).toBe(false);
});

// setError must not bleed into array/tuple ITEM schemas (audit 5b): the
// custom message belongs to the field's own checks; element-level failures
// keep their own messages.
test(".setError() on an array field leaves element error messages intact", () => {
	const base = z.object({ tags: z.array(z.string()) });
	const refined = refineZSchema(base, (f) => ({
		tags: f.tags.min(1).setError("At least one tag required"),
	}));

	// outer check carries the custom message
	const empty = refined.safeParse({ tags: [] });
	expect(empty.success).toBe(false);
	if (!empty.success) {
		expect(empty.error.issues[0]!.message).toBe(
			"At least one tag required",
		);
	}

	// element type failure does NOT report the array's custom message
	const badElement = refined.safeParse({ tags: [123] });
	expect(badElement.success).toBe(false);
	if (!badElement.success) {
		expect(badElement.error.issues[0]!.message).not.toBe(
			"At least one tag required",
		);
	}
});
