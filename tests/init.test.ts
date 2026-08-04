import { expect, test } from "bun:test";
import { loadModule } from "../src/module";

test("generates and evaluates schemas for 16 complex tables", async () => {
	const mod = (await loadModule("virtual:drizzle-zod")) as Record<string, any>;
	expect(mod).toBeDefined();

	// 16 tables * 3 (Insert, Select, Update) = 48 schemas
	const tableNames = [
		"auditLogs",
		"categories",
		"comments",
		"files",
		"notifications",
		"orderItems",
		"orders",
		"postCategories",
		"posts",
		"products",
		"profiles",
		"settings",
		"subscriptions",
		"tags",
		"teams",
		"users",
	];

	for (const name of tableNames) {
		expect(mod[`${name}InsertSchema`]).toBeDefined();
		expect(mod[`${name}SelectSchema`]).toBeDefined();
		expect(mod[`${name}UpdateSchema`]).toBeDefined();
	}

	// Runtime Zod validation test on generated schemas
	const usersInsertSchema = mod.usersInsertSchema;
	const validUser = usersInsertSchema.parse({
		name: "Alice",
		email: "alice@example.com",
	});
	expect(validUser.name).toBe("Alice");
	expect(validUser.email).toBe("alice@example.com");

	const profilesInsertSchema = mod.profilesInsertSchema;
	const validProfile = profilesInsertSchema.parse({
		userId: "123e4567-e89b-12d3-a456-426614174000",
		role: "admin",
	});
	expect(validProfile.role).toBe("admin");

	const ordersInsertSchema = mod.ordersInsertSchema;
	const validOrder = ordersInsertSchema.parse({
		customerId: "987e6543-e21b-12d3-a456-426614174000",
		totalAmount: "99.99",
		status: "active",
	});
	expect(validOrder.status).toBe("active");
});
