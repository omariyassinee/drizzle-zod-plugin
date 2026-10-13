import { expect, test } from "bun:test";
import { resolveSchemaPath } from "../src/drizzle-config";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("returns explicit schemaPath directly when provided", async () => {
	const result = await resolveSchemaPath({
		schemaPath: "./src/db/schema.ts",
		projectRoot: process.cwd(),
	});
	expect(result).toBe("./src/db/schema.ts");
});

test("auto-detects schema path from drizzle.config.ts (relative to config dir)", async () => {
	const tmpDir = join(process.cwd(), "node_modules", ".tmp-drizzle-config-test-1");
	mkdirSync(tmpDir, { recursive: true });

	try {
		writeFileSync(
			join(tmpDir, "drizzle.config.ts"),
			`export default { schema: './src/schema.ts', dialect: 'postgresql' };`,
		);

		const resolved = await resolveSchemaPath({ projectRoot: tmpDir });
		// Relative schema paths resolve against the CONFIG FILE'S directory
		// (drizzle-kit behavior — required for monorepo layouts).
		expect(resolved).toBe(join(tmpDir, "src", "schema.ts"));
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("auto-detects schema path from drizzle.config.json", async () => {
	const tmpDir = join(process.cwd(), "node_modules", ".tmp-drizzle-config-test-json");
	mkdirSync(tmpDir, { recursive: true });

	try {
		writeFileSync(
			join(tmpDir, "drizzle.config.json"),
			JSON.stringify({ schema: "./src/schema.ts", dialect: "postgresql" }),
		);

		const resolved = await resolveSchemaPath({ projectRoot: tmpDir });
		expect(resolved).toBe(join(tmpDir, "src", "schema.ts"));
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("absolute schema path from config passes through unchanged", async () => {
	const tmpDir = join(process.cwd(), "node_modules", ".tmp-drizzle-config-test-abs");
	mkdirSync(tmpDir, { recursive: true });

	try {
		const absoluteSchema = join(tmpDir, "schema.ts");
		writeFileSync(
			join(tmpDir, "drizzle.config.ts"),
			`export default { schema: ${JSON.stringify(absoluteSchema)} };`,
		);

		const resolved = await resolveSchemaPath({ projectRoot: tmpDir });
		expect(resolved).toBe(absoluteSchema);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("throws informative error when no schemaPath provided and no drizzle.config exists", async () => {
	const tmpDir = join(process.cwd(), "node_modules", ".tmp-drizzle-config-test-2");
	mkdirSync(tmpDir, { recursive: true });

	try {
		await expect(resolveSchemaPath({ projectRoot: tmpDir })).rejects.toThrow(
			/No schemaPath provided, and no drizzle config file found/,
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("throws informative error when drizzle.config schema is string[]", async () => {
	const tmpDir = join(process.cwd(), "node_modules", ".tmp-drizzle-config-test-3");
	mkdirSync(tmpDir, { recursive: true });

	try {
		writeFileSync(
			join(tmpDir, "drizzle.config.ts"),
			`export default { schema: ['./src/a.ts', './src/b.ts'] };`,
		);

		await expect(resolveSchemaPath({ projectRoot: tmpDir })).rejects.toThrow(
			/is a string\[\]/,
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("throws informative error when drizzle.config has missing/invalid schema field", async () => {
	const tmpDir = join(process.cwd(), "node_modules", ".tmp-drizzle-config-test-4");
	mkdirSync(tmpDir, { recursive: true });

	try {
		writeFileSync(
			join(tmpDir, "drizzle.config.ts"),
			`export default { dialect: 'postgresql' };`,
		);

		await expect(resolveSchemaPath({ projectRoot: tmpDir })).rejects.toThrow(
			/has no valid "schema" field/,
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});
