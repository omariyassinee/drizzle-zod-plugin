import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "../src/cli";

test("CLI --help displays help without errors", async () => {
	let output = "";
	const originalLog = console.log;
	console.log = (...args) => {
		output += args.join(" ") + "\n";
	};

	try {
		await runCli(["--help"]);
		expect(output).toContain("vdz - CLI for Drizzle Zod Virtual Plugin");
		expect(output).toContain("bunx vdz generate");
	} finally {
		console.log = originalLog;
	}
});

test("CLI --version displays version without errors", async () => {
	let output = "";
	const originalLog = console.log;
	console.log = (...args) => {
		output += args.join(" ") + "\n";
	};

	try {
		await runCli(["--version"]);
		expect(output).toContain("vdz v0.1.4");
	} finally {
		console.log = originalLog;
	}
});

test("CLI generate creates schemas with splitByTable", async () => {
	const outDir = "./.drizzle-zod-generated/cli-test-split";
	rmSync(outDir, { recursive: true, force: true });

	await runCli([
		"generate",
		"--schema",
		"./tests/fixtures/complex-schemas.ts",
		"--output",
		outDir,
	]);

	const absBarrel = resolve(process.cwd(), outDir, "index.ts");
	expect(existsSync(absBarrel)).toBe(true);

	const mod = await import(pathToFileURL(absBarrel).href);
	expect(mod.pgComplexTableInsertSchema).toBeDefined();
	expect(mod.mysqlComplexTableInsertSchema).toBeDefined();
	expect(mod.sqliteComplexTableInsertSchema).toBeDefined();

	const validPg = mod.pgComplexTableInsertSchema.parse({
		tags: ["test"],
		role: "admin",
	});
	expect(validPg.role).toBe("admin");
});

test("CLI generate creates single file when --no-split is passed", async () => {
	const outFile = "./.drizzle-zod-generated/cli-single-file.ts";
	rmSync(outFile, { force: true });

	await runCli([
		"--schema",
		"./tests/fixtures/complex-schemas.ts",
		"--output",
		outFile,
		"--no-split",
	]);

	const absFile = resolve(process.cwd(), outFile);
	expect(existsSync(absFile)).toBe(true);

	const mod = await import(pathToFileURL(absFile).href);
	expect(mod.pgComplexTableInsertSchema).toBeDefined();
	expect(mod.mysqlComplexTableSelectSchema).toBeDefined();
});

test("CLI generate respects --tables filter", async () => {
	const outDir = "./.drizzle-zod-generated/cli-filtered-test";
	rmSync(outDir, { recursive: true, force: true });

	await runCli([
		"generate",
		"--schema",
		"./tests/fixtures/complex-schemas.ts",
		"--output",
		outDir,
		"--tables",
		"mysqlComplexTable",
	]);

	const absTable = resolve(process.cwd(), outDir, "mysqlComplexTable.ts");
	const absOther = resolve(process.cwd(), outDir, "pgComplexTable.ts");

	expect(existsSync(absTable)).toBe(true);
	expect(existsSync(absOther)).toBe(false);

	const mod = await import(pathToFileURL(absTable).href);
	expect(mod.mysqlComplexTableInsertSchema).toBeDefined();
});
