import { expect, test, afterAll } from "bun:test";
import { build } from "vite";
import { createServer } from "vite";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { drizzleValidators } from "drizzle-validators";

// PG4: polyglot-dual-plugin — two plugin instances (zod + valibot, custom
// moduleIds) in one project: cache isolation, emitRootDts, dynamic-import
// dep tracking (P2-14), stale-file reconciliation (P2-10), and HMR no-op
// suppression over a live dev session.

const ROOT = process.cwd();
const GEN_ZOD = join(ROOT, "src/gen/zod");
const GEN_VALIBOT = join(ROOT, "src/gen/valibot");
const ROOT_SCHEMA = join(ROOT, "src/db/root-schema.ts");
const BILLING = join(ROOT, "src/db/billing-tables.ts");

const originalRootSchema = readFileSync(ROOT_SCHEMA, "utf-8");
const originalBilling = readFileSync(BILLING, "utf-8");

afterAll(() => {
	writeFileSync(ROOT_SCHEMA, originalRootSchema);
	writeFileSync(BILLING, originalBilling);
	rmSync(join(ROOT, "src/gen"), { recursive: true, force: true });
	rmSync(join(ROOT, "dist"), { recursive: true, force: true });
});

async function buildOnce() {
	await build({ logLevel: "silent" });
}

test("dual instances generate isolated outputs + per-moduleId d.ts", async () => {
	rmSync(join(ROOT, "src/gen"), { recursive: true, force: true });
	await buildOnce();

	// zod barrel uses prefixed names; valibot barrel uses generic names
	const zodIndex = readFileSync(join(GEN_ZOD, "index.ts"), "utf-8");
	expect(zodIndex).toContain("accountsInsertSchema");
	const valibotIndex = readFileSync(join(GEN_VALIBOT, "accounts.ts"), "utf-8");
	expect(valibotIndex).toContain("import * as v from 'valibot'");

	// emitRootDts: one declaration file per instance, each naming ITS module id
	const zodDts = readFileSync(
		join(GEN_ZOD, "virtual-validators-zod.d.ts"),
		"utf-8",
	);
	expect(zodDts).toContain("declare module 'virtual:validators-zod'");
	const valibotDts = readFileSync(
		join(GEN_VALIBOT, "virtual-validators-valibot.d.ts"),
		"utf-8",
	);
	expect(valibotDts).toContain("declare module 'virtual:validators-valibot'");

	// hidden @types shims: one per moduleId (the collision fix)
	expect(
		existsSync(
			join(ROOT, "node_modules/@types/virtual-validators-zod/index.d.ts"),
		),
	).toBe(true);
	expect(
		existsSync(
			join(ROOT, "node_modules/@types/virtual-validators-valibot/index.d.ts"),
		),
	).toBe(true);
	// dynamic import boundary still captured (P2-14): billing tables generated
	expect(existsSync(join(GEN_ZOD, "invoices.ts"))).toBe(true);
});

test("disk cache keeps one entry per target+moduleId", () => {
	const cacheDir = join(ROOT, "node_modules/.cache/drizzle-validators");
	const entries = Array.from(
		new Bun.Glob("*.json").scanSync({ cwd: cacheDir }),
	);
	expect(entries.length).toBe(2);
	// envelopes carry distinct targets
	const targets = entries.map(
		(e) => JSON.parse(readFileSync(join(cacheDir, e), "utf-8")).data.target,
	);
	expect(targets.sort()).toEqual(["valibot", "zod"]);
});

test("the same payload validates identically on both targets", async () => {
	// self-sufficient: artifacts may be absent when this test runs alone
	if (!existsSync(join(GEN_ZOD, "accounts.ts"))) await buildOnce();
	const { validateAccountDual } = await import(`${join(ROOT, "src/index.ts")}`);
	expect(validateAccountDual({ name: "Ada", email: "ada@x.io" })).toEqual({
		zod: true,
		valibot: true,
		agree: true,
	});
	expect(validateAccountDual({ email: "not-an-email" })).toEqual({
		zod: false,
		valibot: false,
		agree: true,
	});
});

test("stale reconciliation deletes removed tables, preserves hand-written files", async () => {
	// hand-authored file (no generated header) in the output dir
	const helpers = join(GEN_ZOD, "custom-helpers.ts");
	writeFileSync(helpers, "export const customHelper = 1;\n");

	// remove legacyTable from the schema
	writeFileSync(
		ROOT_SCHEMA,
		originalRootSchema.replace(/export const legacyTable[\s\S]*?\n\}\);\n/, ""),
	);
	await buildOnce();

	expect(existsSync(join(GEN_ZOD, "legacyTable.ts"))).toBe(false);
	expect(existsSync(join(GEN_VALIBOT, "legacyTable.ts"))).toBe(false);
	expect(existsSync(helpers)).toBe(true); // hand-written file untouched
});

