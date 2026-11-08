# Real-World Playgrounds Architecture & Stress-Test Specification

> **Monorepo Scope:** `playgrounds/*` (`workspace:*` linked against `@vacuus/drizzle-validators`)
> **Design Philosophy:** Zero heavy UI framework bloat; maximum surface-area coverage of the Vite plugin, virtual module resolution, `refineSchema` proxy engine, multi-target serializers (`zod`, `valibot`, `typebox`), CLI (`dv`), disk caching, and production tree-shaking.

---

## 0. Coverage Matrix Across Playgrounds

Each playground is purpose-built around a distinct real-world architectural niche so that, together, they exercise 100% of `@vacuus/drizzle-validators` flags, runtime paths, and edge cases:

| Package Feature / Corner Case | PG 1: `zod-e2e-forms` (Client/Server & `refineSchema`) | PG 2: `valibot-edge-worker` (Edge Bundle & `noBuildRegen`) | PG 3: `typebox-elysia-rpc` (CLI, `bufferAs`, Single-File) | PG 4: `polyglot-dual-plugin` (Multi-Instance & Dynamic Deps) |
| :--- | :---: | :---: | :---: | :---: |
| **Validator Target** | `"zod"` | `"valibot"` | `"typebox"` | `"zod"` + `"valibot"` (simultaneous) |
| **Resolution Mode** | Internal Virtual (`outputPath` omitted) | Pre-generated (`noBuildRegen: true`) | CLI Standalone (`--no-split`) | Custom `moduleId`s + `emitRootDts` |
| **Import Granularity** | Root barrel + `/tableName` submodules | `/tableName` submodules only | Direct disk import (`./src/validators.ts`) | Dual virtual barrels (`virtual:validators-zod`, `virtual:validators-valibot`) |
| **`refineSchema` Engine** | Full stress test (`.as`, `.unwrap`, `.required`, `.nonnullable`, `setError`, lazy defaults, strict objects, async) | Verified omitted (`refineSchema` absent) | Verified omitted (`refineSchema` absent) | Cross-checked on Zod instance only |
| **Schema Discovery** | Auto-detected via `drizzle.config.ts` | Explicit `schemaPath` + `tables` filter | CLI `-c drizzle.mysql.config.ts` | Dynamic `await import("./ audit.schema.ts")` |
| **Buffer Policy (`bufferAs`)** | `"throw"` (default browser-safe guard) | `"throw"` (Cloudflare Worker edge guard) | `"keep"` (Node/Bun binary ingestion) | `"throw"` |
| **Bundler / Runtime** | Vite Client Build + Hono SSR | Vite SSR Build + Miniflare/Workerd | Bun native runtime + `tsc --noEmit` | Vite Watcher HMR & Disk Cache |

---

## 1. Playground 1: `playgrounds/zod-e2e-forms`
### Niche: Full-Stack Isomorphic Form & API Pipeline (Zod 4 + `refineSchema` Torture Test)

**Real-World Scenario:** A multi-step clinic onboarding and appointment scheduling portal. A Vite frontend shares exact validation rules with a lightweight Hono API server, refining Drizzle PostgreSQL tables with domain rules, localized error messages, async username checks, and strict payload policies without leaking a single byte of `drizzle-orm` into the browser bundle.

### 1.1 Features & Corner Cases Tested
1. **Zero-Config Internal Mode & Auto-Detection**:
   - `drizzleValidators("zod")` with `schemaPath` and `outputPath` omitted.
   - Auto-discovers `./src/db/schema.ts` via `drizzle.config.ts`.
   - Verifies that `node_modules/@types/virtual-drizzle-validators/index.d.ts` provides full IDE/tsc inference with zero files written to the project tree.
