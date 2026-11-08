import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { zodTypeToCode, urlFallbackChainCode } from "../src/zod-serializer";

// Edge cases from the adversarial audit: lazy-default freeze (#2), url
// protocol array handling (#1), and readonly/catch wrapper coverage (#5).

describe("lazy default serialization (P2-04)", () => {
	test(".default(nondeterministic fn) fails loud instead of freezing", () => {
		// zod 4.6 wraps ALL defaults in a def getter, so the serializer
		// probes DETERMINISM: a callback returning fresh values each call
		// cannot be emitted without freezing one snapshot.
		const schema = z.date().default(() => new Date());
		expect(() => zodTypeToCode(schema)).toThrow(
			/Cannot serialize a lazy .default/,
		);
	});

	test(".default(deterministic fn) serializes faithfully", () => {
		// A callback that always returns the same timestamp is
		// semantically identical to that constant — emitting it is exact.
		const code = zodTypeToCode(z.date().default(() => new Date(2020, 0, 1)));
		expect(code).toContain(".default(new Date(");
	});

	test("static .default(value) still serializes", () => {
		const code = zodTypeToCode(z.string().default("fallback"));
		expect(code).toContain('.default("fallback")');
	});
});

describe("url protocol constraints", () => {
	test("multiple protocols all survive the fallback chain", () => {
		const code = urlFallbackChainCode({
			protocol: ["http:", "https:"],
		});
		expect(code).toBe("z.url().regex(/^(?:http:\\/\\/|https:\\/\\/)/)");
	});

	test("a single protocol stays a startsWith check", () => {
		const code = urlFallbackChainCode({ protocol: ["https:"] });
		expect(code).toBe('z.url().startsWith("https://")');
	});

	test("protocols without the colon are normalized", () => {
		const code = urlFallbackChainCode({ protocol: ["http", "https"] });
		expect(code).toBe("z.url().regex(/^(?:http:\\/\\/|https:\\/\\/)/)");
	});
});

describe("readonly / catch wrappers", () => {
	test("readonly round-trips as .readonly()", () => {
		const code = zodTypeToCode(z.string().readonly());
		expect(code).toBe("z.string().readonly()");
	});

	test("readonly composes with nullable wrappers", () => {
		const code = zodTypeToCode(z.string().nullable().readonly());
		expect(code).toBe("z.string().nullable().readonly()");
	});

	test(".catch() fails loud instead of freezing the fallback", () => {
		// zod 4 stores catchValue as a function even for static catches —
		// indistinguishable from a lazy computation, so emitting would risk
		// freezing one snapshot.
		expect(() => zodTypeToCode(z.string().catch("fallback"))).toThrow(
			/Cannot serialize a \.catch/,
		);
	});
});
