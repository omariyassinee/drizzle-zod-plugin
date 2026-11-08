import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { drizzleValidators } from "@vacuus/drizzle-validators";

// Zero-config internal mode: schema auto-detected from drizzle.config.ts,
// generated files stay hidden in node_modules, types from the @types shim.
// regenOnBuild regenerates during production builds so a fresh checkout
// builds without a prior `dv generate` step.
export default defineConfig({
	plugins: [
		react(),
		drizzleValidators("zod", { useCache: true, regenOnBuild: true }),
	],
	build: { target: "esnext" },
});