2. **Every `refineSchema` Capability (`src/refine.ts` & `src/zod-compat.ts`)**:
   - **Target-Wins Check Deduplication**: Refining a `varchar("email", { length: 255 })` column via `f.email.as(z.email({ error: "Invalid clinic email" }))` retains `.max(255)` while applying the email format check without duplicating format issues.
   - **Constraint Loosening (`{ transferChecks: false }`)**: Overriding a strict `varchar("short_code", { length: 6 })` column with `f.shortCode.as(z.string().min(4).max(16), { transferChecks: false })`.
   - **Explicit Wrapper Mutation**:
     - `.required()` on an optional `updateSchema` field (`f.phone.required().as(z.e164())`).
     - `.nonnullable()` on a nullable DB column (`f.MiddleName.nonnullable().min(2)`).
     - `.unwrap()` on a `.nullable().optional()` field to make it strictly required.
   - **Required-Field Chaining**: `f.age.min(18).max(120).setError("Age must be between 18 and 120")` on a non-optional `integer("age").notNull()` column.
   - **Lazy Default Preservation (P2-04)**: Refining a column that has `.default(() => crypto.randomUUID())` and asserting that consecutive `.parse({})` calls generate distinct UUIDs.
   - **Object-Level Policy Retention (`rebuildZodObject`)**: Converting `insertSchema` to `z.strictObject(insertSchema.shape)` before passing it to `refineSchema`, verifying unknown keys are rejected.
   - **Multi-Stage Composition**: `baseInsertSchema` $\rightarrow$ `orgRefinedSchema` $\rightarrow$ `.omit({ internalNotes: true })` $\rightarrow$ `clientFormSchema` with added `confirmPassword` and `.refine()` cross-field check.
3. **Client Bundle Purity & Tree-Shaking**:
   - Client entry imports only `virtual:drizzle-validators/appointments` and `named` Zod builders (`import { email, e164, string } from "zod"`).
   - Build test asserts `dist/client/*.js` contains zero occurrences of `drizzle-orm`, `pg-core`, `locales/ar`, or unused tables (`auditLogsTable`).

### 1.2 Directory Structure
```text
playgrounds/zod-e2e-forms/
├── drizzle.config.ts
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── db/
│   │   └── schema.ts              # PG tables: clinics, doctors, appointments, unusedAuditLogs
│   ├── shared/
│   │   └── validators.ts          # Multi-stage refineSchema pipelines
│   ├── server/
│   │   └── api.ts                 # Hono routes consuming shared refined schemas
│   └── client/
│       └── main.ts                # Vanilla DOM form controller + z.flattenError / z.treeifyError
└── tests/
    └── e2e.test.ts                # Asserts runtime validation, bundle size, and tree-shaking
```

### 1.3 Key Implementation Files

#### `src/db/schema.ts`
```typescript
import {
	pgTable,
	pgEnum,
	uuid,
	varchar,
	integer,
	text,
	boolean,
	timestamp,
	jsonb,
	point,
} from "drizzle-orm/pg-core";

export const specialtyEnum = pgEnum("specialty", [
	"cardiology",
	"dermatology",
	"neurology",
	"pediatrics",
]);

export const doctors = pgTable("doctors", {
	id: uuid("id").primaryKey().defaultRandom(),
	email: varchar("email", { length: 120 }).notNull(),
	phone: varchar("phone", { length: 20 }), // nullable in DB
	age: integer("age").notNull(),
	specialty: specialtyEnum("specialty").notNull().default("cardiology"),
	licenseCode: varchar("license_code", { length: 8 }).notNull(),
	bio: text("bio"), // nullable
	coordinates: point("coordinates", { mode: "tuple" }),
	metadata: jsonb("metadata").$type<{ verified: boolean; rating: number }>(),
	isActive: boolean("is_active").notNull().default(true),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.notNull()
		.defaultNow(),
});

// Intentionally unreferenced by client to verify Rollup/Rolldown tree-shaking
export const unusedAuditLogs = pgTable("unused_audit_logs", {
	id: uuid("id").primaryKey().defaultRandom(),
	SECRET_SERVER_MARKER_DO_NOT_BUNDLE: varchar("secret_marker", { length: 500 }).notNull(),
});
```

