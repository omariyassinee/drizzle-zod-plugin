import { expect, test } from "bun:test";
import { drizzleZodVirtual } from "../src/plugin";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";

test("generates valid Zod schemas for PostgreSQL, MySQL, and SQLite complex edge cases", async () => {
	const plugin = drizzleZodVirtual({
		schemaPath: "./tests/fixtures/complex-schemas.ts",
		outputPath: "./.drizzle-zod-generated/complex-test.ts",
	});

	// Trigger load to run the generator
	let code: string;
	try {
		code = (await (plugin as any).load("\0virtual:drizzle-zod")) as string;
	} catch (err: any) {
		console.error("Generator failed with error:", err.message);
		throw err;
	}

	expect(code).toBeDefined();
	expect(code).toContain(
		"export { insertSchema as mysqlComplexTableInsertSchema",
	);

	// Import generated barrel index.ts to test runtime Zod validation
	const absBarrel = resolve(
		process.cwd(),
		"./.drizzle-zod-generated/complex-test/index.ts",
	);
	expect(existsSync(absBarrel)).toBe(true);

	const mod = await import(pathToFileURL(absBarrel).href);

	// 1. Check schema exports exist for all tables (Insert, Select, Update)
	expect(mod.pgComplexTableInsertSchema).toBeDefined();
	expect(mod.pgComplexTableSelectSchema).toBeDefined();
	expect(mod.pgComplexTableUpdateSchema).toBeDefined();

	expect(mod.pgCompositePkTableInsertSchema).toBeDefined();
	expect(mod.pgCompositePkTableSelectSchema).toBeDefined();
	expect(mod.pgCompositePkTableUpdateSchema).toBeDefined();

	expect(mod.mysqlComplexTableInsertSchema).toBeDefined();
	expect(mod.mysqlComplexTableSelectSchema).toBeDefined();
	expect(mod.mysqlComplexTableUpdateSchema).toBeDefined();

	expect(mod.sqliteComplexTableInsertSchema).toBeDefined();
	expect(mod.sqliteComplexTableSelectSchema).toBeDefined();
	expect(mod.sqliteComplexTableUpdateSchema).toBeDefined();

	// 2. Validate PG Insert & Select Schema with complex types
	const pgValidInsert = mod.pgComplexTableInsertSchema.parse({
		tags: ["typescript", "drizzle"],
		role: "admin",
		inlineEnum: "a",
		pointTuple: [12.34, 56.78],
		pointXy: { x: 12.34, y: 56.78 },
		lineTuple: [1.0, 2.0, 3.0],
		inetCol: "192.168.1.1",
		jsonbCol: { foo: "hello", bar: 42 },
		bigintNum: 9007199254740991,
		bigintBig: 1234567890123456789n,
	});
	expect(pgValidInsert.role).toBe("admin");
	expect(pgValidInsert.tags).toEqual(["typescript", "drizzle"]);
	expect(pgValidInsert.pointTuple).toEqual([12.34, 56.78]);
	expect(pgValidInsert.pointXy).toEqual({ x: 12.34, y: 56.78 });
	expect(pgValidInsert.bigintNum).toBe(9007199254740991);
	expect(pgValidInsert.bigintBig).toBe(1234567890123456789n);

	// 3. Validate Composite PK Table Schema
	const pgCompInsert = mod.pgCompositePkTableInsertSchema.parse({
		tenantId: "123e4567-e89b-12d3-a456-426614174000",
		userId: 42,
	});
	expect(pgCompInsert.tenantId).toBe("123e4567-e89b-12d3-a456-426614174000");
	expect(pgCompInsert.userId).toBe(42);
	expect(pgCompInsert.role).toBeUndefined(); // optional in insert schema so DB default applies

	// 4. Validate MySQL Insert & Select Schema
	const mysqlValidInsert = mod.mysqlComplexTableInsertSchema.parse({
		status: "active",
		activeYear: 2026,
		config: { debug: true },
		flt: 3.14,
		dbl: Math.E,
		dec: "99.99",
	});
	expect(mysqlValidInsert.status).toBe("active");
	expect(mysqlValidInsert.activeYear).toBe(2026);
	expect(mysqlValidInsert.dec).toBe("99.99");

	// 5. Validate SQLite Insert & Select Schema
	const sqliteValidInsert = mod.sqliteComplexTableInsertSchema.parse({
		isFlag: true,
		ts: new Date(),
		enumField: "high",
		blobJson: { key: "val" },
		realVal: 10.5,
	});
	expect(sqliteValidInsert.isFlag).toBe(true);
	expect(sqliteValidInsert.enumField).toBe("high");
	expect(sqliteValidInsert.realVal).toBe(10.5);

	// 6. Validate Update Schemas accept partial inputs
	const pgUpdate = mod.pgComplexTableUpdateSchema.parse({
		role: "guest",
	});
	expect(pgUpdate.role).toBe("guest");
	expect(pgUpdate.tags).toBeUndefined();
});
