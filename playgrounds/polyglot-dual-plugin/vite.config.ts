import { defineConfig } from "vite";
import { drizzleValidators } from "drizzle-validators";

export default defineConfig({
  plugins: [
    drizzleValidators("zod", {
      schemaPath: "./src/db/root-schema.ts",
      moduleId: "virtual:validators-zod",
      outputPath: "./src/gen/zod",
      useCache: true,
      regenOnBuild: true,
      emitRootDts: true,
    }),
    drizzleValidators("valibot", {
      schemaPath: "./src/db/root-schema.ts",
      moduleId: "virtual:validators-valibot",
      outputPath: "./src/gen/valibot",
      useCache: true,
      regenOnBuild: true,
      emitRootDts: true,
    }),
  ],
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
    lib: { entry: "./src/virtual-entry.ts", formats: ["es"] },
  },
});