#### `src/shared/validators.ts`
```typescript
import { email, e164, string, int, boolean, strictObject } from "zod";
import {
	insertSchema as baseDoctorInsert,
	updateSchema as baseDoctorUpdate,
	refineSchema,
} from "virtual:drizzle-validators/doctors";

// 1. Convert base insert schema to strictObject to verify catchall: never survival
const strictDoctorInsert = strictObject(baseDoctorInsert.shape);

// 2. Stage 1: Organization-level refinement
export const orgDoctorInsertSchema = refineSchema(strictDoctorInsert, (f) => ({
	// Target-wins check transfer: swaps to z.email(), retains .max(120) from varchar(120)
	email: f.email.as(email({ error: "Valid hospital email required" })),

	// Required-field chaining + setError
	age: f.age
		.min(24, { error: "Doctor must be at least 24" })
		.max(85, { error: "Doctor age cannot exceed 85" }),

	// Unwrap nullable + optional phone into strictly required E.164 phone number
	phone: f.phone.unwrap().as(e164({ error: "Phone must be in E.164 format (+1...)" })),

	// Loosen DB varchar(8) constraint for legacy external license codes
	licenseCode: f.licenseCode.as(string().min(4).max(32), {
		transferChecks: false,
	}),

	// Strip nullability on bio while keeping it optional for insert
	bio: f.bio.nonnullable().max(500, { error: "Bio max 500 chars" }),
}));

// 3. Stage 2: Client Onboarding Form Schema (extends Stage 1 with virtual UI fields)
export const onboardingFormSchema = refineSchema(orgDoctorInsertSchema, (f) => ({
	specialty: f.specialty.extract(["cardiology", "neurology"]),
	acceptHipaa: boolean().refine((val) => val === true, {
		error: "You must accept HIPAA compliance terms",
	}),
}));

// 4. Patch/Update Schema refinement: require `id` on an all-optional updateSchema
export const doctorPatchSchema = refineSchema(baseDoctorUpdate, (f) => ({
	id: f.id.required().setError("Doctor UUID is mandatory for PATCH"),
	email: f.email.as(email({ error: "Invalid updated email" })),
}));
```

---

## 2. Playground 2: `playgrounds/valibot-edge-worker`
### Niche: Ultra-Light Edge Worker & CI Build-Skip Pipeline (`valibot` + `noBuildRegen`)

**Real-World Scenario:** A Cloudflare Worker / WinterCG edge webhook ingestion service where cold-start bundle size must stay under 15 KB. In CI, database schema generation happens in an isolated pre-build step (`dv generate --target valibot`), and the production Vite edge build runs with `noBuildRegen: true` and `tables` filtering so `vite build` performs zero esbuild/Drizzle evaluation.

### 2.1 Features & Corner Cases Tested
1. **Valibot Serializer Completeness (`src/adapters/valibot.ts`)**:
   - Verifies `v.pipe(v.string(), v.maxLength(...), v.uuid())`, `v.enum(...)`, `v.picklist(...)`, `v.optional(v.nullable(...))`, `v.array(...)`, and `v.record(...)`.
   - Verifies that `refineSchema` is cleanly excluded from both runtime exports and `node_modules/@types/virtual-drizzle-validators/index.d.ts`.
2. **`noBuildRegen: true` Artifact Reconstruction (`src/artifacts.ts`)**:
   - Step 1: Run `bunx dv generate --target valibot --output ./src/generated-validators --tables webhooks,deliveries`.
   - Step 2: Run `vite build` with `drizzleValidators("valibot", { outputPath: "./src/generated-validators", noBuildRegen: true, tables: ["webhooks", "deliveries"] })`.
   - Verifies that `readGeneratedArtifacts` reconstructs the root virtual barrel and `/webhooks` submodule directly from disk without touching `drizzle-orm` or `esbuild`.
   - Negative test: Running `vite build` with `noBuildRegen: true` against an empty directory throws the exact actionable error from `plugin.ts:138`.
3. **P2-02 Buffer Guard on Valibot**:
   - Includes an excluded table `rawBinaryPayloads` with a custom `Buffer` instance column; verifies `tables: ["webhooks", "deliveries"]` bypasses it cleanly, while omitting `tables` with `bufferAs: "throw"` fails loud.

### 2.2 Directory Structure
```text
playgrounds/valibot-edge-worker/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── db/
│   │   └── schema.ts              # SQLite/D1 tables: webhooks, deliveries, rawBinaryPayloads
│   └── worker.ts                  # Edge fetch handler using v.safeParse & v.flatten
└── tests/
    └── edge-pipeline.test.ts      # Tests dv CLI -> noBuildRegen vite build -> bundle size (<15KB)
```

### 2.3 Key Implementation Files

