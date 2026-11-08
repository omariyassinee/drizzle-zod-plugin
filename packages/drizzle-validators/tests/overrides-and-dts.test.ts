import { expect, test } from "bun:test";
import { drizzleValidators } from "../src/plugin";
import { resolve } from "node:path";
import { readFileSync, existsSync, rmSync } from "node:fs";

test("generates and writes split schema files and .d.ts accurately", async () => {
	const outputPath = "./.drizzle-validators-generated/override-test";

	rmSync(resolve(process.cwd(), outputPath), { recursive: true, force: true });
	const plugin = drizzleValidators("zod", {
		schemaPath: "./tests/fixtures/override-schemas.ts",
		outputPath,
	});

	// Trigger load
	const code = (await (plugin as any).load("\0virtual:drizzle-validators")) as string;
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
	expect(barrelCode).toContain(
		"export { usersWithOverridesInsertSchema } from './usersWithOverrides'",
	);
	expect(barrelCode).toContain(
		"export { usersWithOverridesSelectSchema } from './usersWithOverrides'",
	);
	expect(barrelCode).toContain(
		"export { usersWithOverridesUpdateSchema } from './usersWithOverrides'",
	);

	// Default: types come from the hidden @types shim — no project-tree d.ts
	const absDtsPath = resolve(
		process.cwd(),
		outputPath,
		"virtual-drizzle-validators.d.ts",
	);
	expect(existsSync(absDtsPath)).toBe(false);
	const shimPath = resolve(
		process.cwd(),
		"node_modules/@types/virtual-drizzle-validators/index.d.ts",
	);
	expect(existsSync(shimPath)).toBe(true);
	const shimContent = readFileSync(shimPath, "utf-8");
	expect(shimContent).toContain("declare module 'virtual:drizzle-validators'");

	const dtsContent = shimContent;
	expect(dtsContent).toContain("declare module 'virtual:drizzle-validators'");
	expect(dtsContent).toContain("usersWithOverridesInsertSchema");
	expect(dtsContent).toContain("usersWithOverridesSelectSchema");
	expect(dtsContent).toContain("usersWithOverridesUpdateSchema");
});

test("generates single file when splitByTable is false", async () => {
	const outputPath = "./.drizzle-validators-generated/single-file-test.ts";
	const plugin = drizzleValidators("zod", {
		schemaPath: "./tests/fixtures/override-schemas.ts",
		outputPath,
		splitByTable: false,
	});

	const code = (await (plugin as any).load("\0virtual:drizzle-validators")) as string;
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

test("multi-table split schema barrel index.ts does not cause TS2308 ambiguity errors and typechecks cleanly", async () => {
	const outputPath = "./.drizzle-validators-generated/barrel-multi-table-test";
	const plugin = drizzleValidators("zod", {
		schemaPath: "./tests/fixtures/complex-schemas.ts",
		bufferAs: "keep",
		outputPath,
	});

	await (plugin as any).load("\0virtual:drizzle-validators");

	const absBarrel = resolve(process.cwd(), outputPath, "index.ts");
	expect(existsSync(absBarrel)).toBe(true);

	const barrelCode = readFileSync(absBarrel, "utf-8");
	// Ensure barrel does NOT use wildcard re-exports which cause TS2308 collisions across tables
	expect(barrelCode).not.toContain("export * from");
	expect(barrelCode).toContain(
		"export { pgComplexTableInsertSchema } from './pgComplexTable'",
	);
	expect(barrelCode).toContain(
		"export { mysqlComplexTableInsertSchema } from './mysqlComplexTable'",
	);

	// Run TypeScript compiler on the generated barrel file to verify no TS2308 errors
	const proc = Bun.spawnSync([
		process.execPath,
		"x",
		"tsc",
		"--noEmit",
		"--moduleResolution",
		"bundler",
		"--target",
		"esnext",
		"--module",
		"preserve",
		"--types",
		"bun",
		absBarrel,
	]);
	expect(proc.exitCode).toBe(0);
}, 60000);
