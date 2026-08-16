import { expect, test } from "bun:test";
import { z } from "zod";
import { refineSchema } from "../src/refine";

test("Case 1: User scenario - pick + partial on schema with existing optional/nullable fields", () => {
	const insertSchema = z.object({
		id: z.number(),
		date: z.string(),
		reason: z.string().optional(), // already optional from Drizzle
		clinicId: z.string().uuid().optional(), // already optional from Drizzle
	});

	const baseBlockDaySchema = insertSchema
		.pick({ date: true, reason: true, clinicId: true })
		.partial({ clinicId: true, reason: true });

	const blockDaySchema = refineSchema(baseBlockDaySchema, (schema) => ({
		date: schema.date.setError("Invalid date provided"),
		clinicId: schema.clinicId.setError("Invalid clinic ID"),
		reason: schema.reason.max(10, "Reason exceeds max limit"),
	}));

	// 1. Valid payload with only date
	const validOnlyDate = blockDaySchema.safeParse({ date: "2026-08-16" });
	expect(validOnlyDate.success).toBe(true);

	// 2. Valid payload with all fields
	const validAll = blockDaySchema.safeParse({
		date: "2026-08-16",
		reason: "Doctor off",
		clinicId: "123e4567-e89b-12d3-a456-426614174000",
	});
	expect(validAll.success).toBe(true);

	// 3. Invalid date should trigger custom error
	const invalidDate = blockDaySchema.safeParse({
		date: 123,
	});
	expect(invalidDate.success).toBe(false);
	if (!invalidDate.success) {
		expect(invalidDate.error?.issues[0]?.message).toBe("Invalid date provided");
	}

	// 4. Invalid clinicId (not a UUID) should trigger custom error
	const invalidClinic = blockDaySchema.safeParse({
		date: "2026-08-16",
		clinicId: "not-a-valid-uuid",
	});
	expect(invalidClinic.success).toBe(false);
	if (!invalidClinic.success) {
		expect(invalidClinic.error?.issues[0]?.message).toBe("Invalid clinic ID");
	}

	// 5. Reason exceeding max should trigger custom error
	const invalidReason = blockDaySchema.safeParse({
		date: "2026-08-16",
		reason: "This reason is way too long for ten chars",
	});
	expect(invalidReason.success).toBe(false);
	if (!invalidReason.success) {
		expect(invalidReason.error?.issues[0]?.message).toBe("Reason exceeds max limit");
	}
});

test("Case 2: Deeply nested optional wrappers (double/triple partial)", () => {
	const schema = z.object({
		notes: z.string().optional(),
	});

	// Applying partial multiple times creates nested ZodOptional
	const doublePartial = schema.partial();
	const triplePartial = doublePartial.partial();

	const refined = refineSchema(triplePartial, (fields) => ({
		notes: fields.notes.min(5, { error: "Notes must be at least 5 chars" }),
	}));

	expect(refined.safeParse({}).success).toBe(true);
	expect(refined.safeParse({ notes: undefined }).success).toBe(true);
	expect(refined.safeParse({ notes: "Hello world" }).success).toBe(true);

	const invalid = refined.safeParse({ notes: "Hi" });
	expect(invalid.success).toBe(false);
	if (!invalid.success) {
		expect(invalid.error?.issues[0]?.message).toBe("Notes must be at least 5 chars");
	}
});

test("Case 3: Nullable + Optional combination (nullish)", () => {
	const schema = z.object({
		description: z.string().nullable().optional(),
		website: z.string().url().nullable().optional(),
	});

	const partialSchema = schema.partial();

	const refined = refineSchema(partialSchema, (fields) => ({
		description: fields.description.max(20, { error: "Description max 20 chars" }),
		website: fields.website.setError("Website URL is invalid"),
	}));

	// Null and undefined must both be accepted
	expect(refined.safeParse({ description: null, website: null }).success).toBe(true);
	expect(refined.safeParse({ description: undefined, website: undefined }).success).toBe(true);
	expect(refined.safeParse({}).success).toBe(true);

	// Valid inputs
	expect(
		refined.safeParse({
			description: "Short desc",
			website: "https://example.com",
		}).success,
	).toBe(true);

	// Invalid description
	const invalidDesc = refined.safeParse({
		description: "This is a very long description that exceeds twenty characters",
	});
	expect(invalidDesc.success).toBe(false);
	if (!invalidDesc.success) {
		expect(invalidDesc.error?.issues[0]?.message).toBe("Description max 20 chars");
	}

	// Invalid website
	const invalidWeb = refined.safeParse({
		website: "not-a-url",
	});
	expect(invalidWeb.success).toBe(false);
	if (!invalidWeb.success) {
		expect(invalidWeb.error?.issues[0]?.message).toBe("Website URL is invalid");
	}
});