#### `vite.config.ts`
```typescript
import { defineConfig } from "vite";
import { drizzleValidators } from "@vacuus/drizzle-validators";

export default defineConfig({
	plugins: [
		drizzleValidators("valibot", {
			schemaPath: "./src/db/schema.ts",
			outputPath: "./.generated/valibot",
			tables: ["webhooks", "deliveries"],
			noBuildRegen: process.env.TEST_NO_BUILD_REGEN === "true",
		}),
	],
	build: {
		ssr: "./src/worker.ts",
		target: "esnext",
		minify: true,
		rollupOptions: {
			output: { format: "esm" },
		},
	},
});
```

#### `src/worker.ts`
```typescript
import * as v from "valibot";
import { insertSchema as webhookInsert } from "virtual:drizzle-validators/webhooks";
import { deliveriesInsertSchema } from "virtual:drizzle-validators";

// Compose additional Valibot pipe rules natively on top of generated schema
const SignedWebhookSchema = v.object({
	...webhookInsert.entries,
	signatureHeader: v.pipe(
		v.string(),
		v.startsWith("sha256="),
		v.minLength(71),
	),
});

export default {
	async fetch(request: Request): Promise<Response> {
		const body = await request.json();
		const parsed = v.safeParse(SignedWebhookSchema, body);
		if (!parsed.success) {
			return Response.json(
				{ errors: v.flatten(parsed.issues) },
				{ status: 422 },
			);
		}
		const deliveryCheck = v.safeParse(deliveriesInsertSchema, {
			webhookId: parsed.output.id ?? "wh_default",
			statusCode: 200,
			attempt: 1,
		});
		return Response.json({
			ok: deliveryCheck.success,
			payload: parsed.output,
		});
	},
};
```

---

## 3. Playground 3: `playgrounds/typebox-elysia-rpc`
### Niche: High-Throughput Binary & Telemetry Microservice (`typebox` + CLI `--no-split` + `bufferAs: "keep"`)

**Real-World Scenario:** A Bun/Node backend microservice that ingests high-frequency IoT telemetry packets (including raw `BigInt` counters, JSONB sensor maps, and binary `Buffer` firmware blobs) and validates them using TypeBox's JIT compiler (`TypeCompiler.Compile` / `Value.Check`) without Vite in the runtime loop.

### 3.1 Features & Corner Cases Tested
1. **Standalone CLI Workflow (`src/cli.ts`)**:
   - Exercises `--config ./drizzle.telemetry.config.json` (JSON config parsing), `--target typebox`, `--no-split`, `--output ./src/validators.ts`, and `--buffer-as keep`.
2. **TypeBox JSON Schema Emitter (`src/adapters/typebox.ts`)**:
   - Tests `t.BigInt({ minimum: ..., maximum: ... })` serialization with `n`-suffixed literals.
   - Tests `t.Unsafe<Date>({ type: "date" })` round-tripping on timestamp/date columns.
   - Tests `patternProperties: { "^.*$": {} }` $\rightarrow$ `t.Record(t.String(), t.Any())` on JSONB columns.
   - Tests nullable union emission `t.Union([t.Integer(), t.Null()])` wrapped inside `t.Optional(...)` on insert/update schemas.
   - Tests `TypeCompiler.Compile(telemetryPacketInsertSchema)` JIT compilation compatibility.

### 3.2 Directory Structure
```text
playgrounds/typebox-elysia-rpc/
├── drizzle.telemetry.config.json
├── package.json
├── tsconfig.json
├── src/
│   ├── db/
│   │   └── telemetry-schema.ts    # MySQL & PG tables with BigInt, JSON, Dates, Enums, Blobs
│   ├── validators.ts              # Generated single-file TypeBox schemas via `dv generate`
│   └── server.ts                  # TypeBox Value.Check + TypeCompiler JIT benchmarks
└── tests/
    └── typebox-cli.test.ts        # Runs CLI flags, verifies single-file output & JIT validation
```

### 3.3 Key Implementation Files

