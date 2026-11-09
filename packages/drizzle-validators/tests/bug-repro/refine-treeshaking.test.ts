import { expect, test } from "bun:test";
import * as esbuild from "esbuild";

// NOTE: the entry must use NAMED zod imports. `import { z } from "zod"`
// materializes zod's full namespace object (~454 KB minified) in ANY
// bundle that uses it — user-side choice, not this library's
// contribution. The guard measures what the library itself adds.
const ENTRY_PREFIX = `
import { refineZSchema } from "./dist/refine.js";
import { object, string, email, number } from "zod";

const base = object({ email: string(), age: number() });
`;

async function bundle(entryCode: string): Promise<string> {
	const res = await esbuild.build({
		stdin: {
			contents: entryCode,
			resolveDir: process.cwd(),
		},
		bundle: true,
		format: "esm",
		minify: true,
		write: false,
	});
	return res.outputFiles[0]?.text ?? "";
}

function assertLocaleFree(bundledText: string): void {
	// Locales must NOT be bundled
	expect(
		bundledText.includes("locales/ar.js") || bundledText.includes("العربية"),
	).toBe(false);
	expect(bundledText.includes("locales/zh-CN.js")).toBe(false);
}

function assertCompact(bundledText: string): void {
	// Bundled size must be compact (previously > 330 KB minified before the
	// tree-shaking fix). The threshold tracks zod's own bundle growth across
	// minor versions (80 KB @ zod 4.4, ~90 KB @ zod 4.6); the actual
	// pathology (locales / JSON-schema generators) is asserted directly above.
	expect(bundledText.length).toBeLessThan(120_000);
}

test("refineZSchema is tree-shakeable and does not bundle Zod locales or JSON schema generators", async () => {
	const bundledText = await bundle(`
${ENTRY_PREFIX}
export const refined = refineZSchema(base, (f) => ({
	email: f.email.as(email()),
}));
`);

	assertLocaleFree(bundledText);
	assertCompact(bundledText);
});

test("refineZSchema errorMap path is tree-shakeable and locale-free", async () => {
	// The 2-arg declarative error map must not pull Zod locales or the JSON
	// schema generators into the bundle. error-map.ts uses `import type { z }`
	// (zero runtime Zod weight), so the map path should cost no more than the
	// callback path.
	const bundledText = await bundle(`
${ENTRY_PREFIX}
export const mapped = refineZSchema(base, {
	email: { required: "Email is required", email: "Enter a valid email" },
	age: { int: "Whole number", min: "Too young" },
});
`);

	assertLocaleFree(bundledText);
	assertCompact(bundledText);
});

test("refineZSchema 3-arg callback + errorMap path is tree-shakeable and locale-free", async () => {
	// The 3-arg form (callback + fallback map) must also stay locale-free and
	// under budget — the map is applied to the post-callback shape.
	const bundledText = await bundle(`
${ENTRY_PREFIX}
export const refined = refineZSchema(
	base,
	(f) => ({ email: f.email.as(email()) }),
	{ email: { required: "Email is required", email: "Enter a valid email" } },
);
`);

	assertLocaleFree(bundledText);
	assertCompact(bundledText);
});

test("predictions subpath is tree-shakeable, pulls zero valibot/typebox, and stays under 120 KB", async () => {
	const bundledText = await bundle(`
import { predictedKeys, errorsOf } from "./dist/predictions/index.js";
import { object, string, number } from "zod";

const schema = object({ email: string(), age: number() });
export const predictions = predictedKeys(schema.shape.email);
export const errors = errorsOf(schema, { email: 123 });
`);

	assertLocaleFree(bundledText);
	assertCompact(bundledText);
	expect(bundledText.includes("valibot")).toBe(false);
	expect(bundledText.includes("typebox")).toBe(false);
	expect(bundledText.includes("drizzle-orm")).toBe(false);
});
