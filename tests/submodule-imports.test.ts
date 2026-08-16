import { expect, test } from "bun:test";
import { loadModule } from "../src/module";

test("loads table-specific sub-module (virtual:drizzle-zod/pgComplexTable)", async () => {
	const pgMod = (await loadModule("virtual:drizzle-zod/pgComplexTable")) as Record<
		string,
		any
	>;

	expect(pgMod).toBeDefined();

	// Generic short schema exports and refineSchema
	expect(pgMod.insertSchema).toBeDefined();
	expect(pgMod.selectSchema).toBeDefined();
	expect(pgMod.updateSchema).toBeDefined();
	expect(pgMod.refineSchema).toBeDefined();

	// Make sure table-prefixed duplicate names are NOT exported in sub-modules
	expect(pgMod.pgComplexTableInsertSchema).toBeUndefined();
	expect(pgMod.pgComplexTableSelectSchema).toBeUndefined();
	expect(pgMod.pgComplexTableUpdateSchema).toBeUndefined();

	// Validate functionality of generic short schemas
	const validPg = pgMod.insertSchema.parse({
		tags: ["ts", "drizzle"],
		role: "admin",
	});
	expect(validPg.role).toBe("admin");

	// Validate refineSchema on virtual module schema
	const customPg = pgMod.refineSchema(pgMod.insertSchema, (fields: any) => ({
		role: fields.role.setError("Custom role error"),
	}));
	expect(customPg.safeParse({ tags: ["ts"], role: "invalid" }).success).toBe(
		false,
	);
});

test("loads table-specific sub-module (virtual:drizzle-zod/mysqlComplexTable)", async () => {
	const mysqlMod = (await loadModule("virtual:drizzle-zod/mysqlComplexTable")) as Record<
		string,
		any
	>;

	expect(mysqlMod).toBeDefined();
	expect(mysqlMod.insertSchema).toBeDefined();
	expect(mysqlMod.mysqlComplexTableInsertSchema).toBeUndefined();

	const validMysql = mysqlMod.insertSchema.parse({
		status: "active",
		activeYear: 2026,
	});
	expect(validMysql.status).toBe("active");
});
