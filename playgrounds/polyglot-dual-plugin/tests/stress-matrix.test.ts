import { expect, test, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as valibot from "valibot";
import { drizzleValidators } from "drizzle-validators";

// Differential matrix (audit #4): the same DDL must produce semantically
// identical validators on zod and valibot. Every boundary payload is
// accepted/rejected IDENTICALLY by both targets. Schemas are generated
// through the real plugin serving path and evaluated from the written
// artifacts (fixture: src/db/stress-tables.ts).

const ROOT = process.cwd();

afterAll(() => {
	rmSync(join(ROOT, "src/gen/stress-zod"), { recursive: true, force: true });
	rmSync(join(ROOT, "src/gen/stress-valibot"), { recursive: true, force: true });
});

test("zod and valibot agree on every boundary payload (differential matrix)", async () => {
	const zodPlugin = drizzleValidators("zod", {
		schemaPath: "./src/db/stress-tables.ts",
		moduleId: "virtual:stress-zod",
		outputPath: "./src/gen/stress-zod",
	}) as any;
	const valibotPlugin = drizzleValidators("valibot", {
		schemaPath: "./src/db/stress-tables.ts",
		moduleId: "virtual:stress-valibot",
		outputPath: "./src/gen/stress-valibot",
	}) as any;
	zodPlugin.configResolved({ root: ROOT, command: "serve" });
	valibotPlugin.configResolved({ root: ROOT, command: "serve" });
	await zodPlugin.load("\0virtual:stress-zod");
	await valibotPlugin.load("\0virtual:stress-valibot");

	const zodMod = await import(
		pathToFileURL(resolve(ROOT, "src/gen/stress-zod/stress.ts")).href
	);
	const valibotMod = await import(
		pathToFileURL(resolve(ROOT, "src/gen/stress-valibot/stress.ts")).href
	);

	const base = { status: "active", active: true };
	const cases: Array<[string, Record<string, unknown>, boolean]> = [
		["minimal (defaults omitted)", {}, true],
		["jsonb object", { meta: { a: 1 } }, true],
		["jsonb array", { meta: [1, 2, 3] }, true],
		["jsonb string", { meta: "str" }, true],
		["jsonb number", { meta: 42 }, true],
		["jsonb boolean", { meta: true }, true],
		["jsonb null", { meta: null }, true],
		["jsonb function", { meta: () => {} }, false],
		["tags empty", { tags: [] }, true],
		["tags strings", { tags: ["a"] }, true],
		["tags numbers", { tags: [123] }, false],
		["tags string", { tags: "nope" }, false],
		["count int max", { count: 2147483647 }, true],
		["count int max+1", { count: 2147483648 }, false],
		["count int min-1", { count: -2147483649 }, false],
		["small smallint max", { small: 32767 }, true],
		["small smallint max+1", { small: 32768 }, false],
		["bigNum 2**53-1 (int53 edge)", { bigNum: 2 ** 53 - 1 }, true],
		["bigNum 2**53 (out of int53)", { bigNum: 2 ** 53 }, false],
		["bigBig 2n**62n", { bigBig: 2n ** 62n }, true],
		["bigBig 2n**63n", { bigBig: 2n ** 63n }, false],
		["bigBig string", { bigBig: "5" }, false],
		["nickname 32 chars", { nickname: "x".repeat(32) }, true],
		["nickname 33 chars", { nickname: "x".repeat(33) }, false],
		["bio null", { bio: null }, true],
		["bio number", { bio: 123 }, false],
		["status invalid enum", { status: "pending" }, false],
		["score null (defaulted NOT NULL)", { score: null }, false],
		["active string", { active: "yes" }, false],
	];

	for (const [name, override, expected] of cases) {
		const payload = { ...base, ...override };
		const zodOk = zodMod.insertSchema.safeParse(payload).success;
		const valibotOk = valibot.safeParse(
			valibotMod.insertSchema,
			payload,
		).success;
		expect(zodOk, `zod: ${name}`).toBe(expected);
		expect(valibotOk, `valibot: ${name}`).toBe(expected);
	}
});
