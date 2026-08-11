import { expect, test } from "bun:test";
import { drizzleZodVirtual } from "../src/plugin";
import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";

test("generates and writes split schema files and .d.ts accurately", async () => {
	const outputPath = "./.drizzle-zod-generated/override-test";
	const plugin = drizzleZodVirtual({
		schemaPath: "./tests/fixtures/override-schemas.ts",
		outputPath,
	});

	// Trigger load
	const code = (await (plugin as any).load("\0virtual:drizzle-zod")) as string;
	expect(code).toBeDefined();

	// Check per-table file exists
	const absTableFile = resolve(
		process.cwd(),
		outputPath,
		"usersWithOverrides.ts",
	);
	expect(existsSync(absTableFile)).toBe(true);

	const tableCode = readFileSync(absTableFile, "utf-8");
	expect(tableCode).toContain("export const usersWithOverridesInsertSchema =");
	expect(tableCode).toContain("export const usersWithOverridesSelectSchema =");
	expect(tableCode).toContain("export const usersWithOverridesUpdateSchema =");

	// Check barrel index.ts exists and re-exports
	const absBarrel = resolve(process.cwd(), outputPath, "index.ts");
	expect(existsSync(absBarrel)).toBe(true);

	const barrelCode = readFileSync(absBarrel, "utf-8");
	expect(barrelCode).toContain("export * from './usersWithOverrides'");

	// Check output .d.ts file exists
	const absDtsPath = resolve(
		process.cwd(),
		outputPath,
		"virtual-drizzle-zod.d.ts",
	);
	expect(existsSync(absDtsPath)).toBe(true);

	const dtsContent = readFileSync(absDtsPath, "utf-8");
	expect(dtsContent).toContain("declare module 'virtual:drizzle-zod'");
	expect(dtsContent).toContain("usersWithOverridesInsertSchema");
	expect(dtsContent).toContain("usersWithOverridesSelectSchema");
	expect(dtsContent).toContain("usersWithOverridesUpdateSchema");
});

test("generates single file when splitByTable is false", async () => {
	const outputPath = "./.drizzle-zod-generated/single-file-test.ts";
	const plugin = drizzleZodVirtual({
		schemaPath: "./tests/fixtures/override-schemas.ts",
		outputPath,
		splitByTable: false,
	});

	const code = (await (plugin as any).load("\0virtual:drizzle-zod")) as string;
	expect(code).toBeDefined();

	const absOutputPath = resolve(process.cwd(), outputPath);
	expect(existsSync(absOutputPath)).toBe(true);

	const generatedCode = readFileSync(absOutputPath, "utf-8");
	expect(generatedCode).toContain(
		"export const usersWithOverridesInsertSchema =",
	);
	expect(generatedCode).toContain(
		"export const usersWithOverridesSelectSchema =",
	);
	expect(generatedCode).toContain(
		"export const usersWithOverridesUpdateSchema =",
	);
});