test("mutating the dynamically-imported billing file regenerates output", async () => {
	writeFileSync(
		BILLING,
		originalBilling.replace(
			'plan: text("plan", { enum: ["free", "pro", "team"] }).notNull(),',
			'plan: text("plan", { enum: ["free", "pro", "team", "enterprise"] }).notNull(),',
		),
	);
	await buildOnce();

	const generated = readFileSync(join(GEN_ZOD, "subscriptions.ts"), "utf-8");
	expect(generated).toContain('"enterprise"');
});

test("HMR: comment-only change suppresses full-reload; real change triggers it", async () => {
	const server = await createServer({
		configFile: resolve(ROOT, "vite.config.ts"),
		root: ROOT,
		logLevel: "silent",
		server: { middlewareMode: true },
		optimizeDeps: { noDiscovery: true },
	});

	const reloads: unknown[] = [];
	const originalSend = server.ws.send.bind(server.ws);
	server.ws.send = (...args: unknown[]) => {
		const payload = args[0] as { type?: string } | undefined;
		if (
			payload &&
			typeof payload === "object" &&
			payload.type === "full-reload"
		) {
			reloads.push(payload);
		}
		return originalSend(...(args as [any]));
	};

	try {
		// warm-up generation + watcher registration
		await new Promise((r) => setTimeout(r, 300));

		// 1. comment-only edit → output byte-identical → no reload
		writeFileSync(
			ROOT_SCHEMA,
			readFileSync(ROOT_SCHEMA, "utf-8").replace(
				"import { pgTable",
				"// watcher probe comment\nimport { pgTable",
			),
		);
		await new Promise((r) => setTimeout(r, 700));
		const afterNoop = reloads.length;

		// 2. real change → reload
		writeFileSync(
			ROOT_SCHEMA,
			readFileSync(ROOT_SCHEMA, "utf-8") +
				"\nexport const probeTable = pgTable('probe', { id: serial('id').primaryKey() });\n",
		);
		await new Promise((r) => setTimeout(r, 900));

		expect(afterNoop).toBe(0);
		expect(reloads.length).toBeGreaterThan(0);
	} finally {
		(server.ws as any).send = originalSend;
		await server.close();
		writeFileSync(ROOT_SCHEMA, originalRootSchema);
	}
});

// Concurrent cold generations + buildEnd cleanups across two instances
// sharing one .drizzle-validators-tmp: cleanup is non-recursive (only an
// empty dir is removed) and tmp filenames are unique, so neither instance
// can delete or overwrite the other's in-flight bundle.
test("concurrent cold loads + buildEnd across dual instances do not race on the tmp dir", async () => {
	const zodPlugin = drizzleValidators("zod", {
		schemaPath: "./src/db/root-schema.ts",
		moduleId: "virtual:race-zod",
	}) as any;
	const valibotPlugin = drizzleValidators("valibot", {
		schemaPath: "./src/db/root-schema.ts",
		moduleId: "virtual:race-valibot",
	}) as any;

	zodPlugin.configResolved({ root: ROOT, command: "serve" });
	valibotPlugin.configResolved({ root: ROOT, command: "serve" });

	const [zodCode, valibotCode] = await Promise.all([
		zodPlugin.load("\0virtual:race-zod").then(async (res: string) => {
			await zodPlugin.buildEnd();
			return res;
		}),
		valibotPlugin.load("\0virtual:race-valibot").then(async (res: string) => {
			await valibotPlugin.buildEnd();
			return res;
		}),
	]);

	expect(zodCode).toContain("accountsInsertSchema");
	expect(valibotCode).toContain("accountsInsertSchema");
});

test("per-target refine exports: zod/refineZSchema, valibot/refineVSchema, typebox/none", async () => {
	const server = await createServer({
		configFile: "vite.config.ts",
		root: ROOT,
		logLevel: "silent",
		server: { middlewareMode: true, ws: false },
		optimizeDeps: { noDiscovery: true },
	});
	try {
		const zod = await server.ssrLoadModule("virtual:validators-zod");
		const valibot = await server.ssrLoadModule("virtual:validators-valibot");
		expect(typeof zod.refineZSchema).toBe("function");
		expect(zod.refineVSchema).toBeUndefined();
		expect(typeof valibot.refineVSchema).toBe("function");
		expect(valibot.refineZSchema).toBeUndefined();

		// refine through the served valibot submodule end-to-end
		const accounts = await server.ssrLoadModule(
			"virtual:validators-valibot/accounts",
		);
		const v = await import("valibot");
		const refined = valibot.refineVSchema(accounts.insertSchema, (f: any) => ({
			email: f.email.pipe(v.email()),
		}));
		expect(
			v.safeParse(refined, { name: "ada", email: "not-an-email" }).success,
		).toBe(false);
	} finally {
		await server.close();
	}
});
