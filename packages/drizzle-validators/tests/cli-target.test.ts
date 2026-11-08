import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { runCli } from "../src/cli";

// --target threads through the CLI: files are written with the target's
// import line, the per-target d.ts name, and no refineZSchema (zod-only).

test("CLI --target typebox emits typebox code and per-target d.ts", async () => {
	const outDir = "./.drizzle-validators-generated/cli-target-typebox";
	rmSync(outDir, { recursive: true, force: true });

	await runCli([
		"generate",
		"--schema",
		"./tests/fixtures/adapter-table.ts",
		"--output",
		outDir,
		"--target",
		"typebox",
	]);

	const tableFile = resolve(process.cwd(), outDir, "tbUsers.ts");
	expect(existsSync(tableFile)).toBe(true);
	const code = readFileSync(tableFile, "utf-8");
	expect(code).toContain("import * as t from 'typebox'");
	expect(code).not.toContain("refineZSchema");

	expect(
		existsSync(
			resolve(
				process.cwd(),
				"node_modules/@types/virtual-drizzle-validators/index.d.ts",
			),
		),
	).toBe(true);

	rmSync(outDir, { recursive: true, force: true });
});

test("CLI --target valibot emits valibot code", async () => {
	const outDir = "./.drizzle-validators-generated/cli-target-valibot";
	rmSync(outDir, { recursive: true, force: true });

	await runCli([
		"generate",
		"--schema",
		"./tests/fixtures/adapter-table.ts",
		"--output",
		outDir,
		"--target",
		"valibot",
	]);

	const code = readFileSync(
		resolve(process.cwd(), outDir, "tbUsers.ts"),
		"utf-8",
	);
	expect(code).toContain("import * as v from 'valibot'");
	expect(
		existsSync(
			resolve(
				process.cwd(),
				"node_modules/@types/virtual-drizzle-validators/index.d.ts",
			),
		),
	).toBe(true);

	rmSync(outDir, { recursive: true, force: true });
});

test("CLI --target with an unknown value fails with exit code 1", async () => {
	let errOutput = "";
	const originalError = console.error;
	console.error = (...args) => {
		errOutput += `${args.join(" ")}\n`;
	};
	try {
		await runCli(["generate", "--target", "arktype"]);
		// Assert BEFORE restoring — runCli signals failure via process.exitCode.
		expect(process.exitCode).toBe(1);
	} finally {
		console.error = originalError;
		// bun keeps a sticky failure state when exitCode is set back to
		// undefined — restore the neutral 0 explicitly.
		process.exitCode = 0;
	}
	expect(errOutput).toContain('Unknown --target value "arktype"');
});
