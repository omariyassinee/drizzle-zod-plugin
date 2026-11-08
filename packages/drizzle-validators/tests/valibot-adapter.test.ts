import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { valibotAdapter } from "../src/adapters/valibot";
import { generateSchemas } from "../src/schema-generator";
import { writeGeneratedFiles } from "../src/file-writer";
import { getResolvedPaths } from "../src/paths";
import * as v from "valibot";

const throwCtx = { bufferAs: "throw", depth: 0 } as const;

// Emission unit tests — fixtures are REAL valibot schemas built the same way
// drizzle-orm/valibot builds them (verified against valibot@1.5.0: wrappers
// nest via `wrapped`, constraints ride on `pipe`, no defaults are attached).

test("plain leaves emit bare v.* builders", () => {
	expect(valibotAdapter.emit(v.string(), throwCtx)).toBe("v.string()");
	expect(valibotAdapter.emit(v.number(), throwCtx)).toBe("v.number()");
	expect(valibotAdapter.emit(v.boolean(), throwCtx)).toBe("v.boolean()");
	expect(valibotAdapter.emit(v.date(), throwCtx)).toBe("v.date()");
	expect(valibotAdapter.emit(v.unknown(), throwCtx)).toBe("v.unknown()");
});

test("constraints emit v.pipe with the action chain", () => {
	expect(
		valibotAdapter.emit(
			v.pipe(v.number(), v.minValue(-2147483648), v.maxValue(2147483647), v.integer()),
			throwCtx,
		),
	).toBe(
		"v.pipe(v.number(), v.minValue(-2147483648), v.maxValue(2147483647), v.integer())",
	);
	expect(
		valibotAdapter.emit(v.pipe(v.string(), v.maxLength(255)), throwCtx),
	).toBe("v.pipe(v.string(), v.maxLength(255))");
	expect(valibotAdapter.emit(v.pipe(v.string(), v.uuid()), throwCtx)).toBe(
		"v.pipe(v.string(), v.uuid())",
	);
});

test("wrappers emit v.optional / v.nullable nesting", () => {
	expect(
		valibotAdapter.emit(v.optional(v.nullable(v.boolean())), throwCtx),
	).toBe("v.optional(v.nullable(v.boolean()))");
});

test("enum emits v.enum with quoted keys", () => {
	expect(
		valibotAdapter.emit(v.enum_({ happy: "happy", sad: "sad" }), throwCtx),
	).toBe('v.enum({ "happy": "happy", "sad": "sad" })');
});

test("picklist emits v.picklist", () => {
	expect(
		valibotAdapter.emit(v.picklist(["a", "b"]), throwCtx),
	).toBe('v.picklist(["a", "b"])');
});

test("union emits v.union with emitted members", () => {
	expect(
		valibotAdapter.emit(
			v.union([v.string(), v.number(), v.null()]),
			throwCtx,
		),
	).toBe("v.union([v.string(), v.number(), v.null()])");
});

test("records emit v.record(key, value)", () => {
	expect(
		valibotAdapter.emit(v.record(v.string(), v.any()), throwCtx),
	).toBe("v.record(v.string(), v.any())");
});

test("arrays emit v.array(item)", () => {
	expect(valibotAdapter.emit(v.array(v.string()), throwCtx)).toBe(
		"v.array(v.string())",
	);
});

test("objects emit v.object with quoted keys and 2-space indent", () => {
	expect(
		valibotAdapter.emit(
			v.object({ name: v.string(), age: v.optional(v.number()) }),
			throwCtx,
		),
	).toBe(
		[
			"v.object({",
			'  "name": v.string(),',
			'  "age": v.optional(v.number())',
			"})",
		].join("\n"),
	);
});

test("literal emits v.literal", () => {
	expect(valibotAdapter.emit(v.literal("x"), throwCtx)).toBe('v.literal("x")');
});

test("metadata pipe actions are skipped", () => {
	expect(
		valibotAdapter.emit(
			v.pipe(v.string(), v.metadata({ desc: "x" }), v.uuid()),
			throwCtx,
		),
	).toBe("v.pipe(v.string(), v.uuid())");
});

test("regex actions serialize the pattern literally", () => {
	expect(
		valibotAdapter.emit(v.pipe(v.string(), v.regex(/^a+$/u)), throwCtx),
	).toBe("v.pipe(v.string(), v.regex(/^a+$/u))");
});

test("instance schemas honor the bufferAs policy (P2-02 parity)", () => {
	class Buffer2 {}
	expect(() =>
		valibotAdapter.emit(v.instance(Buffer2 as any), throwCtx),
	).toThrow(/Node-only instance schema/);
	expect(
		valibotAdapter.emit(v.instance(Buffer2 as any), {
			bufferAs: "keep",
			depth: 0,
		}),
	).toBe("v.instance(Buffer2)");
});

test("custom Buffer predicates (drizzle rc.5 blob encoding) honor the bufferAs policy", () => {
	// drizzle-orm rc.5+ emits blob({ mode: "buffer" }) as v.custom((x) => x instanceof Buffer)
	const bufferCustom: any = v.custom((input: unknown) => input instanceof Buffer);
	expect(() => valibotAdapter.emit(bufferCustom, throwCtx)).toThrow(
		/Node-only Buffer validator/,
	);
	expect(
		valibotAdapter.emit(bufferCustom, { bufferAs: "keep", depth: 0 }),
	).toBe("v.instance(Buffer)");
});

test("non-Buffer custom predicates still fail loud (not mistaken for Buffer)", () => {
	const symbolCustom: any = v.custom((input: unknown) => typeof input === "symbol");
	expect(() => valibotAdapter.emit(symbolCustom, throwCtx)).toThrow(
		/Unserializable valibot schema node/,
	);
	// accept-everything predicates must not be misdetected as Buffer either
	const acceptAll: any = v.custom(() => true);
	expect(() => valibotAdapter.emit(acceptAll, throwCtx)).toThrow(
		/Unserializable valibot schema node/,
	);
});