test("Case 4: Default value preservation and refinement", () => {
	const schema = z.object({
		status: z.enum(["active", "pending", "inactive"]).default("pending"),
		retryCount: z.number().default(0),
	});

	const refined = refineSchema(schema, (fields) => ({
		status: fields.status.setError("Invalid status choice"),
		retryCount: fields.retryCount.min(0, { error: "Retry count cannot be negative" }),
	}));

	// Default values should be preserved when omitted
	const parsedDefault = refined.parse({});
	expect(parsedDefault.status).toBe("pending");
	expect(parsedDefault.retryCount).toBe(0);

	// Invalid status should trigger custom error
	const invalidStatus = refined.safeParse({ status: "unknown" });
	expect(invalidStatus.success).toBe(false);
	if (!invalidStatus.success) {
		expect(invalidStatus.error?.issues[0]?.message).toBe("Invalid status choice");
	}

	// Invalid retryCount
	const invalidRetry = refined.safeParse({ retryCount: -1 });
	expect(invalidRetry.success).toBe(false);
	if (!invalidRetry.success) {
		expect(invalidRetry.error?.issues[0]?.message).toBe("Retry count cannot be negative");
	}
});

test("Case 5: Method chaining on proxied optional/nullable fields", () => {
	const schema = z.object({
		username: z.string().optional(),
		score: z.number().nullable(),
	});

	const refined = refineSchema(schema, (fields) => ({
		username: fields.username.min(3, { error: "Min 3" }).max(15, { error: "Max 15" }),
		score: fields.score.min(0, { error: "Min 0" }).max(100, { error: "Max 100" }),
	}));

	// Undefined for optional, null for nullable remain valid
	expect(refined.safeParse({ score: null }).success).toBe(true);
	expect(refined.safeParse({ username: undefined, score: null }).success).toBe(true);

	// Valid in-range values
	expect(refined.safeParse({ username: "john", score: 85 }).success).toBe(true);

	// First constraint violation
	const tooShort = refined.safeParse({ username: "ab" });
	expect(tooShort.success).toBe(false);
	if (!tooShort.success) {
		expect(tooShort.error?.issues[0]?.message).toBe("Min 3");
	}

	// Second chained constraint violation
	const tooLong = refined.safeParse({ username: "a_very_long_username_exceeding_limit" });
	expect(tooLong.success).toBe(false);
	if (!tooLong.success) {
		expect(tooLong.error?.issues[0]?.message).toBe("Max 15");
	}
});

test("Case 6: Schema required() after partial()", () => {
	const base = z.object({
		title: z.string(),
		tags: z.array(z.string()).optional(),
	});

	// Make all partial, then require title explicitly
	const modified = base.partial().required({ title: true });

	const refined = refineSchema(modified, (fields) => ({
		title: fields.title.setError("Title is mandatory"),
		tags: fields.tags.min(1, { error: "At least one tag required" }),
	}));

	// Missing required title
	const missingTitle = refined.safeParse({});
	expect(missingTitle.success).toBe(false);
	if (!missingTitle.success) {
		expect(missingTitle.error?.issues[0]?.message).toBe("Title is mandatory");
	}

	// Valid with title and tags
	expect(refined.safeParse({ title: "My Post", tags: ["tech"] }).success).toBe(true);

	// Invalid empty tags array when tags provided
	const emptyTags = refined.safeParse({ title: "My Post", tags: [] });
	expect(emptyTags.success).toBe(false);
	if (!emptyTags.success) {
		expect(emptyTags.error?.issues[0]?.message).toBe("At least one tag required");
	}
});

