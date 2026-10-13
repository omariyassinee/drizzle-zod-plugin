import { expect, test } from "bun:test";
import * as esbuild from "esbuild";

test("refineSchema is tree-shakeable and does not bundle Zod locales or JSON schema generators", async () => {
	const entryCode = `
import { refineSchema } from "./dist/refine.js";
import { object, string } from "zod";

const base = object({ email: string() });
export const refined = refineSchema(base, (f) => ({
	email: f.email.asEmail(),
}));
`;

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

	const bundledText = res.outputFiles[0]?.text ?? "";

	// Locales must NOT be bundled
	expect(
		bundledText.includes("locales/ar.js") || bundledText.includes("العربية"),
	).toBe(false);
	expect(bundledText.includes("locales/zh-CN.js")).toBe(false);

	// Bundled size must be compact (< 80 KB minified, previously > 330 KB minified)
	expect(bundledText.length).toBeLessThan(80_000);
});