test("unknown action types fail loud with an actionable message", () => {
	const weird: any = v.pipe(
		v.string(),
		{
			kind: "validation",
			type: "totally_unknown",
			requirement: undefined,
			async: false,
			"~run": () => null,
		} as any,
	);
	expect(() => valibotAdapter.emit(weird, throwCtx)).toThrow(
		/Unserializable valibot schema node/,
	);
});

test("unknown schema types fail loud", () => {
	const weird: any = {
		kind: "schema",
		type: "variant",
		async: false,
		"~run": () => null,
	};
	expect(() => valibotAdapter.emit(weird, throwCtx)).toThrow(
		/unknown schema type/,
	);
});

test("recursion depth guard fires", () => {
	let node: any = v.string();
	for (let i = 0; i < 150; i++) node = v.optional(node);
	expect(() => valibotAdapter.emit(node, throwCtx)).toThrow(
		/Maximum recursion depth/,
	);
});

// --- Integration: real drizzle tables through the full pipeline -----------

const OUT = "./.drizzle-validators-generated/valibot-target-test";

async function generateAndWrite() {
	const schemaPath = "./tests/fixtures/adapter-table.ts";
	const paths = getResolvedPaths(
		schemaPath,
		{ outputPath: OUT },
		process.cwd(),
		true,
	);
	const data = await generateSchemas({
		absoluteSchemaPath: paths.absoluteSchemaPath,
		schemaPath,
		tmpDir: paths.tmpDir,
		viteRoot: process.cwd(),
		target: "valibot",
		serializer: { bufferAs: "throw" },
	});
	await writeGeneratedFiles({
		paths,
		options: { outputPath: OUT, splitByTable: true },
		viteRoot: process.cwd(),
		splitByTable: true,
		moduleId: "virtual:drizzle-validators",
		data,
	});
	return { data, paths };
}

test("target=valibot generates per-table files importing valibot, no refineZSchema", async () => {
	rmSync(OUT, { recursive: true, force: true });
	const { data, paths } = await generateAndWrite();

	expect(data.target).toBe("valibot");
	expect(data.importStatement).toBe("import * as v from 'valibot'");
	expect(data.tableCodes.has("tbUsers")).toBe(true);

	const tableCode = data.tableCodes.get("tbUsers")!.code;
	expect(tableCode).toContain("import * as v from 'valibot'");
	expect(tableCode).not.toContain("refineZSchema");
	expect(tableCode).toContain('v.enum({ "happy": "happy", "sad": "sad" })');

	const shim = resolve(
		process.cwd(),
		"node_modules/@types/virtual-drizzle-validators/index.d.ts",
	);
	expect(existsSync(shim)).toBe(true);

	const dts = await Bun.file(shim).text();
	expect(dts).toContain("declare module 'virtual:drizzle-validators/tbUsers'");
	expect(dts).not.toContain("refineZSchema");
});

test("target=valibot emitted code validates correctly via valibot parse", async () => {
	rmSync(OUT, { recursive: true, force: true });
	await generateAndWrite();

	const mod = await import(
		pathToFileURL(resolve(process.cwd(), OUT, "tbUsers.ts")).href
	);

	const validRow = {
		id: 1,
		name: "ada",
		email: "ada@example.com",
		age: 36,
		isActive: true,
		userId: "123e4567-e89b-12d3-a456-426614174000",
		mood: "happy",
		createdAt: new Date(),
		meta: { anything: ["goes", 1, true] },
		tags: ["a", "b"],
	};
	expect(v.parse(mod.selectSchema, validRow)).toEqual(validRow);

	// Wrong primitive type is rejected
	expect(v.safeParse(mod.selectSchema, { ...validRow, name: 42 }).success).toBe(false);
	// Exceeding varchar(255) is rejected
	expect(
		v.safeParse(mod.selectSchema, { ...validRow, email: "x".repeat(256) }).success,
	).toBe(false);
	// Format uuid is enforced
	expect(
		v.safeParse(mod.selectSchema, { ...validRow, userId: "not-a-uuid" }).success,
	).toBe(false);
	// Enum membership is enforced
	expect(v.safeParse(mod.selectSchema, { ...validRow, mood: "angry" }).success).toBe(false);
	// Nullable columns accept null
	expect(
		v.parse(mod.selectSchema, { ...validRow, mood: null, meta: null }),
	).toEqual({ ...validRow, mood: null, meta: null });
	// Missing required column is rejected
	const { name: _n, ...missingName } = validRow;
	expect(v.safeParse(mod.selectSchema, missingName).success).toBe(false);

	// Insert schema: optional columns (id/age/mood/meta) may be omitted
	expect(
		v.parse(mod.insertSchema, {
			name: "ada",
			email: "ada@example.com",
			userId: "123e4567-e89b-12d3-a456-426614174000",
			createdAt: new Date(),
			tags: ["a"],
		}),
	).toBeDefined();
	expect(v.safeParse(mod.insertSchema, { email: "a@b.c" }).success).toBe(false);
	// Invalid enum value rejected on insert too
	expect(
		v.safeParse(mod.insertSchema, {
			name: "ada",
			email: "ada@example.com",
			userId: "123e4567-e89b-12d3-a456-426614174000",
			createdAt: new Date(),
			tags: [],
			mood: "angry",
		}).success,
	).toBe(false);

	// Update schema: everything optional, empty object valid
	expect(v.parse(mod.updateSchema, {})).toEqual({});
	expect(v.safeParse(mod.updateSchema, { name: 123 }).success).toBe(false);
});