test("Case 7: Coerced and Date fields with setError", () => {
	const schema = z.object({
		birthday: z.coerce.date().optional(),
		amount: z.coerce.number().optional(),
	});

	const partialSchema = schema.partial();

	const refined = refineSchema(partialSchema, (fields) => ({
		birthday: fields.birthday.setError("Please provide a valid date"),
		amount: fields.amount.min(1, { error: "Amount must be at least 1" }),
	}));

	expect(refined.safeParse({}).success).toBe(true);

	// Valid coercion
	const valid = refined.safeParse({ birthday: "2026-08-16", amount: "50" });
	expect(valid.success).toBe(true);
	if (valid.success) {
		expect(valid.data.birthday instanceof Date).toBe(true);
		expect(valid.data.amount).toBe(50);
	}

	// Invalid date string
	const invalidDate = refined.safeParse({ birthday: "not-a-date" });
	expect(invalidDate.success).toBe(false);
	if (!invalidDate.success) {
		expect(invalidDate.error?.issues[0]?.message).toBe("Please provide a valid date");
	}

	// Invalid amount
	const invalidAmount = refined.safeParse({ amount: "0" });
	expect(invalidAmount.success).toBe(false);
	if (!invalidAmount.success) {
		expect(invalidAmount.error?.issues[0]?.message).toBe("Amount must be at least 1");
	}
});

test("Case 8: setError on pre-existing checks inside nested optional/nullable wrappers", () => {
	const schema = z.object({
		userId: z.string().uuid().optional(),
		contactEmail: z.string().email().nullable(),
	});

	// Nested via partial
	const partialSchema = schema.partial();

	const refined = refineSchema(partialSchema, (fields) => ({
		userId: fields.userId.setError("Custom UUID format error"),
		contactEmail: fields.contactEmail.setError("Custom email format error"),
	}));

	// 1. Undefined and null still pass
	expect(refined.safeParse({}).success).toBe(true);
	expect(refined.safeParse({ userId: undefined, contactEmail: null }).success).toBe(true);

	// 2. Invalid UUID format should have the custom error message
	const invalidUuid = refined.safeParse({ userId: "invalid-uuid-string" });
	expect(invalidUuid.success).toBe(false);
	if (!invalidUuid.success) {
		expect(invalidUuid.error?.issues[0]?.message).toBe("Custom UUID format error");
	}

	// 3. Invalid Email format should have the custom error message
	const invalidEmail = refined.safeParse({ contactEmail: "invalid-email" });
	expect(invalidEmail.success).toBe(false);
	if (!invalidEmail.success) {
		expect(invalidEmail.error?.issues[0]?.message).toBe("Custom email format error");
	}
});

test("Case 9: exactOptional wrapper handling (Zod v4)", () => {
	const schema = z.object({
		code: z.string().exactOptional(),
	});

	const refined = refineSchema(schema, (fields) => ({
		code: fields.code.min(4, { error: "Code must be 4 chars" }),
	}));

	expect(refined.safeParse({}).success).toBe(true);
	expect(refined.safeParse({ code: "ABCD" }).success).toBe(true);

	const invalid = refined.safeParse({ code: "AB" });
	expect(invalid.success).toBe(false);
	if (!invalid.success) {
		expect(invalid.error?.issues[0]?.message).toBe("Code must be 4 chars");
	}
});

test("Case 10: Array wrapper methods (min items, nonempty)", () => {
	const schema = z.object({
		categories: z.array(z.string()).optional(),
	});

	const partialSchema = schema.partial();

	const refined = refineSchema(partialSchema, (fields) => ({
		categories: fields.categories.min(2, { error: "At least 2 categories required" }),
	}));

	expect(refined.safeParse({}).success).toBe(true);
	expect(refined.safeParse({ categories: ["A", "B"] }).success).toBe(true);

	const invalid = refined.safeParse({ categories: ["A"] });
	expect(invalid.success).toBe(false);
	if (!invalid.success) {
		expect(invalid.error?.issues[0]?.message).toBe("At least 2 categories required");
	}
});