#### `src/server.ts`
```typescript
import { Value } from "typebox/value";
import {
	telemetryPacketsInsertSchema,
	telemetryPacketsSelectSchema,
	 telemetryPacketsUpdateSchema,
} from "./validators";

export function validateIncomingPacket(raw: unknown) {
	// Validates BigInt bounds, UUID format, enum literals, and t.Unsafe<Date>
	if (!Value.Check(telemetryPacketsInsertSchema, raw)) {
		const errors = [...Value.Errors(telemetryPacketsInsertSchema, raw)].map(
			(e) => ({ path: e.path, message: e.message }),
		);
		return { valid: false as const, errors };
	}
	return { valid: true as const, data: raw };
}

export function validatePartialFirmwarePatch(raw: unknown) {
	return Value.Check(telemetryPacketsUpdateSchema, raw);
}

export function validateStoredRecord(raw: unknown) {
	return Value.Check(telemetryPacketsSelectSchema, raw);
}
```

---

## 4. Playground 4: `playgrounds/polyglot-dual-plugin`
### Niche: Multi-Instance Plugin, Dynamic Schema Imports, Stale File Reconciliation & Disk Cache Torture Test

**Real-World Scenario:** A monorepo migration gateway that runs **two simultaneous instances** of `drizzleValidators` in a single `vite.config.ts`—emitting legacy Zod schemas under `virtual:validators-zod` and new Valibot schemas under `virtual:validators-valibot`—while pulling tables across dynamic `await import()` boundaries and testing live HMR schema mutations.

### 4.1 Features & Corner Cases Tested
1. **Multi-Instance Custom `moduleId` & `emitRootDts: true`**:
   - Instance 1: `drizzleValidators("zod", { moduleId: "virtual:validators-zod", outputPath: "./src/gen/zod", emitRootDts: true })`.
   - Instance 2: `drizzleValidators("valibot", { moduleId: "virtual:validators-valibot", outputPath: "./src/gen/valibot", emitRootDts: true })`.
   - Verifies that `computeCacheKey` isolates both targets (`opts.moduleId` + `opts.target` in SHA-1 key) without cache collisions in `node_modules/.cache/drizzle-validators/`.
2. **Dynamic Import Dependency Graph (`P2-14`)**:
   - `src/db/root-schema.ts` loads `const billing = await import("./billing-tables.ts")` dynamically and re-exports `billing.invoices`.
   - Verifies that `result.metafile.inputs` captures `./billing-tables.ts` in `depPaths`, and mutating `billing-tables.ts` invalidates the disk cache hash (`hashInputFiles`).
3. **Stale Table File Reconciliation (`P2-10`) & Handmade File Preservation**:
   - Places a user-authored helper file `src/gen/zod/custom-helpers.ts` (without `// AUTO-GENERATED by drizzle-validators`) alongside generated table files.
   - Simulates removing a table export (`legacyTable`) and regenerating; verifies `src/gen/zod/legacyTable.ts` is deleted while `src/gen/zod/custom-helpers.ts` remains untouched.
4. **Dev Server Watcher & No-Op Reload Suppression (`P2` & `P2-13`)**:
   - Starts Vite in middleware mode, appends a comment to `src/db/root-schema.ts`, and verifies `generatedEquals(prevData, data)` suppresses unnecessary `full-reload` WebSocket events.

### 4.2 Directory Structure
```text
playgrounds/polyglot-dual-plugin/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── db/
│   │   ├── root-schema.ts         # Statically exports `accounts`, dynamically imports `billing-tables.ts`
│   │   └── billing-tables.ts      # Exports `invoices` and `subscriptions`
│   └── index.ts                   # Validates identical payloads against both Zod and Valibot virtual modules
└── tests/
    └── dual-lifecycle.test.ts     # Tests cache hits, dynamic dep invalidation, stale file cleanup, and dual runtime parity
```

---

## 5. Monorepo Execution & CI Integration Plan

Add a unified `test:playgrounds` script to the root `package.json` so all four real-world workspaces can be verified in one command after building `@vacuus/drizzle-validators`:

```json
{
	"name": "@vacuus/drizzle-validators-monorepo",
	"private": true,
	"workspaces": [
		"packages/*",
		"playgrounds/*"
	],
	"scripts": {
		"build": "bun run --filter='@vacuus/drizzle-validators' build",
		"test": "bun run --filter='@vacuus/drizzle-validators' test",
		"test:playgrounds": "bun run build && bun run --filter='./playgrounds/*' test",
		"typecheck": "bun run build && bun run --filter='*' typecheck"
	}
}
```