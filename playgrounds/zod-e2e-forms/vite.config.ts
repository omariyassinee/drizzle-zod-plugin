import { defineConfig } from "vite";
import { drizzleValidators } from "drizzle-validators";

// Zero-config internal mode: schemaPath AND outputPath omitted — the schema
// is auto-detected from drizzle.config.ts, generated files stay hidden in
// node_modules, and types come from the hidden @types shim.
export default defineConfig({
	plugins: [drizzleValidators("zod", { useCache: true })],
	build: { target: "esnext" },
});
