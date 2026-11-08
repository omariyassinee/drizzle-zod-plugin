/**
 * Phase-2 bug-fix test suite for BUG-REPORT.md findings P2-01…P2-18.
 *
 * Each file maps 1:1 to a finding ID and asserts the FIXED behavior:
 * the fail-loud guard (P2-01), Buffer policy (P2-02), type-filtered check
 * transfer (P2-03), lazy default preservation (P2-04), special-value
 * literals (P2-05), tuple rest (P2-06), url params (P2-07), mapped enums
 * (P2-08), cache versioning (P2-09), output reconciliation (P2-10),
 * peer-resolution DX (P2-11), tmp-dir cleanup (P2-12), config-rename
 * re-watch (P2-13), dynamic-import fingerprints (P2-14), corrupt-envelope
 * rejection (P2-15), symbol keys (P2-16), rm/write sequencing (P2-17),
 * overwrite probes (P2-18).
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

export { roundtripEval, firstIssue } from "../_helpers";

/** Data-URI evaluate emitted code and return the default export. */
export async function evalDefault(code: string): Promise<any> {
	const base64 = Buffer.from(
		`import * as z from "zod";\nexport default ${code};`,
	).toString("base64");
	const mod = await import(
		/* @vite-ignore */ `data:text/javascript;base64,${base64}`
	);
	return mod.default;
}

export { expect, test };

/** Builds a sha1 key (mirrors the plugin's cache key derivation). */
export function sha1(...parts: string[]): string {
	const h = createHash("sha1");
	for (const p of parts) h.update(p);
	return h.digest("hex");
}
