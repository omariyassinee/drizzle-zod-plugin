import { expect, test, afterAll } from "bun:test";
import { createServer } from "vite";
import { build } from "vite";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { z } from "zod";

// PG1: zod-e2e-forms — the flagship. Internal mode + auto-detection, the
// full refineZSchema torture surface, an isomorphic Hono API consuming the
// same refined schemas, and client-bundle purity/tree-shaking asserts.

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

test("internal mode: zero project-tree files, hidden artifacts, hidden shim types", async () => {
	await ssrLoad("/src/shared/validators.ts");

	// generated files live in node_modules/.drizzle-validators, not the tree
	const internal = join(ROOT, "node_modules/.drizzle-validators");
	expect(existsSync(join(internal, "index.ts"))).toBe(true);
	expect(existsSync(join(ROOT, "virtual-drizzle-validators.d.ts"))).toBe(false);
	// types come from the hidden @types shim (auto-included)
	expect(
		existsSync(
			join(ROOT, "node_modules/@types/virtual-drizzle-validators/index.d.ts"),
		),
	).toBe(true);
});

test("refineZSchema torture: target-wins dedup, wrapper mutation, multi-stage", async () => {
	const v = (await ssrLoad("/src/shared/validators.ts")) as {
		doctorFormSchema: z.ZodObject<any>;
		licenseOverrideSchema: z.ZodObject<any>;
		doctorPhoneRequiredSchema: z.ZodObject<any>;
		appointmentFormSchema: z.ZodObject<any>;
		strictDoctorSchema: z.ZodObject<any>;
	};

	const validDoctor = {
		email: "ada@clinic.io",
		age: 34,
		licenseCode: "L1234567",
		specialty: "cardiology" as const,
		createdAt: new Date(),
	};

	// target-wins: email format applied; .max(120) retained; valid email passes
	expect(v.doctorFormSchema.safeParse(validDoctor).success).toBe(true);
	// format + retained length check both fire on bad input
	const longInvalid = v.doctorFormSchema.safeParse({
		...validDoctor,
		email: `${"x".repeat(130)}@clinic.io`,
	});
	expect(longInvalid.success).toBe(false);

	// constraint loosening: varchar(8)'s max(8) must NOT reject a 12-char code
	expect(
		v.licenseOverrideSchema.safeParse({
			...validDoctor,
			licenseCode: "L12345678901", // 12 chars
		}).success,
	).toBe(true);

	// wrapper mutation: nullable phone became required + e164
	expect(
		v.doctorPhoneRequiredSchema.safeParse({ ...validDoctor, phone: "+12125550100" })
			.success,
	).toBe(true);
	expect(
		v.doctorPhoneRequiredSchema.safeParse({ ...validDoctor, phone: undefined })
			.success,
	).toBe(false);

	// multi-stage: cross-field refine + omitted internal field enforced
	const appt = {
		doctorId: crypto.randomUUID(),
		clinicId: crypto.randomUUID(),
		reason: "Persistent chest pain during exercise",
		isFollowUp: false,
	};
	expect(
		v.appointmentFormSchema.safeParse({
			...appt,
			confirmClinicId: (appt as any).clinicId,
		}).success,
	).toBe(true);
	const mismatch = v.appointmentFormSchema.safeParse({
		...appt,
		confirmClinicId: crypto.randomUUID(),
	});
	expect(mismatch.success).toBe(false);
	// internalNotes was omitted: unknown key now rejected by strict-ish zod? (default zod object strips)
	expect((v.appointmentFormSchema as any).shape.internalNotes).toBeUndefined();

	// strict policy retention: unknown keys rejected through refineZSchema
	expect(
		v.strictDoctorSchema.safeParse({ ...validDoctor, hacker: true }).success,
	).toBe(false);
});

test("rc.5 creators mark defaulted columns optional with NO zod default", async () => {
	// Documented upstream behavior (verified against drizzle-orm rc.5):
	// `.default(fn)` / `.defaultNow()` columns come through as plain
	// `z.optional` without a zod `.default()` — omitted fields parse to
	// `undefined` and the DATABASE default applies on insert. (The P2-04
	// lazy-default machinery in refine remains for schemas that do carry
	// zod defaults, e.g. older drizzle-zod or hand-built schemas.)
	const v = (await ssrLoad("/src/shared/validators.ts")) as {
		appointmentFormSchema: z.ZodObject<any>;
		doctorFormSchema: z.ZodObject<any>;
	};
	const clinicId = crypto.randomUUID();
	const parsed = v.appointmentFormSchema.parse({
		clinicId,
		confirmClinicId: clinicId,
		reason: "Routine follow-up visit",
	});
	expect(parsed.doctorId).toBeUndefined();
	const doctor = v.doctorFormSchema.parse({
		email: "ada@clinic.io",
		age: 34,
		licenseCode: "L1234567",
	});
	expect(doctor.specialty).toBeUndefined();
});

test("hono API consumes the same refined schemas (SSR virtual modules)", async () => {
	const { app } = (await ssrLoad("/src/server/api.ts")) as { app: any };

	const ok = await app.request("/doctors", {
		method: "POST",
		body: JSON.stringify({
			email: "ada@clinic.io",
			age: 34,
			licenseCode: "L1234567",
		}),
	});
	expect(ok.status).toBe(201);

	const bad = await app.request("/doctors", {
		method: "POST",
		body: JSON.stringify({ email: "nope", age: 5 }),
	});
	expect(bad.status).toBe(400);
	const body = (await bad.json()) as {
		error: { fieldErrors: Record<string, string[]> };
	};
	expect(body.error.fieldErrors.email?.[0]).toContain("clinic email");
	expect(body.error.fieldErrors.age?.[0]).toContain("18");
});

test("client bundle is drizzle-free and tree-shakes unused tables", async () => {
	await build({ logLevel: "silent" });

	const assets = readdirSync(join(DIST, "assets")).filter((f) =>
		f.endsWith(".js"),
	);
	expect(assets.length).toBeGreaterThan(0);

	for (const file of assets) {
		const code = readFileSync(join(DIST, "assets", file), "utf-8");
		expect(code).not.toContain("drizzle-orm");
		expect(code).not.toContain("pg-core");
		expect(code).not.toContain("auditLogs"); // unused table tree-shaken
		expect(code).toContain("clinic email"); // the refined schema ships
		const size = statSync(join(DIST, "assets", file)).size;
		expect(size).toBeLessThan(200 * 1024); // zod subset only, no drizzle
	}
});
