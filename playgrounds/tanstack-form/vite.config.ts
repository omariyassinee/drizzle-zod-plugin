import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { drizzleValidators } from "drizzle-validators";

// Zero-config internal mode + regenOnBuild so a fresh checkout builds.
export default defineConfig({
	plugins: [
		react(),
		drizzleValidators("zod", { useCache: true, regenOnBuild: true }),
	],
	build: { target: "esnext" },
});
