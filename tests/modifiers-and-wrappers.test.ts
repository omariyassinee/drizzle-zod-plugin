import { expect, test } from "bun:test";
import { z } from "zod";
import { refineSchema } from "../src/refine";

test("Modifiers: z.catch() fallback handling on validation failure", () => {
	const schema = z.object({
		theme: z.enum(["light", "dark"]).catch("light"),
		port: z.number().catch(3000),
	});

	const refined = refineSchema(schema, (fields) => ({
		theme: fields.theme,
		port: fields.port,
	}));

	// 1. Valid inputs pass directly
	expect(refined.parse({ theme: "dark", port: 8080 })).toEqual({
		theme: "dark",
		port: 8080,
	});

	// 2. Invalid inputs trigger catch fallback value
	expect(refined.parse({ theme: "invalid-theme", port: "not-a-number" })).toEqual({
		theme: "light",
		port: 3000,
	});
});

test("Modifiers: z.readonly() wrapper preservation and refinement", () => {
	const schema = z.object({
		configKey: z.string().readonly(),
		permissions: z.array(z.string()).readonly(),
	});

	const refined = refineSchema(schema, (fields) => ({
		configKey: fields.configKey.setError("Invalid config key format"),
		permissions: fields.permissions.setError("Permissions cannot be empty"),
	}));

	// 1. Valid data passes
	const valid = refined.safeParse({
		configKey: "APP_ENV",
		permissions: ["read", "write"],
	});
	expect(valid.success).toBe(true);

	// 2. Invalid configKey triggers custom error
	const invalidKey = refined.safeParse({
		configKey: 123,
		permissions: ["read"],
	});
	expect(invalidKey.success).toBe(false);
	if (!invalidKey.success) {
		expect(invalidKey.error?.issues[0]?.message).toBe("Invalid config key format");
	}

	// 3. Invalid permissions type triggers custom error
	const invalidPerms = refined.safeParse({
		configKey: "APP_ENV",
		permissions: "not-an-array",
	});
	expect(invalidPerms.success).toBe(false);
	if (!invalidPerms.success) {
		expect(invalidPerms.error?.issues[0]?.message).toBe(
			"Permissions cannot be empty",
		);
	}
});


test("Modifiers: z.brand() nominal typing with refineSchema", () => {
	const schema = z.object({
		userId: z.string().uuid().brand<"UserId">(),
		amount: z.number().positive().brand<"PositiveAmount">(),
	});

	const refined = refineSchema(schema, (fields) => ({
		userId: fields.userId.setError("Invalid User ID UUID"),
		amount: fields.amount.max(10000, { error: "Amount cannot exceed 10,000" }),
	}));

	// Valid data
	const valid = refined.safeParse({
		userId: "123e4567-e89b-12d3-a456-426614174000",
		amount: 500,
	});
	expect(valid.success).toBe(true);

	// Invalid UUID
	const invalidId = refined.safeParse({
		userId: "not-a-uuid",
		amount: 500,
	});
	expect(invalidId.success).toBe(false);
	if (!invalidId.success) {
		expect(invalidId.error?.issues[0]?.message).toBe("Invalid User ID UUID");
	}

	// Exceeded amount
	const invalidAmt = refined.safeParse({
		userId: "123e4567-e89b-12d3-a456-426614174000",
		amount: 25000,
	});
	expect(invalidAmt.success).toBe(false);
	if (!invalidAmt.success) {
		expect(invalidAmt.error?.issues[0]?.message).toBe(
			"Amount cannot exceed 10,000",
		);
	}
});

test("Modifiers: Permutation order (nullable.optional vs optional.nullable vs nullish)", () => {
	const schema = z.object({
		optNull: z.string().optional().nullable(),
		nullOpt: z.string().nullable().optional(),
		nullish: z.string().nullish(),
	});

	const refined = refineSchema(schema, (fields) => ({
		optNull: fields.optNull.min(3, { error: "optNull min 3" }),
		nullOpt: fields.nullOpt.min(3, { error: "nullOpt min 3" }),
		nullish: fields.nullish.min(3, { error: "nullish min 3" }),
	}));

	// All variations accept undefined
	expect(
		refined.safeParse({
			optNull: undefined,
			nullOpt: undefined,
			nullish: undefined,
		}).success,
	).toBe(true);

	// All variations accept null
	expect(
		refined.safeParse({
			optNull: null,
			nullOpt: null,
			nullish: null,
		}).success,
	).toBe(true);

	// All variations accept valid string
	expect(
		refined.safeParse({
			optNull: "abc",
			nullOpt: "def",
			nullish: "ghi",
		}).success,
	).toBe(true);

	// All variations reject short string with corresponding error
	const invalid = refined.safeParse({
		optNull: "a",
		nullOpt: "b",
		nullish: "c",
	});
	expect(invalid.success).toBe(false);
	if (!invalid.success) {
		const messages = invalid.error.issues.map((i) => i.message);
		expect(messages).toContain("optNull min 3");
		expect(messages).toContain("nullOpt min 3");
		expect(messages).toContain("nullish min 3");
	}
});

test("Modifiers: Nested sub-object partial schemas", () => {
	const metadataSchema = z.object({
		author: z.string(),
		tags: z.array(z.string()),
		settings: z.object({
			isPublic: z.boolean(),
		}).partial(),
	}).partial();

	const schema = z.object({
		title: z.string(),
		metadata: metadataSchema,
	}).partial();

	const refined = refineSchema(schema, (fields) => ({
		title: fields.title.setError("Title must be a valid string"),
	}));

	// Empty payload passes because nested fields are optional
	expect(refined.safeParse({}).success).toBe(true);
	expect(refined.safeParse({ metadata: {} }).success).toBe(true);
	expect(refined.safeParse({ metadata: { settings: {} } }).success).toBe(true);

	// Valid payload
	expect(
		refined.safeParse({
			title: "Article",
			metadata: { author: "Alice", tags: ["news"] },
		}).success,
	).toBe(true);
});

