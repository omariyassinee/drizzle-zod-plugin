# Stress-Test Plan: Disk Cache Hydration & Serializer Heuristics

> **Target Package:** `@vacuus/drizzle-validators` (`v0.1.32`)
> **Target Subsystems:** `src/cache.ts`, `src/plugin.ts`, `src/file-writer.ts`, `src/zod-serializer.ts`, `src/adapters/valibot.ts`
> **Proposed Test Files:**
> - `packages/drizzle-validators/tests/bug-repro/cache-hydration-loss.test.ts`
> - `packages/drizzle-validators/tests/bug-repro/serializer-heuristic-stress.test.ts`

---

## 0. Executive Summary

This plan specifies a targeted stress-test suite designed to expose, reproduce, and prevent regressions in the two weakest links identified in `@vacuus/drizzle-validators`:

1. **Chain 1 — Disk Cache Hydration Loss & Cache Boundary Edge Cases (`src/cache.ts` & `src/plugin.ts`)**:
   - **Primary Bug:** `saveCachedData` and `loadCachedData` omit `refineExportStatement` and `refineDtsStatement` from `CacheEnvelope`. When a second dev session starts with `useCache: true`, hitting the disk cache causes `writeGeneratedFiles` to overwrite per-table `.ts` files, the barrel `index.ts`, and `.d.ts` type shims **without** `refineZSchema` / `refineVSchema`.
   - **Secondary Stress Vectors:** `generatedEquals` ignoring `refineExportStatement`/`refineDtsStatement`, transitive dynamic-import cache invalidation, `splitByTable` mode switching against a warm cache, and concurrent multi-process atomic cache writes.

2. **Chain 2 — Heuristic AST Reverse-Engineering (`src/zod-serializer.ts` & `src/adapters/valibot.ts`)**:
   - **Primary Bug:** `_zodTypeToCode` (`case "default"`) uses a synchronous 3ms busy-wait (`while (performance.now() - spinStart < 3) {}`) and compares two evaluations to detect lazy `.default(() => ...)` getters instead of inspecting the property descriptor (`hasLazyDefaultGetter`).
   - **Secondary Stress Vectors:** Counter/stateful closures that evaluate identically or corrupt state during the 2-probe spin, `N`-column cumulative blocking latency ($100 \times 3\text{ms} \ge 300\text{ms}$), false-positive spoofing in `overwriteCheckToCode` and `probeInstanceofClass`, and `Object.prototype` / `Error.captureStackTrace` side effects during heuristic probing.

---

## 1. Suite 1: Disk Cache Hydration & Lifecycle Stress Tests

**Target File:** `packages/drizzle-validators/tests/bug-repro/cache-hydration-loss.test.ts`

### 1.1 Bug Matrix

| Test ID | Target Function / File | Defect / Weakness Exercised | Expected Failure Before Fix |
| :--- | :--- | :--- | :--- |
| **C-01** | `saveCachedData` / `loadCachedData` (`src/cache.ts`) | `CacheEnvelope` drops `refineExportStatement` and `refineDtsStatement` on round-trip. | `hit.refineExportStatement` and `hit.refineDtsStatement` are `undefined`. |
| **C-02** | `_generateAndMaybeWrite` (`src/plugin.ts`) + `writeGeneratedFiles` (`src/file-writer.ts`) | Cold dev session writes `refineZSchema` to disk; warm dev session (`useCache: true`) hits disk cache and overwrites `users.ts`, `index.ts`, and `@types/.../index.d.ts` **without** `refineZSchema`. | On warm restart, `export { refineZSchema }` disappears from disk files and `.d.ts` shims! |
| **C-03** | `_generateAndMaybeWrite` (`src/plugin.ts`) | Same as **C-02** for `target: "valibot"` (`refineVSchema` stripped on warm cache hit). | `export { refineVSchema }` disappears from per-table files and `.d.ts` on warm cache hit. |
| **C-04** | `generatedEquals` (`src/cache.ts`) | `generatedEquals(a, b)` does not compare `refineExportStatement`, `refineDtsStatement`, or `importStatement`. | Returns `true` when comparing a corrupted cache-hydrated `GeneratedData` against a fresh one if `code` matches. |
| **C-05** | `computeCacheKey` (`src/cache.ts`) | Switching `splitByTable: true` $\leftrightarrow$ `splitByTable: false` with the same `outputPath` and `useCache: true`. | Verifies whether `splitByTable` transitions leave stale single-file or split-file artifacts when hydrating from cache. |
| **C-06** | `hashInputFiles` (`src/cache.ts`) + `depPaths` (`src/schema-generator.ts`) | 2-hop transitive dependency mutation (`schema.ts` $\rightarrow$ `shared.ts` $\rightarrow$ `enums.ts`) and newly added dynamic `await import()` files. | Verifies whether mutating leaf `enums.ts` invalidates the SHA-1 `inputsHash`. |
| **C-07** | `isEnvelope` (`src/cache.ts`) | Fuzzing `CacheEnvelope` with non-string `refineExportStatement: 123` or `refineDtsStatement: null` in `.cache/drizzle-validators/<key>.json`. | Without validation in `isEnvelope`, corrupted fields propagate into `file-writer.ts`. |

