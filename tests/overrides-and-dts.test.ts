import { expect, test } from "bun:test";
import { drizzleZodVirtual } from "../src/plugin";
import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";

test("generates and writes schema and .d.ts files accurately", async () => {
	const outputPath = "./.drizzle-zod-generated/override-test.ts";
	const plugin = drizzleZodVirtual({
		schemaPath: "./tests/fixtures/override-schemas.ts",
		outputPath,
	});

	// Trigger load
	const code = (await (plugin as any).load("\0virtual:drizzle-zod")) as string;
	expect(code).toBeDefined();

	// Check output schema file exists
	const absOutputPath = resolve(process.cwd(), outputPath);
	expect(existsSync(absOutputPath)).toBe(true);

	const generatedCode = readFileSync(absOutputPath, "utf-8");
	expect(generatedCode).toContain("export const usersWithOverridesInsertSchema =");
	expect(generatedCode).toContain("export const usersWithOverridesSelectSchema =");
	expect(generatedCode).toContain("export const usersWithOverridesUpdateSchema =");

	// Check output .d.ts file exists
	const absDtsPath = resolve(process.cwd(), ".drizzle-zod-generated/virtual-drizzle-zod.d.ts");
	expect(existsSync(absDtsPath)).toBe(true);

	const dtsContent = readFileSync(absDtsPath, "utf-8");
	expect(dtsContent).toContain("declare module 'virtual:drizzle-zod'");
	expect(dtsContent).toContain("usersWithOverridesInsertSchema");
	expect(dtsContent).toContain("usersWithOverridesSelectSchema");
	expect(dtsContent).toContain("usersWithOverridesUpdateSchema");
});
