import { expect, test } from "bun:test";
import { build } from "vite";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { drizzleValidators } from "@vacuus/drizzle-validators";

// PG2: valibot-edge-worker — the real-project pipeline the unit suite
// cannot cover: CLI generation -> no-regen vite build (default) -> bundle that
// validates like a Cloudflare Worker, plus the fail-loud paths.

const DV = resolve(process.cwd(), "node_modules/.bin/dv");
const OUT = "./src/generated-validators";
const OUT_ABS = resolve(process.cwd(), OUT);

function generate(extra: string[] = []) {
	return Bun.spawnSync(
		[
			DV,
			"generate",
			"--schema",
			"./src/db/schema.ts",
			"--output",
			OUT,
			"--target",
			"valibot",
			...extra,
		],
		{ cwd: process.cwd() },
	);
}

test("CLI generates valibot validators for the filtered tables", () => {
	rmSync(OUT_ABS, { recursive: true, force: true });
	const proc = generate(["--tables", "webhooks,deliveries"]);

	expect(proc.exitCode).toBe(0);
	const code = readFileSync(resolve(OUT_ABS, "webhooks.ts"), "utf-8");
	expect(code).toContain("import * as v from 'valibot'");
	expect(code).toContain('v.enum({ "push": "push"');
	expect(code).not.toContain("refineZSchema"); // valibot target: zod-only helper omitted
	// the blob table was excluded by the filter
	expect(existsSync(resolve(OUT_ABS, "rawBinaryPayloads.ts"))).toBe(false);
	// hidden @types shim carries the virtual-module types
	expect(
		existsSync(
			resolve(
				process.cwd(),
				"node_modules/@types/virtual-drizzle-validators/index.d.ts",
			),
		),
	).toBe(true);
});

test("vite build without regeneration bundles a drizzle-free worker", async () => {
	// artifacts come from the previous test's generation — the build itself
	// must not regenerate (schema file could even be broken and it'd pass).
	// Inline config (not vite.config.ts) so experiments with the on-disk
	// config can't skew the suite.
	await build({
		logLevel: "silent",
		configFile: false,
		plugins: [
			drizzleValidators("valibot", {
				schemaPath: "./src/db/schema.ts",
				outputPath: "./src/generated-validators",
				tables: ["webhooks", "deliveries"],
			}),
		],
		build: {
			target: "esnext",
			outDir: "dist",
			emptyOutDir: true,
			lib: { entry: "./src/worker.ts", formats: ["es"] },
			rollupOptions: { output: { entryFileNames: "worker.js" } },
		},
	});

	const bundle = readFileSync(resolve(process.cwd(), "dist/worker.js"), "utf-8");
	expect(bundle).not.toContain("drizzle-orm");
	expect(bundle).not.toContain("sqlite-core");
	// tree-shaking: only the used valibot subset ships
	const size = statSync(resolve(process.cwd(), "dist/worker.js")).size;
	expect(size).toBeLessThan(15 * 1024);
});

test("built worker validates like an edge runtime", async () => {
	const worker = (await import(
		`${resolve(process.cwd(), "dist/worker.js")}`
	)).default;

	const valid = await worker.fetch(
		new Request("http://edge/webhooks", {
			method: "POST",
			body: JSON.stringify({
				url: "https://hooks.example/x",
				event: "push",
				secret: "s3cret",
			}),
		}),
	);
	expect(valid.status).toBe(201);
	const ok = (await valid.json()) as { webhook: { event: string; isActive?: boolean } };
	expect(ok.webhook.event).toBe("push");

	const invalid = await worker.fetch(
		new Request("http://edge/webhooks", {
			method: "POST",
			body: JSON.stringify({ url: "https://x", event: "merge" }),
		}),
	);
	expect(invalid.status).toBe(400);
	const err = (await invalid.json()) as { issues: { nested?: Record<string, string[]> } };
	// v.flatten: the bad enum value is reported under its property
	expect(err.issues.nested?.event?.[0]).toBeDefined();

	const rows = await worker.fetch(new Request("http://edge/deliveries"));
	expect(rows.status).toBe(200);
	const data = (await rows.json()) as { deliveries: Array<{ status: string }> };
	expect(data.deliveries[0]?.status).toBe("delivered");
});

test("unknown --tables entry fails loud with the table name", () => {
	const proc = generate(["--tables", "webhooks,nonexistent"]);
	expect(proc.exitCode).toBe(1);
	expect(new TextDecoder().decode(proc.stderr)).toContain(
		'Table "nonexistent" not exported',
	);
});

test("omitting the tables filter hits the blob column's fail-loud", () => {
	const proc = generate();
	expect(proc.exitCode).toBe(1);
	// rc.5 encodes blob buffer columns as custom predicates; the Buffer
	// policy (not the generic unknown-node error) must fire.
	expect(new TextDecoder().decode(proc.stderr)).toContain(
		"Node-only Buffer validator",
	);
});

test("a build with no artifacts fails with the actionable error", async () => {
	const emptyDir = "./src/empty-artifacts";
	rmSync(resolve(process.cwd(), emptyDir), { recursive: true, force: true });

	let error: unknown;
	try {
		await build({
			logLevel: "silent",
			configFile: false,
			plugins: [
				drizzleValidators("valibot", {
					schemaPath: "./src/db/schema.ts",
					outputPath: emptyDir,
				}),
			],
			build: {
				target: "esnext",
				outDir: "dist-empty",
				lib: { entry: "./src/worker.ts", formats: ["es"] },
			},
		});
	} catch (e) {
		error = e;
	}
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toContain(
		"No generated files were found",
	);
	rmSync(resolve(process.cwd(), "dist-empty"), { recursive: true, force: true });
});

// The user-driven scenario this playground caught (2026-10-25): valibot,
// NO tables filter, internal output (no outputPath). drizzle rc.5 encodes
// blob({ mode: "buffer" }) as a `custom` predicate node — the Buffer policy
// must apply to it exactly as it does for instance nodes.
test("internal mode, no tables filter: blob table obeys bufferAs (regression)", async () => {
	const plugin = drizzleValidators("valibot", {
		schemaPath: "./src/db/schema.ts",
		bufferAs: "keep",
	}) as any;
	plugin.configResolved({ root: process.cwd(), command: "serve" });

	const code = (await plugin.load("\0virtual:drizzle-validators/rawBinaryPayloads")) as string;
	expect(code).toContain("v.instance(Buffer)");

	const strict = drizzleValidators("valibot", {
		schemaPath: "./src/db/schema.ts",
	}) as any;
	strict.configResolved({ root: process.cwd(), command: "serve" });
	await expect(
		strict.load("\0virtual:drizzle-validators/rawBinaryPayloads"),
	).rejects.toThrow(/Node-only Buffer validator/);
});
