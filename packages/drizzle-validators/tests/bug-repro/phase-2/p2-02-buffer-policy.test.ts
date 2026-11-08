import { zodTypeToCode } from "../../../src/zod-serializer";
import { expect, test } from "./_helpers";
import { z } from "zod";

// P2-02: schemas carrying an `instanceof Buffer` predicate (drizzle's
// blob({ mode: "buffer" }) columns round-trip through drizzle-zod as
// z.custom((v) => v instanceof Buffer)) emitted `z.instanceof(Buffer)`
// into client-safe modules — Node-only global, import-time crash in
// browsers/serverless. Default behavior now FAILS LOUD; `bufferAs: "keep"`
// opts back in deliberately.

const bufferLike = z.custom((v: unknown) => v instanceof Buffer);

test("P2-02: instanceof Buffer predicate fails loud by default", () => {
	expect(() => zodTypeToCode(bufferLike)).toThrow(
		/z\.instanceof\(Buffer\)[\s\S]*bufferAs: "keep"/,
	);
});

test("P2-02: bufferAs 'keep' opts back into the old behavior", () => {
	const code = zodTypeToCode(bufferLike, undefined, 0, {
		bufferAs: "keep",
	});
	expect(code).toBe("z.instanceof(Buffer)");
});

test("P2-02: non-Buffer custom predicates still fail loud either way", () => {
	const runtimeOnly = z.custom((v: unknown) => typeof v === "bigint");
	expect(() => zodTypeToCode(runtimeOnly)).toThrow(
		/Cannot serialize z\.custom\(\)/,
	);
	expect(() =>
		zodTypeToCode(runtimeOnly, undefined, 0, { bufferAs: "keep" }),
	).toThrow(/Cannot serialize z\.custom\(\)/);
});

test("P2-02: plain custom (no predicate) unchanged", () => {
	expect(zodTypeToCode(z.custom())).toBe("z.custom()");
});
