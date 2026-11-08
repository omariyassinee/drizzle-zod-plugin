/**
 * Resolves the canonical builder name for a Zod 4 string format definition.
 *
 * Zod 4 collapses several builders onto shared def formats:
 *   - `z.uuidv4()` → `{ format: "uuid", version: "v4" }`
 *   - `z.httpUrl()` → `{ format: "url", protocol, hostname }`
 * The raw def.format alone would emit the weaker base builder and lose the
 * version/protocol constraints (finding H2).
 *
 * Shared between `zod-serializer.ts` (emission) and `error-map.ts` (dispatch),
 * so the two can never drift apart.
 */
export function resolveStringFormatName(
	def: Record<string, any>,
): string | undefined {
	if (def.format === "uuid") {
		if (def.version === "v4") return "uuidv4";
		if (def.version === "v6") return "uuidv6";
		if (def.version === "v7") return "uuidv7";
		return "uuid";
	}
	if (def.format === "url") {
		if (def.protocol) return "httpUrl";
		return "url";
	}
	return typeof def.format === "string" ? def.format : undefined;
}
