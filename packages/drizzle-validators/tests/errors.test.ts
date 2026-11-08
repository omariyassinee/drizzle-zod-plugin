import { expect, test } from "bun:test";
import {
	DrizzleValidatorsError,
	isDrizzleValidatorsError,
	formatError,
} from "../src/errors";

test("DrizzleValidatorsError: named, actionable, stack-less", () => {
	const e = new DrizzleValidatorsError("Column X cannot be serialized");
	expect(e).toBeInstanceOf(Error);
	expect(e.name).toBe("DrizzleValidatorsError");
	expect(isDrizzleValidatorsError(e)).toBe(true);
	expect(e.message).toBe("Column X cannot be serialized");
	// no stack: loggers (CLI, Vite, rolldown) print only the clear message
	expect(e.stack).toBeUndefined();
});

test("plain Errors keep their stack (unexpected -> traceable)", () => {
	const e = new TypeError("boom");
	expect(isDrizzleValidatorsError(e)).toBe(false);
	const formatted = formatError(e);
	expect(formatted).toContain("Unexpected error");
	expect(formatted).toContain("TypeError: boom");
	expect(formatted).toContain("at "); // stack frames present
});

test("formatError: known errors render a branded one-liner", () => {
	const out = formatError(new DrizzleValidatorsError("No tables found"));
	expect(out).toBe("[drizzle-validators] No tables found");
	expect(out).not.toContain("at ");
});

test("formatError: cause chains render recursively", () => {
	const inner = new DrizzleValidatorsError("creator module missing");
	const outer = new Error("generation failed", { cause: inner });
	const out = formatError(outer);
	expect(out).toContain("Unexpected error");
	expect(out).toContain("caused by:");
	expect(out).toContain("[drizzle-validators] creator module missing");
});

test("formatError: non-Error throwables still render", () => {
	expect(formatError("plain string")).toContain("plain string");
});
