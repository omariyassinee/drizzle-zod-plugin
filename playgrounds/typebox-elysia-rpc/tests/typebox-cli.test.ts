import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
	validateIncomingPacket,
	validatePartialFirmwarePatch,
	validateStoredRecord,
} from "../src/server";
import { telemetryPacketsInsertSchema } from "../src/validators";
import { Value } from "typebox/value";
import { Compile as TypeCompiler } from "typebox/compile";

// PG3: typebox-telemetry-rpc — the single-file CLI workflow on rc.5:
// JSON drizzle config -> --target typebox --no-split --buffer-as keep ->
// JIT-compiled Value.Check at "high-throughput" runtime.

const DV = resolve(process.cwd(), "node_modules/.bin/dv");
const VALIDATORS = resolve(process.cwd(), "src/validators.ts");

function generate(extra: string[] = []) {
	return Bun.spawnSync(
		[
			DV,
			"generate",
			"--config",
			"./drizzle.telemetry.config.json",
			"--target",
			"typebox",
			"--no-split",
			"--output",
			"./src/validators.ts",
			"--buffer-as",
			"keep",
			...extra,
		],
		{ cwd: process.cwd() },
	);
}

const validPacket = {
	id: "123e4567-e89b-12d3-a456-426614174000",
	deviceId: "987e4567-e89b-12d3-a456-426614174999",
	firmware: "v2",
	sequence: 42n,
	uptimeSeconds: 3600,
	signalStrength: "-72.5000",
	sensorMap: { temp: 21, humidity: 55 },
	reportedAt: new Date(),
	firmwareImage: Buffer.from([0x01, 0x02]),
};

test("CLI generates the single-file typebox validators via JSON config", () => {
	rmSync(VALIDATORS, { force: true });
	const proc = generate();
	expect(proc.exitCode).toBe(0);
	expect(existsSync(VALIDATORS)).toBe(true);

	const code = readFileSync(VALIDATORS, "utf-8");
	// single-file shape: all six exports in one module, no per-table files
	expect(code).toContain("export const telemetryPacketsInsertSchema");
	expect(code).toContain("export const deviceRegistryUpdateSchema");
	// rc.5 emission spot-checks
	expect(code).toContain("t.BigInt({ minimum: -9223372036854775808n");
	expect(code).toContain(
		't.Refine(t.Unsafe<Date>({ type: "date" }), (value) => value instanceof Date && !Number.isNaN(value.getTime()))',
	);
	expect(code).toContain("t.Record(t.String(), t.Any())");
	expect(code).toContain('t.Unsafe<Buffer>({ type: "buffer" })'); // bufferAs: keep
	expect(code).not.toContain("refineZSchema"); // non-zod target
	// no drizzle-orm import reaches the generated code
	expect(code).not.toContain("drizzle-orm");
});

test("TypeCompiler JIT-compiles and validates a real packet", () => {
	const result = validateIncomingPacket(validPacket);
	expect(result.valid).toBe(true);
	if (result.valid) {
		expect((result.data as typeof validPacket).sequence).toBe(42n);
	}

	// bad enum + out-of-bounds bigint both rejected with paths
	const bad = validateIncomingPacket({ ...validPacket, firmware: "v9", sequence: 2n ** 63n });
	expect(bad.valid).toBe(false);
	if (!bad.valid) {
		const paths = bad.errors.map((e) => e.path).join("|");
		expect(paths).toContain("/firmware");
		// bigint overflow violates the n-literal bounds
		expect(paths).toContain("/sequence");
	}
});

test("select/update validation: partials pass, required core checks hold", () => {
	// update schema: everything optional, {} valid
	expect(validatePartialFirmwarePatch({ signalStrength: "-80.0000" })).toBe(true);
	expect(validatePartialFirmwarePatch({ deviceId: 123 })).toBe(false);
	// select: uuid format enforced (typebox format registry)
	expect(validateStoredRecord({ ...validPacket, reportedAt: new Date() })).toBe(true);
	expect(
		validateStoredRecord({ ...validPacket, id: "not-a-uuid", reportedAt: new Date() }),
	).toBe(false);
});

test("reportedAt Date column rejects non-Date values at runtime", () => {
	// A bare t.Unsafe({type:"date"}) validates nothing (unknown type
	// strings pass); the emitted Refine predicate carries the real check
	expect(
		Value.Check(telemetryPacketsInsertSchema, { ...validPacket, reportedAt: "not-a-date" }),
	).toBe(false);
	expect(
		Value.Check(telemetryPacketsInsertSchema, { ...validPacket, reportedAt: 1735689600000 }),
	).toBe(false);
	expect(Value.Check(telemetryPacketsInsertSchema, validPacket)).toBe(true);
});

test("bufferAs keep: Unsafe marker passes check but performs no Buffer check", () => {
	// documented honest limitation: t.Unsafe round-trips the {type:"buffer"}
	// marker without runtime checking — Buffer-ness belongs to the consumer
	const schema = telemetryPacketsInsertSchema;
	expect(Value.Check(schema, { ...validPacket, firmwareImage: "not a buffer" })).toBe(true);
	expect(Value.Check(schema, validPacket)).toBe(true);
});

test("bufferAs throw (default) fails loud on the Buffer columns", () => {
	const proc = Bun.spawnSync(
		[
			DV,
			"generate",
			"--config",
			"./drizzle.telemetry.config.json",
			"--target",
			"typebox",
			"--no-split",
			"--output",
			"./src/validators-throw.ts",
		],
		{ cwd: process.cwd() },
	);
	expect(proc.exitCode).toBe(1);
	expect(new TextDecoder().decode(proc.stderr)).toContain(
		"Node-only Buffer schema",
	);
	expect(existsSync(resolve(process.cwd(), "src/validators-throw.ts"))).toBe(false);
});

test("TypeCompiler is reusable across many checks (JIT, not per-call)", () => {
	const compiled = TypeCompiler(telemetryPacketsInsertSchema);
	const iterations = 1000;
	let accepted = 0;
	for (let i = 0; i < iterations; i++) {
		if (compiled.Check({ ...validPacket, sequence: BigInt(i) })) accepted++;
	}
	expect(accepted).toBe(iterations);
});
