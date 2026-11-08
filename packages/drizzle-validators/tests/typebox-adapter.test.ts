import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { typeboxAdapter } from "../src/adapters/typebox";
import { generateSchemas } from "../src/schema-generator";
import { writeGeneratedFiles } from "../src/file-writer";
import { getResolvedPaths } from "../src/paths";
import { Value } from "typebox/value";

// Emission unit tests — each branch of the JSON Schema -> Type.* mapping,
// using the exact node shapes drizzle-orm/typebox produces (spike-verified:
// plain JSON Schema, no [Kind] symbols).

test("empty schema (drizzle's Any encoding) emits t.Any()", () => {
	expect(typeboxAdapter.emit({}, { bufferAs: "throw", depth: 0 })).toBe(
		"t.Any()",
	);
});

test("string constraints and format emit t.String({...})", () => {
	expect(
		typeboxAdapter.emit(
			{ type: "string", maxLength: 255, minLength: 1, pattern: "^a+$" },
			{ bufferAs: "throw", depth: 0 },
		),
	).toBe(
		't.String({ minLength: 1, maxLength: 255, pattern: "^a+$" })',
	);
	expect(
		typeboxAdapter.emit(
			{ type: "string", format: "uuid" },
			{ bufferAs: "throw", depth: 0 },
		),
	).toBe('t.String({ format: "uuid" })');
});

test("integer bounds emit t.Integer({...})", () => {
	expect(
		typeboxAdapter.emit(
			{ type: "integer", minimum: -2147483648, maximum: 2147483647 },
			{ bufferAs: "throw", depth: 0 },
		),
	).toBe("t.Integer({ minimum: -2147483648, maximum: 2147483647 })");
});

test("nullable columns emit t.Union with t.Null()", () => {
	expect(
		typeboxAdapter.emit(
			{ anyOf: [{ type: "string" }, { type: "null" }] },
			{ bufferAs: "throw", depth: 0 },
		),
	).toBe("t.Union([t.String(), t.Null()])");
});

test("pg enum emits union of literals", () => {
	expect(
		typeboxAdapter.emit(
			{ enum: ["happy", "sad"] },
			{ bufferAs: "throw", depth: 0 },
		),
	).toBe('t.Union([t.Literal("happy"), t.Literal("sad")])');
});

test("objects emit t.Object with t.Optional for non-required props", () => {
	expect(
		typeboxAdapter.emit(
			{
				type: "object",
				required: ["name"],
				properties: {
					name: { type: "string" },
					age: { anyOf: [{ type: "integer" }, { type: "null" }] },
				},
			},
			{ bufferAs: "throw", depth: 0 },
		),
	).toBe(
		[
			"t.Object({",
			'  "name": t.String(),',
			'  "age": t.Optional(t.Union([t.Integer(), t.Null()]))',
			"})",
		].join("\n"),
	);
});

test("booleans emit t.Boolean()", () => {
	expect(
		typeboxAdapter.emit({ type: "boolean" }, { bufferAs: "throw", depth: 0 }),
	).toBe("t.Boolean()");
});

test("arrays emit t.Array with items", () => {
	expect(
		typeboxAdapter.emit(
			{ type: "array", items: { type: "string" } },
			{ bufferAs: "throw", depth: 0 },
		),
	).toBe("t.Array(t.String())");
});

test("JSON-value record (match-all patternProperties) emits t.Record", () => {
	expect(
		typeboxAdapter.emit(
			{ type: "object", patternProperties: { "^.*$": {} } },
			{ bufferAs: "throw", depth: 0 },
		),
	).toBe("t.Record(t.String(), t.Any())");
});

test("bigint bounds emit bigint literals", () => {
	expect(
		typeboxAdapter.emit(
			{
				type: "bigint",
				minimum: -9223372036854775808n,
				maximum: 9223372036854775807n,
			},
			{ bufferAs: "throw", depth: 0 },
		),
	).toBe(
		"t.BigInt({ minimum: -9223372036854775808n, maximum: 9223372036854775807n })",
	);
});

test("metadata keys are ignored", () => {
	expect(
		typeboxAdapter.emit(
			{ type: "string", title: "x", description: "y", default: "z" },
			{ bufferAs: "throw", depth: 0 },
		),
	).toBe("t.String()");
});

test("unrecognized constraint keys fail loud with an actionable message", () => {
	expect(() =>
		typeboxAdapter.emit(
			{ type: "string", contentMediaType: "image/png" },
			{ bufferAs: "throw", depth: 0 },
		),
	).toThrow(/Unserializable JSON Schema node/);
});

test("symbol-bearing nodes (custom factory TSchema) fail loud", () => {
	const node: any = { type: "string" };
	const sym = Symbol("Kind");
	node[sym] = "String";
	expect(() =>
		typeboxAdapter.emit(node, { bufferAs: "throw", depth: 0 }),
	).toThrow(/Unserializable JSON Schema node/);
});

test("TBuffer instances honor the bufferAs policy (P2-02 parity)", () => {
	class TBuffer {}
	expect(() =>
		typeboxAdapter.emit(new TBuffer(), { bufferAs: "throw", depth: 0 }),
	).toThrow(/Node-only Buffer schema/);
	expect(
		typeboxAdapter.emit(new TBuffer(), { bufferAs: "keep", depth: 0 }),
	).toBe("t.Unknown()");
});