---

### 1.2 Concrete Test Implementation (`cache-hydration-loss.test.ts`)

```typescript
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
		process.cwd(),
		"node_modules",
		`.tmp-cache-stress-${name}-${process.pid}-${randomUUID().slice(0, 6)}`,
	);
	mkdirSync(dir, { recursive: true });
	symlinkSync(
		join(process.cwd(), "node_modules"),
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
			"export { refineZSchema } from '@vacuus/drizzle-validators/refine'",
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
		// BUG TARGET: Currently fails because CacheEnvelope omits both fields!
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
			"export { refineZSchema } from '@vacuus/drizzle-validators/refine'",
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
```

---

## 2. Suite 2: Heuristic AST Reverse-Engineering Stress Tests

**Target File:** `packages/drizzle-validators/tests/bug-repro/serializer-heuristic-stress.test.ts`

### 2.1 Heuristic Weakness Matrix

| Test ID | Heuristic Target | Mechanism Under Stress | Expected Failure / Fragility Exposed |
| :--- | :--- | :--- | :--- |
| **H-01** | `case "default"` (`src/zod-serializer.ts:535–555`) | **Stateful / Counter Lazy Default**: `z.number().default(() => Math.floor(Date.now() / 1000))` (second-granularity timestamp) or a lazy default reading an env/config variable `() => process.env.DEFAULT_ROLE ?? "user"`. | Because the 3ms spin-loop sees the *same* return value on both probes within 3ms, it **misclassifies a lazy function default as a static value** and freezes the build-time snapshot into static code! |
| **H-02** | `case "default"` (`src/zod-serializer.ts:547–549`) | **Side-Effect / Counter Corruption During Probing**: `let id = 0; z.number().default(() => ++id)`. | Evaluating `def.defaultValue` twice during serialization mutates external state and throws, or if memoized after first call, freezes the first call's value. |
| **H-03** | `case "default"` (`src/zod-serializer.ts:547–549`) | **Cumulative Blocking Spin-Loop Latency**: A schema with 60 defaulted columns (`z.string().default("a")`). | Because the 3ms `while (performance.now() - spinStart < 3) {}` loop runs on **every** `.default(...)` wrapper (even static string/boolean defaults!), 60 static defaults block the thread for $\ge 180\text{ms}$! |
| **H-04** | `overwriteCheckToCode` (`src/zod-serializer.ts:127–199`) | **False-Positive Probe Collision**: A user transform `.overwrite((s) => s.length <= 12 ? s.trim() : s.slice(0, 12))` that matches the 3 hardcoded short probes (`"\u00a0 ab \n"`, `"hello world"`, `"Ab\t"`). | The 3 probes all have length $\le 12$, so `overwriteCheckToCode` silently miscompiles the custom truncation logic into `.trim()`, losing the `.slice(0, 12)` behavior without throwing! |
| **H-05** | `overwriteCheckToCode` (`src/zod-serializer.ts:179–191`) | **Comment / Identifier Substring Spoofing on `normalize`**: A custom transform containing the word `"normalize"` in a comment or variable name that happens to return `"é"` on `"\u00e9"`. | `tx.toString().includes("normalize")` + single-character probe `"\u00e9"` falsely emits `.normalize()`. |
| **H-06** | `probeInstanceofClass` (`src/zod-serializer.ts:95–125`) | **Predicate Matching Multiple Candidate Classes**: `z.custom((v) => v instanceof Object)` or `z.custom((v) => typeof v === "object" && v !== null)`. | `probeInstanceofClass` loops over `["Buffer", "Date", "File", ...]`, tests `fn(Buffer.from("x")) === true && fn("not-an-instance") === false`, and **falsely classifies `typeof v === "object"` as `z.instanceof(Buffer)`**! |
| **H-07** | `isBufferCheck` (`src/adapters/valibot.ts:55–66`) | **Valibot Broad Object Predicate Misclassified as Buffer**: `v.custom((v) => typeof v === "object" && v !== null)` or `v.custom((v) => ArrayBuffer.isView(v))`. | `check(Buffer.alloc(0)) === true && check("") === false && check({}) === false` passes for `ArrayBuffer.isView` or `Uint8Array`, falsely emitting or throwing as a Node-only `Buffer` validator! |

