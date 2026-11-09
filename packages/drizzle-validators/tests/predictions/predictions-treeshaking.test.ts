import { expect, test } from "bun:test";
import * as esbuild from "esbuild";

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

test("predictions entrypoint pulls zero valibot, typebox, drizzle-orm, or Zod locales", async () => {
  const entryCode = `
import { predictedKeys, errorsOf } from "./dist/predictions/index.js";
import { object, string, number } from "zod";

export const s = object({ name: string(), age: number() });
export const p = predictedKeys(s.shape.name);
export const errs = errorsOf(s, { name: 123 });
`;

  const bundledText = await bundle(entryCode);

  // 1. Zero Valibot or TypeBox in the Zod predictions bundle
  expect(bundledText.includes("valibot")).toBe(false);
  expect(bundledText.includes("typebox")).toBe(false);
  expect(bundledText.includes("drizzle-orm")).toBe(false);

  // 2. Zero Zod locales
  expect(
    bundledText.includes("locales/ar.js") || bundledText.includes("العربية"),
  ).toBe(false);
  expect(bundledText.includes("locales/zh-CN.js")).toBe(false);

  // 3. Compact size under 120 KB ceiling
  expect(bundledText.length).toBeLessThan(120_000);
});
