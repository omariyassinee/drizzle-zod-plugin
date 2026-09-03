/**
 * Bug-repro suite for BUG-REPORT.md findings.
 *
 * These tests CONFIRM the bugs documented in BUG-REPORT.md. They are written
 * to FAIL while the bugs exist and PASS once they are fixed.
 *
 * Conventions:
 *  - Each test maps to a bug ID (C1, C2, C3, H1, H2, H3, H4, H5, M1, M6).
 *  - Tests use the REAL exports from src/ (refineSchema, zodTypeToCode, runCli)
 *    against the REAL installed zod@4.4.3 — no mocks.
 *  - Where a bug is "silent loosening", the test asserts the loosening is
 *    detected (i.e. it fails today, proving the bug).
 */
import { expect, test } from "bun:test";

export { default as pkg } from "../../package.json";

/** Round-trip a schema through the serializer and evaluate the emitted code. */
export async function roundtripEval(code: string): Promise<any> {
	// Bun 1.4.0 returns the raw URL string as the default export for
	// non-base64 data URIs — base64 encoding is required for the import
	// to actually evaluate the module.
	const base64Code = Buffer.from(
		`import * as z from "zod";\nexport default ${code};`,
	).toString("base64");
	const mod = await import(
		/* @vite-ignore */ `data:text/javascript;base64,${base64Code}`
	);
	return mod.default;
}

/** Assert helper: expect a parse to fail, and return the first issue message. */
export function firstIssue(result: {
	success: boolean;
	error?: { issues: Array<{ message: string }> };
}): string | undefined {
	return result.error?.issues?.[0]?.message;
}