---

### 2.2 Concrete Test Implementation (`serializer-heuristic-stress.test.ts`)

```typescript
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import * as v from "valibot";
import { zodTypeToCode } from "../../src/zod-serializer";
import { valibotAdapter } from "../../src/adapters/valibot";

describe("Chain 2: Serializer Heuristic Reverse-Engineering Stress Suite", () => {
	test("H-01: lazy default with coarse timer or runtime env lookup must NOT freeze at build time", () => {
		// A lazy getter that returns the same value within a 3ms window
		// (e.g., second-precision timestamp or runtime environment lookup)
		const secondTimestampSchema = z
			.number()
			.default(() => Math.floor(Date.now() / 10_000));

		// BUG TARGET: Because `Math.floor(Date.now() / 10_000)` rarely changes inside a 3ms spin loop,
		// the current serializer fails to detect that `defaultValue` is a getter and freezes the number!
		// With `hasLazyDefaultGetter(def)` (checking Object.getOwnPropertyDescriptor(def, 'defaultValue')?.get),
		// ANY getter-backed default is detected deterministically in 0ms.
		expect(() => zodTypeToCode(secondTimestampSchema)).toThrow(
			/Cannot serialize a lazy \.default/,
		);
	});

	test("H-03: 50 static .default('x') fields should serialize in < 15ms (no 3ms spin-loop per field)", () => {
		const shape: Record<string, z.ZodTypeAny> = {};
		for (let i = 0; i < 50; i++) {
			shape[`col_${i}`] = z.string().default("static_val");
		}
		const bigObject = z.object(shape);

		const start = performance.now();
		const code = zodTypeToCode(bigObject);
		const elapsedMs = performance.now() - start;

		expect(code).toContain('.default("static_val")');
		// BUG TARGET: Currently takes > 150ms (50 * 3ms busy-wait) because the spin loop
		// executes even on static defaults!
		expect(elapsedMs).toBeLessThan(20);
	});

	test("H-04: custom .overwrite() that happens to trim short strings but truncates long ones must NOT silently become .trim()", () => {
		const customTruncateAndTrim = z
			.string()
			.overwrite((val) => (val.length > 20 ? val.slice(0, 20).trim() : val.trim()));

		// BUG TARGET: All 3 probes in CANDIDATES for .trim() are < 20 chars, so the probe
		// currently misidentifies this custom transform as plain `.trim()`!
		expect(() => zodTypeToCode(customTruncateAndTrim)).toThrow(
			/Cannot serialize a custom string transform/,
		);
	});

	test("H-06: z.custom((v) => typeof v === 'object' && v !== null) must NOT be misclassified as z.instanceof(Buffer)", () => {
		const anyObjectSchema = z.custom<object>(
			(v) => typeof v === "object" && v !== null,
		);

		// BUG TARGET: In probeInstanceofClass, `Buffer.from("x")` is an object (returns true)
		// and `"not-an-instance"` is a string (returns false).
		// So `probeInstanceofClass` returns "Buffer" and throws the P2-02 Buffer error (or emits z.instanceof(Buffer) with bufferAs: "keep")!
		expect(() =>
			zodTypeToCode(anyObjectSchema, undefined, 0, { bufferAs: "keep" }),
		).toThrow(/Cannot serialize z\.custom\(\) with a runtime predicate/);
	});

	test("H-06b: z.custom((v) => ArrayBuffer.isView(v)) (e.g. Uint8Array) must NOT be misclassified as Buffer", () => {
		const uint8Schema = z.custom<ArrayBufferView>((v) =>
			ArrayBuffer.isView(v),
		);

		// Buffer is a Uint8Array subclass, so fn(Buffer.from("x")) === true!
		// With bufferAs: "keep", it would falsely emit `z.instanceof(Buffer)` which rejects plain Uint8Arrays!
		expect(() =>
			zodTypeToCode(uint8Schema, undefined, 0, { bufferAs: "keep" }),
		).toThrow(/Cannot serialize z\.custom\(\)/);
	});

	test("H-07: Valibot v.custom((v) => v instanceof Uint8Array) must NOT be misclassified as v.instance(Buffer)", () => {
		const uint8Valibot = v.custom<Uint8Array>(
			(input) => input instanceof Uint8Array,
		);

		// Buffer extends Uint8Array, so `Buffer.alloc(0) instanceof Uint8Array` is true!
		// `isBufferCheck` in src/adapters/valibot.ts falsely returns true and emits `v.instance(Buffer)`!
		expect(() =>
			valibotAdapter.emit(uint8Valibot, { bufferAs: "keep", depth: 0 }),
		).toThrow(/Unserializable valibot schema node/);
	});
});
```

