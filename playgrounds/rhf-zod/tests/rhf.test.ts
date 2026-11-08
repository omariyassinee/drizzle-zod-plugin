import { expect, test, afterAll } from "bun:test";
import { createServer, build } from "vite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { zodResolver } from "@hookform/resolvers/zod";
import type { ResolverOptions } from "react-hook-form";

// PG-A: react-hook-form + zodResolver playground. Verifies the resolver
// surfaces the refined schema's error map, the Hono server re-validates
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

// The resolver's third argument is a ResolverOptions; the fields map is only
// used for per-field validation, so an empty map is fine for whole-form tests.
const resolverOptions: ResolverOptions<Record<string, unknown>> = {
	fields: {},
	shouldUseNativeValidation: false,
};

test("zodResolver surfaces the refined schema's error map messages", async () => {
	const { registerSchema } = (await ssrLoad("/src/shared/validators.ts")) as {
		registerSchema: import("zod").ZodTypeAny;
	};

	const resolver = zodResolver(registerSchema as never);

	// Empty form -> error-map messages. Note: RHF sends "" for empty fields,
	// so `required` (which fires on `undefined`) is not hit for strings; the
	// format/min messages from the error map surface instead.
	const empty = await resolver(
		{
			email: "",
			username: "",
			age: undefined,
			password: "",
			confirmPassword: "",
		},
		{},
		resolverOptions,
	);
	expect(empty.errors).toBeDefined();
	expect(empty.errors.email?.message).toBe(
		"Please enter a valid email address",
	);
	expect(empty.errors.username?.message).toBe(
		"Username must be at least 3 characters",
	);
	expect(empty.errors.age?.message).toBe("Age is required");
	expect(empty.errors.password?.message).toBe(
		"Password must be at least 8 characters",
	);
	expect(empty.errors.confirmPassword?.message).toBe(
		"Password must be at least 8 characters",
	);

	// `required` fires when the field is explicitly undefined.
	const missing = await resolver(
		{
			email: undefined,
			username: "ada",
			age: 30,
			password: "password123",
			confirmPassword: "password123",
		},
		{},
		resolverOptions,
	);
	expect(missing.errors.email?.message).toBe("Email is required");

	// Bad email -> format message from the error map
	const badEmail = await resolver(
		{
			email: "not-an-email",
			username: "ada",
			age: 30,
			password: "password123",
			confirmPassword: "password123",
		},
		{},
		resolverOptions,
	);
	expect(badEmail.errors.email?.message).toBe(
		"Please enter a valid email address",
	);

	// Underage -> inline error wins (Tier 1)
	const underage = await resolver(
		{
			email: "ada@example.com",
			username: "ada",
			age: 15,
			password: "password123",
			confirmPassword: "password123",
		},
		{},
		resolverOptions,
	);
	expect(underage.errors.age?.message).toBe("You must be at least 18");

	// Password mismatch -> cross-field refine
	const mismatch = await resolver(
		{
			email: "ada@example.com",
			username: "ada",
			age: 30,
			password: "password123",
			confirmPassword: "different",
		},
		{},
		resolverOptions,
	);
	expect(mismatch.errors.confirmPassword?.message).toBe(
		"Passwords do not match",
	);

	// Valid -> no errors
	const valid = await resolver(
		{
			email: "ada@example.com",
			username: "ada",
			age: 30,
			password: "password123",
			confirmPassword: "password123",
		},
		{},
		resolverOptions,
	);
	expect(valid.errors).toEqual({});
	expect(valid.values).toBeDefined();
});

test("Hono server re-validates with the same schema", async () => {
	const { app } = (await ssrLoad("/src/server/api.ts")) as { app: any };

	// Valid registration
	const ok = await app.request("/api/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			email: "grace@example.com",
			username: "grace",
			age: 34,
			password: "password123",
			confirmPassword: "password123",
		}),
	});
	expect(ok.status).toBe(201);
	const okBody = (await ok.json()) as { ok: boolean; user: { email: string } };
	expect(okBody.ok).toBe(true);
	expect(okBody.user.email).toBe("grace@example.com");

	// Invalid -> 400 with flattened error map
	const bad = await app.request("/api/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			email: "nope",
			username: "x",
			age: 15,
			password: "short",
			confirmPassword: "short",
		}),
	});
	expect(bad.status).toBe(400);
	const badBody = (await bad.json()) as {
		error: { fieldErrors: Record<string, string[]> };
	};
	expect(badBody.error.fieldErrors.email?.[0]).toBe(
		"Please enter a valid email address",
	);
	expect(badBody.error.fieldErrors.age?.[0]).toBe("You must be at least 18");

	// Duplicate email -> 409
	const dup = await app.request("/api/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			email: "grace@example.com",
			username: "grace2",
			age: 30,
			password: "password123",
			confirmPassword: "password123",
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
	// No drizzle-orm, no pg-core, no locales in the client bundle
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
