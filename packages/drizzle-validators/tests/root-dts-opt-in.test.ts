import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzleValidators } from "../src/plugin";

const OUT = "./.drizzle-validators-generated/root-dts-opt-in-test";

async function runPlugin(options: Parameters<typeof drizzleValidators>[1]) {
	const plugin = drizzleValidators("zod", {
		schemaPath: "./tests/fixtures/adapter-table.ts",
		outputPath: OUT,
		regenOnBuild: true,
		...options,
	}) as any;
	plugin.configResolved({ root: process.cwd(), command: "build" });
	await plugin.buildStart();
}

test("default: no project-tree d.ts, @types shim carries the types", async () => {
	rmSync(OUT, { recursive: true, force: true });
	const shimDir = resolve(
		process.cwd(),
		"node_modules/@types/virtual-drizzle-validators",
	);
	rmSync(shimDir, { recursive: true, force: true });

	await runPlugin({});

	const shim = resolve(shimDir, "index.d.ts");
	expect(existsSync(shim)).toBe(true);
	expect(readFileSync(shim, "utf-8")).toContain(
		"declare module 'virtual:drizzle-validators'",
	);
	// neither the output dir nor the project root got a declaration file
	expect(existsSync(resolve(process.cwd(), OUT, "virtual-drizzle-validators.d.ts"))).toBe(false);
	expect(existsSync(resolve(process.cwd(), "virtual-drizzle-validators.d.ts"))).toBe(false);
});

test("emitRootDts: writes the project-tree declaration on demand", async () => {
	rmSync(OUT, { recursive: true, force: true });
	const rootDts = resolve(process.cwd(), "virtual-drizzle-validators.d.ts");
	rmSync(rootDts, { force: true });

	await runPlugin({ emitRootDts: true });

	const dts = resolve(process.cwd(), OUT, "virtual-drizzle-validators.d.ts");
	expect(existsSync(dts)).toBe(true);
	expect(readFileSync(dts, "utf-8")).toContain(
		"declare module 'virtual:drizzle-validators'",
	);
	rmSync(rootDts, { force: true });
});

test("unwritable @types location: falls back to project-tree d.ts with a warning", async () => {
	rmSync(OUT, { recursive: true, force: true });
	const shimIndex = resolve(
		process.cwd(),
		"node_modules/@types/virtual-drizzle-validators",
	);
	// A FILE where the shim directory must be created forces the write to fail
	rmSync(shimIndex, { recursive: true, force: true });
	writeFileSync(shimIndex, "blocker", "utf8");

	try {
		await runPlugin({});
		const dts = resolve(
			process.cwd(),
			OUT,
			"virtual-drizzle-validators.d.ts",
		);
		expect(existsSync(dts)).toBe(true);
		expect(readFileSync(dts, "utf-8")).toContain(
			"declare module 'virtual:drizzle-validators'",
		);
	} finally {
		rmSync(shimIndex, { force: true });
	}
});