---

## 3. Remediation Blueprint (How to Make All Stress Tests Pass)

Once the two stress test suites above are added and confirmed failing (`Red`), apply the following surgical fixes to turn them `Green`:

### Fix 1: Complete `CacheEnvelope` in `src/cache.ts`
1. Add `refineExportStatement?: string` and `refineDtsStatement?: string` to `CacheEnvelope["data"]`.
2. Bump `CACHE_VERSION` from `5` to `6`.
3. In `saveCachedData`, include `refineExportStatement: data.refineExportStatement` and `refineDtsStatement: data.refineDtsStatement`.
4. In `loadCachedData`, restore both fields onto the returned `GeneratedData` object.
5. In `isEnvelope`, validate that `v.data.refineExportStatement` and `v.data.refineDtsStatement` are `undefined` or `"string"`.
6. In `generatedEquals`, compare `a.refineExportStatement === b.refineExportStatement`, `a.refineDtsStatement === b.refineDtsStatement`, and `a.importStatement === b.importStatement`.

### Fix 2: Eliminate the 3ms Spin-Loop & Tighten Probes in `src/zod-serializer.ts` & `src/adapters/valibot.ts`
1. **Replace the 3ms Spin-Loop (`src/zod-serializer.ts:535–555`)**:
   - Import `hasLazyDefaultGetter` from `./zod-compat` (or inspect `Object.getOwnPropertyDescriptor(def, "defaultValue")?.get`).
   - Note: In Zod 4, `.default(staticValue)` defines `defaultValue: staticValue` (a value property or a constant getter depending on Zod minor version), whereas `.default(() => ...)` wraps the user's thunk in a getter. Inspecting the getter function's source or descriptor—or checking if `def.defaultValue` is backed by a user closure—eliminates the 3ms `performance.now()` spin loop on static defaults and catches slow-changing getters (`H-01`, `H-03`).
2. **Harden `probeInstanceofClass` (`src/zod-serializer.ts:95–125`) & `isBufferCheck` (`src/adapters/valibot.ts:55–66`)**:
   - In `probeInstanceofClass`, verify that **only one** candidate class returns `true` AND that negative probes (`{}`, `new Uint8Array(0)`, `new Date()`, `Buffer.from("x")`) for all *other* classes return `false` (`H-06`, `H-06b`).
   - In `isBufferCheck` (`src/adapters/valibot.ts`), assert `check(new Uint8Array(0)) === false` alongside `check(Buffer.alloc(0)) === true` so `Uint8Array` / `ArrayBuffer.isView` predicates are not misidentified as `Buffer` (`H-07`).