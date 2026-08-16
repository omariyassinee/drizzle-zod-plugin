import { expect, test } from "bun:test";
import { z } from "zod";
import { refineSchema } from "../src/refine";

test("Composition: Multi-stage sequential refineSchema calls", () => {
	// Step 1: Base table schema
	const baseTableSchema = z.object({
		id: z.number(),
		email: z.string(),
		role: z.enum(["admin", "doctor", "staff"]),
		clinicId: z.string().uuid(),
	});

	// Step 2: Shared organization refinement
	const orgSchema = refineSchema(baseTableSchema, (fields) => ({
		email: fields.email.email({ error: "Invalid organization email" }),
		clinicId: fields.clinicId.setError("Invalid organization clinic ID"),
	}));

	// Step 3: Route-specific refinement (e.g. form submission)
	const formSchema = refineSchema(orgSchema, (fields) => ({
		role: fields.role.extract(["admin", "doctor"]), // Restrict role to admin/doctor only
		referralCode: z.string().min(4, { error: "Referral code must be at least 4 chars" }).optional(),
	}));

	// 1. Valid payload with allowed role
	const valid = formSchema.safeParse({
		id: 1,
		email: "alex@clinic.org",
		role: "doctor",
		clinicId: "123e4567-e89b-12d3-a456-426614174000",
		referralCode: "REF123",
	});
	expect(valid.success).toBe(true);

	// 2. Disallowed role from Step 3 constraint
	const invalidRole = formSchema.safeParse({
		id: 1,
		email: "alex@clinic.org",
		role: "staff",
		clinicId: "123e4567-e89b-12d3-a456-426614174000",
	});
	expect(invalidRole.success).toBe(false);

	// 3. Invalid email from Step 2 constraint
	const invalidEmail = formSchema.safeParse({
		id: 1,
		email: "not-an-email",
		role: "admin",
		clinicId: "123e4567-e89b-12d3-a456-426614174000",
	});
	expect(invalidEmail.success).toBe(false);
	if (!invalidEmail.success) {
		expect(invalidEmail.error?.issues[0]?.message).toBe(
			"Invalid organization email",
		);
	}
});

test("Composition: Interleaving .pick() and .omit() with refineSchema", () => {
	const userProfileSchema = z.object({
		id: z.number(),
		username: z.string(),
		passwordHash: z.string(),
		bio: z.string().optional(),
		website: z.string().optional(),
	});

	// Refine, then pick, then refine again
	const step1 = refineSchema(userProfileSchema, (fields) => ({
		username: fields.username.min(3, { error: "Username min 3 chars" }),
		bio: fields.bio.max(160, { error: "Bio max 160 chars" }),
	}));

	// Public profile: omit passwordHash and id
	const publicProfile = step1.omit({ passwordHash: true });

	const step2 = refineSchema(publicProfile, (fields) => ({
		website: fields.website.url({ error: "Invalid website URL" }),
	}));

	// 1. Valid public profile
	const valid = step2.safeParse({
		id: 42,
		username: "developer",
		bio: "Building cool tools",
		website: "https://example.com",
	});
	expect(valid.success).toBe(true);

	// 2. Excluded passwordHash is not in the shape
	expect("passwordHash" in step2.shape).toBe(false);

	// 3. Inherited username validation from step 1
	const invalidUsername = step2.safeParse({
		id: 42,
		username: "ab",
	});
	expect(invalidUsername.success).toBe(false);
	if (!invalidUsername.success) {
		expect(invalidUsername.error?.issues[0]?.message).toBe(
			"Username min 3 chars",
		);
	}

	// 4. Website validation from step 2
	const invalidUrl = step2.safeParse({
		id: 42,
		username: "validuser",
		website: "not-a-valid-url",
	});
	expect(invalidUrl.success).toBe(false);
	if (!invalidUrl.success) {
		expect(invalidUrl.error?.issues[0]?.message).toBe("Invalid website URL");
	}
});

test("Composition: String transformations and chaining (trim, toLowerCase, min, max)", () => {
	const schema = z.object({
		username: z.string().optional(),
		slug: z.string(),
	});

	const refined = refineSchema(schema, (fields) => ({
		username: fields.username
			.trim()
			.toLowerCase()
			.min(3, { error: "Username must be at least 3 chars" })
			.max(20, { error: "Username cannot exceed 20 chars" }),
		slug: fields.slug.trim().toLowerCase(),
	}));

	// 1. Valid parsed transformation
	const result = refined.parse({
		username: "  JohnDoe  ",
		slug: "  MY-BLOG-POST  ",
	});
	expect(result.username).toBe("johndoe");
	expect(result.slug).toBe("my-blog-post");

	// 2. Length check after trimming
	const tooShort = refined.safeParse({
		username: "  ab  ",
		slug: "slug",
	});
	expect(tooShort.success).toBe(false);
	if (!tooShort.success) {
		expect(tooShort.error?.issues[0]?.message).toBe(
			"Username must be at least 3 chars",
		);
	}
});
