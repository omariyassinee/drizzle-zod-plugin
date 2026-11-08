import { expect, test, afterAll } from "bun:test";
import { createServer, build } from "vite";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// PG-B: TanStack Form + Standard Schema playground. Verifies the refined
// schema validates via Standard Schema (Zod 4), the Hono server re-validates
// with the same schema, and the client bundle stays tree-shakeable.

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");

let server: Awaited<ReturnType<typeof createServer>>;

async function ssrLoad(path: string) {
	server ??= await createServer({
		configFile: "vite.config.ts",
		root: ROOT,
		logLevel: "silent",
		server: { middlewareMode: true, ws: false },
		optimizeDeps: { noDiscovery: true },
	});
	return server.ssrLoadModule(path);
}

afterAll(async () => {
	await server?.close();
	rmSync(DIST, { recursive: true, force: true });
});

test("refined schema validates via Standard Schema (Zod 4)", async () => {
	const { createProjectSchema } = (await ssrLoad(
		"/src/shared/validators.ts",
	)) as {
		createProjectSchema: import("zod").ZodTypeAny;
	};

	// Standard Schema v1 interface: `~standard` property with validate().
	const std = (
		createProjectSchema as unknown as {
			"~standard": {
				version: 1;
				vendor: string;
				validate: (
					value: unknown,
				) =>
					| { value: unknown }
					| { issues: { message: string; path?: (string | number)[] }[] };
			};
		}
	)["~standard"];

	expect(std.version).toBe(1);
	expect(std.vendor).toBe("zod");

	// Valid project
	const ok = std.validate({
		name: "Website Redesign",
		slug: "website-redesign",
		ownerEmail: "ada@example.com",
		estimatedHours: 40,
	});
	expect("value" in ok).toBe(true);

	// Invalid: bad email + underage hours -> issues with error-map messages
	const bad = std.validate({
		name: "Website Redesign",
		slug: "website-redesign",
		ownerEmail: "not-an-email",
		estimatedHours: 0,
	});
	expect("issues" in bad).toBe(true);
	if ("issues" in bad) {
		const messages = bad.issues.map((i) => i.message);
		expect(messages).toContain("Please enter a valid email address");
		expect(messages).toContain("Estimated hours must be at least 1");
	}
});

test("Hono server re-validates with the same schema", async () => {
	const { app } = (await ssrLoad("/src/server/api.ts")) as { app: any };

	// Valid project creation
	const ok = await app.request("/api/projects", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name: "Mobile App",
			slug: "mobile-app",
			ownerEmail: "grace@example.com",
			estimatedHours: 120,
		}),
	});
	expect(ok.status).toBe(201);
	const okBody = (await ok.json()) as {
		ok: boolean;
		project: { slug: string };
	};
	expect(okBody.ok).toBe(true);
	expect(okBody.project.slug).toBe("mobile-app");

	// Invalid -> 400 with flattened error map
	const bad = await app.request("/api/projects", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name: "X",
			slug: "x",
			ownerEmail: "nope",
			estimatedHours: 0,
		}),
	});
	expect(bad.status).toBe(400);
	const badBody = (await bad.json()) as {
		error: { fieldErrors: Record<string, string[]> };
	};
	expect(badBody.error.fieldErrors.ownerEmail?.[0]).toBe(
		"Please enter a valid email address",
	);
	expect(badBody.error.fieldErrors.estimatedHours?.[0]).toBe(
		"Estimated hours must be at least 1",
	);

	// Duplicate slug -> 409
	const dup = await app.request("/api/projects", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name: "Mobile App 2",
			slug: "mobile-app",
			ownerEmail: "grace@example.com",
			estimatedHours: 10,
		}),
	});
	expect(dup.status).toBe(409);
});

test("client bundle is tree-shakeable and locale-free", async () => {
	await build({
		configFile: "vite.config.ts",
		root: ROOT,
		logLevel: "silent",
		build: { outDir: DIST },
	});

	const files = readdirRecursive(DIST);
	const js = files.filter((f) => f.endsWith(".js"));
	expect(js.length).toBeGreaterThan(0);

	const all = js.map((f) => readFileSync(f, "utf8")).join("\n");
	expect(all.includes("drizzle-orm")).toBe(false);
	expect(all.includes("pg-core")).toBe(false);
	expect(all.includes("locales/ar.js")).toBe(false);
	expect(all.includes("locales/zh-CN.js")).toBe(false);
});

function readdirRecursive(dir: string): string[] {
	const { readdirSync, statSync } =
		require("node:fs") as typeof import("node:fs");
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) out.push(...readdirRecursive(p));
		else out.push(p);
	}
	return out;
}
