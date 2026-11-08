import { expect, test } from "./_helpers";
import { createServer } from "vite";
import { drizzleValidators } from "../../../src/plugin";
import { getResolvedPaths } from "../../../src/paths";
import {
	existsSync,
	mkdirSync,
	symlinkSync,
	rmSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// P2-12: the internal tmp scratch dir
// (node_modules/.drizzle-validators/tmp) previously had NO explicit
// close-time cleanup — the plugin claimed "configureServer runs on close"
// but nothing bound that lifecycle, so the dir survived shutdowns. The
// plugin now binds the cleanup to the dev server's own "close" event.

// P2-13: renaming drizzle.config.ts (e.g. to drizzle.config.prod.ts, or
// simply replacing it) left the watcher bound to the DELETED path — every
// subsequent config/schema change was silently ignored until a dev-server
// restart. The watcher now re-binds to the new config path automatically
// and regenerates.

const schemaA = `
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
export const usersA = sqliteTable("users_a", {
	id: text("id").primaryKey(),
	name: text("name"),
});
`;

const schemaB = `
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
export const usersB = sqliteTable("users_b", {
	id: text("id").primaryKey(),
	age: text("age"),
});
`;

const VIRTUAL_MODULE_ID = "virtual:drizzle-validators";

/**
 * Fixture project OUTSIDE the repo's node_modules tree — vite's default
 * chokidar ignore pattern ("node_modules" globs) would otherwise swallow
 * every file event for a fixture living underneath it. Module resolution
 * for drizzle-orm/zod is provided by symlinking the repo's node_modules in.
 */
function tmpFixtureProject(name: string): string {
	const dir = join(
		"/tmp",
		"opencode",
		`.p2-plugin-${name}-${randomUUID().slice(0, 6)}`,
	);
	mkdirSync(dir, { recursive: true });
	symlinkSync(
		join(process.cwd(), "node_modules"),
		join(dir, "node_modules"),
		"dir",
	);
	return dir;
}

const CONFIG_V1 = `export default { schema: './schema-a.ts', dialect: 'sqlite' };`;
const CONFIG_V2 = `export default { schema: './schema-b.ts', dialect: 'sqlite' };`;

test("P2-12: internal tmp dir does not outlive the dev session (explicit close cleanup)", async () => {
	const root = join(
		"/tmp",
		"opencode",
		`.p2-plugin-close-${randomUUID().slice(0, 6)}`,
	);
	mkdirSync(root, { recursive: true });
	symlinkSync(
		join(process.cwd(), "node_modules"),
		join(root, "node_modules"),
		"dir",
	);
	writeFileSync(join(root, "schema.ts"), schemaA);
	const plugin = drizzleValidators("zod", { schemaPath: "./schema.ts" });
	const server = await createServer({
		root: root,
		plugins: [plugin],
		server: { middlewareMode: true, ws: false },
		optimizeDeps: { noDiscovery: true },
		logLevel: "silent",
		resolve: {
			alias: [
				{
					find: "@vacuus/drizzle-validators/refine",
					replacement: resolve(process.cwd(), "src/refine.ts"),
				},
			],
		},
	} as Parameters<typeof createServer>[0]);
	try {
		const code = (await server.ssrLoadModule(
			VIRTUAL_MODULE_ID,
		)) as Record<string, any>;
		expect(code["usersAInsertSchema"]).toBeDefined();
		// the generation ran AND already cleaned up after itself: the tmp
		// dir is removed immediately after each import, not at session end
		const paths = getResolvedPaths(
			join(root, "schema.ts"),
			{},
			root,
			true,
		);
		expect(existsSync(paths.tmpDir)).toBe(false);
	} finally {
		await server.close();
	}
	// after close, the plugin's close-bound cleanup must have removed it
	const paths = getResolvedPaths(
		join(root, "schema.ts"),
		{},
		root,
		true,
	);
	// poll for the async cleanup
	for (let i = 0; i < 40; i++) {
		if (!existsSync(paths.tmpDir)) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	expect(existsSync(paths.tmpDir)).toBe(false);
	rmSync(root, { recursive: true, force: true });
});

test("P2-13: config rename re-binds the watcher and regenerates with the new schema", async () => {
	const root = tmpFixtureProject("rename");
	writeFileSync(join(root, "drizzle.config.ts"), CONFIG_V1);
	writeFileSync(join(root, "schema-a.ts"), schemaA);
	writeFileSync(join(root, "schema-b.ts"), schemaB);
	const plugin = drizzleValidators("zod");
	const server = await createServer({
		root,
		plugins: [plugin],
		server: { middlewareMode: true, ws: false },
		optimizeDeps: { noDiscovery: true },
		logLevel: "silent",
		watch: { usePolling: true, interval: 50 },
		resolve: {
			alias: [
				{
					find: "@vacuus/drizzle-validators/refine",
					replacement: resolve(process.cwd(), "src/refine.ts"),
				},
			],
		},
	} as Parameters<typeof createServer>[0]);
	try {
		const first = (await server.ssrLoadModule(
			VIRTUAL_MODULE_ID,
		)) as Record<string, any>;
		expect(first["usersAInsertSchema"]).toBeDefined();

		// swap the config to point at schema-b (rename flow: unlink + add)
		rmSync(join(root, "drizzle.config.ts"));
		writeFileSync(join(root, "drizzle.config.ts"), CONFIG_V2);

		// wait for the plugin to notice and re-generate with schema-b
		let second: Record<string, any> | null = null;
		for (let i = 0; i < 80; i++) {
			await new Promise((r) => setTimeout(r, 100));
			try {
				const mod = (await server.ssrLoadModule(
					VIRTUAL_MODULE_ID,
				)) as Record<string, any>;
				if (mod["usersBInsertSchema"]) {
					second = mod;
					break;
				}
			} catch {
				// mid-reload — keep polling
			}
		}
		expect(second?.["usersBInsertSchema"]).toBeDefined();
	} finally {
		await server.close().catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
}, 20000);