test("buffer markers (drizzle rc.5 bytea/blob encoding) honor the bufferAs policy", () => {
	expect(() =>
		typeboxAdapter.emit({ type: "buffer" }, { bufferAs: "throw", depth: 0 }),
	).toThrow(/Node-only Buffer schema/);
	expect(
		typeboxAdapter.emit({ type: "buffer" }, { bufferAs: "keep", depth: 0 }),
	).toBe('t.Unsafe<Buffer>({ type: "buffer" })');
	// wrapped in a nullable union, as rc.5 emits it for optional columns
	expect(
		typeboxAdapter.emit(
			{ anyOf: [{ type: "buffer" }, { type: "null" }] },
			{ bufferAs: "keep", depth: 0 },
		),
	).toBe('t.Union([t.Unsafe<Buffer>({ type: "buffer" }), t.Null()])');
});

test("recursion depth guard fires", () => {
	const deep: any = { anyOf: [{ type: "null" }] };
	let node = deep;
	for (let i = 0; i < 150; i++) {
		node.anyOf = [{ anyOf: [] }];
		node = node.anyOf[0];
	}
	expect(() =>
		typeboxAdapter.emit(deep, { bufferAs: "throw", depth: 0 }),
	).toThrow(/Maximum recursion depth/);
});

// --- Integration: real drizzle tables through the full pipeline -----------

const OUT = "./.drizzle-validators-generated/typebox-target-test";

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
		target: "typebox",
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

test("target=typebox generates per-table files importing typebox, no refineZSchema", async () => {
	rmSync(OUT, { recursive: true, force: true });
	const { data, paths } = await generateAndWrite();

	expect(data.target).toBe("typebox");
	expect(data.importStatement).toBe("import * as t from 'typebox'");
	expect(data.tableCodes.has("tbUsers")).toBe(true);

	const tableCode = data.tableCodes.get("tbUsers")!.code;
	expect(tableCode).toContain("import * as t from 'typebox'");
	expect(tableCode).not.toContain("refineZSchema");
	expect(tableCode).toContain("t.Union([t.Literal(\"happy\"), t.Literal(\"sad\")])");

	// Types surface via the hidden @types shim (shared across targets)
	const shim = resolve(
		process.cwd(),
		"node_modules/@types/virtual-drizzle-validators/index.d.ts",
	);
	expect(existsSync(shim)).toBe(true);

	const dts = await Bun.file(shim).text();
	expect(dts).toContain("declare module 'virtual:drizzle-validators/tbUsers'");
	// refineZSchema line is zod-only
	expect(dts).not.toContain("refineZSchema");
});

test("target=typebox emitted code validates correctly via typebox Value", async () => {
	rmSync(OUT, { recursive: true, force: true });
	await generateAndWrite();

	const mod = await import(
		pathToFileURL(resolve(process.cwd(), OUT, "tbUsers.ts")).href
	);

	// Select schema: all columns, name/email/userId/createdAt/tags required
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
	expect(Value.Check(mod.selectSchema, validRow)).toBe(true);

	// Wrong primitive type is rejected
	expect(Value.Check(mod.selectSchema, { ...validRow, name: 42 })).toBe(false);
	// Exceeding varchar(255) is rejected
	expect(Value.Check(mod.selectSchema, { ...validRow, email: "x".repeat(256) })).toBe(false);
	// Format uuid is enforced
	expect(Value.Check(mod.selectSchema, { ...validRow, userId: "not-a-uuid" })).toBe(false);
	// Enum membership is enforced
	expect(Value.Check(mod.selectSchema, { ...validRow, mood: "angry" })).toBe(false);
	// Date columns are actually validated — a bare Unsafe {type:"date"}
	// falls through typebox's unknown-type dispatch and accepts anything
	expect(Value.Check(mod.selectSchema, { ...validRow, createdAt: "not-a-date" })).toBe(false);
	expect(Value.Check(mod.selectSchema, { ...validRow, createdAt: 1735689600000 })).toBe(false);
	expect(Value.Check(mod.selectSchema, { ...validRow, createdAt: new Date("nope") })).toBe(false);
	// Nullable columns accept null
	expect(Value.Check(mod.selectSchema, { ...validRow, mood: null, meta: null })).toBe(true);
	// Missing required column is rejected
	const { name: _n, ...missingName } = validRow;
	expect(Value.Check(mod.selectSchema, missingName)).toBe(false);

	// Insert schema: optional columns (id/age/mood/meta) may be omitted,
	// required ones may not
	expect(
		Value.Check(mod.insertSchema, {
			name: "ada",
			email: "ada@example.com",
			userId: "123e4567-e89b-12d3-a456-426614174000",
			createdAt: new Date(),
			tags: ["a"],
		}),
	).toBe(true);
	expect(Value.Check(mod.insertSchema, { email: "a@b.c" })).toBe(false);
	// Invalid enum value rejected on insert too
	expect(
		Value.Check(mod.insertSchema, {
			name: "ada",
			email: "ada@example.com",
			userId: "123e4567-e89b-12d3-a456-426614174000",
			createdAt: new Date(),
			tags: [],
			mood: "angry",
		}),
	).toBe(false);

	// Update schema: everything optional, empty object valid
	expect(Value.Check(mod.updateSchema, {})).toBe(true);
	expect(
		Value.Check(mod.updateSchema, { name: 123 }),
	).toBe(false);
});
