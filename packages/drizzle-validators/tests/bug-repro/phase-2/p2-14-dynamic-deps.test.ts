import { expect, test } from "./_helpers";
import { generateSchemas } from "../../../src/schema-generator";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// P2-14: the dependency fingerprint captured by the esbuild metafile only
// saw STATICALLY import-ed modules. A schema that pulled a table in via
// `await import("./extra.ts")` added that file to the bundle — but NOT to
// the cache key — so edits to it were served stale from the disk cache
// forever. Dynamically-imported project files now join depPaths.

function tmpProject(name: string): string {
	const dir = join(
		process.cwd(),
		"node_modules",
		`.tmp-p2-dyn-${name}-${process.pid}-${randomUUID().slice(0, 6)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

const schemaWithDyn = `
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
const m = await import("./extra.ts");
export const users = sqliteTable("users", {
	id: integer("id").primaryKey(),
	name: text("name"),
});
export const extra = m.extra;
`;

const EXTRA_V1 = `
import { sqliteTable, integer } from "drizzle-orm/sqlite-core";
export const extra = sqliteTable("extra", { id: integer("id") });
`;

test("P2-14: dynamically imported project file lands in depPaths", async () => {
	const root = tmpProject("dep");
	try {
		writeFileSync(join(root, "schema.ts"), schemaWithDyn);
		writeFileSync(join(root, "extra.ts"), EXTRA_V1);
		const data = await generateSchemas({
			absoluteSchemaPath: join(root, "schema.ts"),
			schemaPath: "./schema.ts",
			tmpDir: join(root, "node_modules", ".drizzle-validators", "tmp"),
			viteRoot: root,
			tables: undefined,
			moduleId: "virtual:drizzle-validators",
		});
		expect(data.tableCodes.has("users")).toBe(true);
		const extraDep = data.depPaths.find((p) => p.endsWith("extra.ts"));
		expect(extraDep).toBeDefined();
		// and its content participates: hashing it yields the recorded hash
		const { hashInputFiles } = await import("../../../src/cache");
		const h1 = await hashInputFiles(data.depPaths);
		writeFileSync(join(root, "extra.ts"), EXTRA_V1 + "\n");
		const h2 = await hashInputFiles(data.depPaths);
		expect(h1).not.toBe(h2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 20000);
