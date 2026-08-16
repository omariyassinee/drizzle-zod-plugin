import { expect, test } from "bun:test";
import { z } from "zod";
import { refineSchema } from "../src/refine";

test("Zod 4 Error Formatting: z.flattenError with refined schemas", () => {
	const userSchema = z.object({
		username: z.string(),
		email: z.string(),
		age: z.number().optional(),
	});

	const refined = refineSchema(userSchema, (fields) => ({
		username: fields.username.min(3, { error: "Username must be at least 3 characters" }),
		email: fields.email.email({ error: "Invalid email format" }),
		age: fields.age.min(18, { error: "Must be 18 or older" }),
	}));

	const result = refined.safeParse({
		username: "ab",
		email: "not-an-email",
		age: 15,
	});

	expect(result.success).toBe(false);
	if (!result.success) {
		const flattened = z.flattenError(result.error);
		expect(flattened.fieldErrors.username).toBeDefined();
		expect(flattened.fieldErrors.username?.[0]).toBe("Username must be at least 3 characters");
		expect(flattened.fieldErrors.email?.[0]).toBe("Invalid email format");
		expect(flattened.fieldErrors.age?.[0]).toBe("Must be 18 or older");
	}
});

test("Zod 4 Error Formatting: z.treeifyError on nested refined shapes", () => {
	const clinicSchema = z.object({
		clinicName: z.string(),
		doctor: z.object({
			name: z.string(),
			licenseNumber: z.string(),
		}),
	});

	const refined = refineSchema(clinicSchema, (fields) => ({
		clinicName: fields.clinicName.min(2, { error: "Clinic name too short" }),
	}));

	const result = refined.safeParse({
		clinicName: "A",
		doctor: {
			name: "",
			licenseNumber: 123, // Invalid type
		},
	});

	expect(result.success).toBe(false);
	if (!result.success) {
		const tree = z.treeifyError(result.error);
		expect(tree.properties?.clinicName?.errors).toBeDefined();
		expect(tree.properties?.clinicName?.errors?.[0]).toBe("Clinic name too short");
		expect(tree.properties?.doctor?.properties?.licenseNumber?.errors).toBeDefined();
	}
});

test("Zod 4 Error Formatting: Dynamic error functions", () => {
	const productSchema = z.object({
		sku: z.string(),
		quantity: z.number(),
	});

	const refined = refineSchema(productSchema, (fields) => ({
		sku: fields.sku.min(5, {
			error: (issue) => `SKU code requires at least 5 chars (got ${issue.origin ?? "unknown"})`,
		}),
		quantity: fields.quantity.min(1, {
			error: () => "Quantity must be at least 1 unit",
		}),
	}));

	const result = refined.safeParse({
		sku: "SKU",
		quantity: 0,
	});

	expect(result.success).toBe(false);
	if (!result.success) {
		const skuError = result.error.issues.find((i) => i.path.includes("sku"));
		const qtyError = result.error.issues.find((i) => i.path.includes("quantity"));

		expect(skuError?.message).toContain("SKU code requires at least 5 chars");
		expect(qtyError?.message).toBe("Quantity must be at least 1 unit");
	}
});
