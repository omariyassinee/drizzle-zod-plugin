import { expect, test, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { handleRequest } from "../src/server/index";

// PG-C: Bun-native API playground. Verifies the `dv` CLI generated validators
// to disk, the refined schemas validate correctly, and the Bun server
// re-validates incoming requests with the same schemas.

const ROOT = process.cwd();
const GEN = join(ROOT, "src/generated-validators");

beforeAll(() => {
	// The `generate` script must have run (typecheck/test both run it first).
	if (!existsSync(join(GEN, "customers.ts"))) {
		throw new Error(
			"Run `bun run generate` first — generated validators missing.",
		);
	}
});

test("dv CLI generated validators to disk", () => {
	expect(existsSync(join(GEN, "customers.ts"))).toBe(true);
	expect(existsSync(join(GEN, "orders.ts"))).toBe(true);
	expect(existsSync(join(GEN, "index.ts"))).toBe(true);

	const customersSrc = readFileSync(join(GEN, "customers.ts"), "utf8");
	// Generated from the Drizzle table: email varchar(255), age integer, etc.
	expect(customersSrc).toContain("email");
	expect(customersSrc).toContain("fullName");
});

test("refined customer schema validates with error-map messages", async () => {
	const { createCustomerSchema } = (await import(
		"../src/shared/validators"
	)) as {
		createCustomerSchema: import("zod").ZodTypeAny;
	};

	// Valid customer
	const ok = createCustomerSchema.safeParse({
		email: "ada@example.com",
		fullName: "Ada Lovelace",
		age: 36,
		country: "US",
	});
	expect(ok.success).toBe(true);

	// Invalid: bad email, underage, bad country
	const bad = createCustomerSchema.safeParse({
		email: "nope",
		fullName: "A",
		age: 15,
		country: "USA",
	});
	expect(bad.success).toBe(false);
	if (!bad.success) {
		const issues = bad.error.issues;
		const messages = issues.map((i) => i.message);
		expect(messages).toContain("Please enter a valid email address");
		expect(messages).toContain("Customers must be 18+");
		expect(messages).toContain("Country must be exactly 2 letters");
	}
});

test("Bun server validates requests with the same schemas", async () => {
	// Valid customer creation
	const ok = await handleRequest(
		new Request("http://localhost/api/customers", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "grace@example.com",
				fullName: "Grace Hopper",
				age: 40,
				country: "US",
			}),
		}),
	);
	expect(ok.status).toBe(201);
	const okBody = (await ok.json()) as {
		ok: boolean;
		customer: { email: string };
	};
	expect(okBody.ok).toBe(true);
	expect(okBody.customer.email).toBe("grace@example.com");

	// Invalid -> 400 with flattened error map
	const bad = await handleRequest(
		new Request("http://localhost/api/customers", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "nope",
				fullName: "A",
				age: 15,
				country: "USA",
			}),
		}),
	);
	expect(bad.status).toBe(400);
	const badBody = (await bad.json()) as {
		error: { fieldErrors: Record<string, string[]> };
	};
	expect(badBody.error.fieldErrors.email?.[0]).toBe(
		"Please enter a valid email address",
	);
	expect(badBody.error.fieldErrors.age?.[0]).toBe("Customers must be 18+");

	// Duplicate email -> 409
	const dup = await handleRequest(
		new Request("http://localhost/api/customers", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "grace@example.com",
				fullName: "Grace Hopper 2",
				age: 41,
				country: "US",
			}),
		}),
	);
	expect(dup.status).toBe(409);

	// Order with invalid status enum -> 400
	const badOrder = await handleRequest(
		new Request("http://localhost/api/orders", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				customerId: crypto.randomUUID(),
				status: "bogus",
				totalCents: 0,
			}),
		}),
	);
	expect(badOrder.status).toBe(400);
	const badOrderBody = (await badOrder.json()) as {
		error: { fieldErrors: Record<string, string[]> };
	};
	expect(badOrderBody.error.fieldErrors.status?.[0]).toBe(
		"Selected order status is not permitted",
	);
	expect(badOrderBody.error.fieldErrors.totalCents?.[0]).toBe(
		"Order total must be at least 1 cent",
	);
});
