import { expect, test } from "bun:test";
import { loadModule } from "../src/module";

test("generates and evaluates schemas for complex tables", async () => {
	const mod = (await loadModule("virtual:drizzle-zod")) as Record<string, any>;
	expect(mod).toBeDefined();

	const tableNames = [
		"pgComplexTable",
		"pgCompositePkTable",
		"mysqlComplexTable",
		"sqliteComplexTable",
	];

	for (const name of tableNames) {
		expect(mod[`${name}InsertSchema`]).toBeDefined();
		expect(mod[`${name}SelectSchema`]).toBeDefined();
		expect(mod[`${name}UpdateSchema`]).toBeDefined();
	}

	const pgInsertSchema = mod.pgComplexTableInsertSchema;
	const validPg = pgInsertSchema.parse({
		tags: ["ts", "drizzle"],
		role: "admin",
	});
	expect(validPg.role).toBe("admin");
});
