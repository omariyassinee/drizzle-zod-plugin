import { describe, expect, test, afterEach } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
	computeCacheKey,
	generatedEquals,
	hashInputFiles,
	loadCachedData,
	saveCachedData,
} from "../../src/cache";
import { drizzleValidators } from "../../src/plugin";
import { generateSchemas } from "../../src/schema-generator";

const TMP_ROOTS: string[] = [];

function createIsolatedProject(name: string): string {
	const dir = join(
		resolve(__dirname, "../../node_modules"),
		`.tmp-cache-stress-${name}-${process.pid}-${randomUUID().slice(0, 6)}`,
	);
	mkdirSync(dir, { recursive: true });
	symlinkSync(
		resolve(__dirname, "../../node_modules"),
		join(dir, "node_modules"),
		"dir",
	);
	TMP_ROOTS.push(dir);
	return dir;
}

afterEach(() => {
	while (TMP_ROOTS.length > 0) {
		const dir = TMP_ROOTS.pop()!;
		rmSync(dir, { recursive: true, force: true });
	}
});

const SAMPLE_SCHEMA = `
import { pgTable, serial, text } from "drizzle-orm/pg-core";
export const users = pgTable("users", {
	id: serial("id").primaryKey(),
	email: text("email").notNull(),
});
`;

describe("Chain 1: Disk Cache Hydration & Envelope Integrity", () => {
	test("C-01: saveCachedData + loadCachedData must preserve refineExportStatement and refineDtsStatement", async () => {
		const root = createIsolatedProject("c01");
		const schemaFile = join(root, "schema.ts");
		writeFileSync(schemaFile, SAMPLE_SCHEMA);

		const freshData = await generateSchemas({
			absoluteSchemaPath: schemaFile,
			schemaPath: "./schema.ts",
			tmpDir: join(root, ".tmp"),
			viteRoot: root,
			target: "zod",
		});

		// Precondition: fresh generation includes both statements
		expect(freshData.refineExportStatement).toBe(
			"export { refineZSchema } from 'drizzle-validators/refine'",
		);
		expect(freshData.refineDtsStatement).toContain("export const refineZSchema:");

		const key = computeCacheKey({
			projectRoot: root,
			absoluteSchemaPath: schemaFile,
			tables: undefined,
			moduleId: "virtual:drizzle-validators",
			target: "zod",
		});
		const inputsHash = await hashInputFiles(freshData.depPaths);
		expect(inputsHash).not.toBeNull();

		await saveCachedData(root, key, freshData, inputsHash!);
		const hydrated = await loadCachedData(root, key);

		expect(hydrated).not.toBeNull();
		// BUG TARGET: CacheEnvelope omits both fields in src/cache.ts
		expect(hydrated!.refineExportStatement).toBe(freshData.refineExportStatement);
		expect(hydrated!.refineDtsStatement).toBe(freshData.refineDtsStatement);
		expect(generatedEquals(freshData, hydrated)).toBe(true);
	});

	test("C-02: warm dev server restart (useCache: true) must NOT strip refineZSchema from per-table files and .d.ts", async () => {
		const root = createIsolatedProject("c02");
		const schemaFile = join(root, "schema.ts");
		writeFileSync(schemaFile, SAMPLE_SCHEMA);

		const pluginOpts = {
			schemaPath: "./schema.ts",
			outputPath: "./src/gen",
			useCache: true,
			emitRootDts: true,
		};

		// --- Session 1: Cold start (populates disk cache & writes files) ---
		const pluginCold = drizzleValidators("zod", pluginOpts) as any;
		pluginCold.configResolved({ root, command: "serve" });
		await pluginCold.load("\0virtual:drizzle-validators");

		const usersFile = join(root, "src/gen/users.ts");
		const dtsFile = join(root, "src/gen/virtual-drizzle-validators.d.ts");

		expect(readFileSync(usersFile, "utf8")).toContain("export { refineZSchema }");
		expect(readFileSync(dtsFile, "utf8")).toContain("export const refineZSchema:");

		// --- Session 2: New plugin instance (simulating Vite restart hitting disk cache) ---
		const pluginWarm = drizzleValidators("zod", pluginOpts) as any;
		pluginWarm.configResolved({ root, command: "serve" });
		await pluginWarm.load("\0virtual:drizzle-validators");

		// BUG TARGET: On disk cache hit, writeGeneratedFiles runs with hydrated data.
		// Because hydrated.refineExportStatement is undefined, users.ts and .d.ts get overwritten WITHOUT refineZSchema!
		const warmUsersCode = readFileSync(usersFile, "utf8");
		const warmDtsCode = readFileSync(dtsFile, "utf8");

		expect(warmUsersCode).toContain(
			"export { refineZSchema } from 'drizzle-validators/refine'",
		);
		expect(warmDtsCode).toContain("export const refineZSchema:");
	});

	test("C-03: warm dev server restart for target='valibot' must NOT strip refineVSchema", async () => {
		const root = createIsolatedProject("c03");
		writeFileSync(join(root, "schema.ts"), SAMPLE_SCHEMA);

		const pluginOpts = {
			schemaPath: "./schema.ts",
			outputPath: "./src/gen-valibot",
			useCache: true,
			emitRootDts: true,
		};

		const pluginCold = drizzleValidators("valibot", pluginOpts) as any;
		pluginCold.configResolved({ root, command: "serve" });
		await pluginCold.load("\0virtual:drizzle-validators");

		const pluginWarm = drizzleValidators("valibot", pluginOpts) as any;
		pluginWarm.configResolved({ root, command: "serve" });
		await pluginWarm.load("\0virtual:drizzle-validators");

		const warmTableCode = readFileSync(
			join(root, "src/gen-valibot/users.ts"),
			"utf8",
		);
		const warmDtsCode = readFileSync(
			join(root, "src/gen-valibot/virtual-drizzle-validators.d.ts"),
			"utf8",
		);

		expect(warmTableCode).toContain("export { refineVSchema }");
		expect(warmDtsCode).toContain("export const refineVSchema:");
	});

	test("C-04: generatedEquals must detect differences in refineExportStatement and refineDtsStatement", async () => {
		const root = createIsolatedProject("c04");
		const schemaFile = join(root, "schema.ts");
		writeFileSync(schemaFile, SAMPLE_SCHEMA);

		const base = await generateSchemas({
			absoluteSchemaPath: schemaFile,
			schemaPath: "./schema.ts",
			tmpDir: join(root, ".tmp"),
			viteRoot: root,
			target: "zod",
		});

		const stripped = {
			...base,
			refineExportStatement: undefined,
			refineDtsStatement: undefined,
		};

		// BUG TARGET: generatedEquals currently ignores refineExportStatement & refineDtsStatement
		expect(generatedEquals(base, stripped)).toBe(false);
	});
});
