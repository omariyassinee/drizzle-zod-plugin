export const RESOLVED_PREFIX = "\0";

/**
 * Single source of truth for every string format supported by the plugin.
 *
 * `KNOWN_FORMATS` (serializer) and `StringFormat` (refine.ts) are both derived
 * from this tuple, so the two lists can never drift apart (finding M6).
 */
export const STRING_FORMAT_NAMES = [
	"email",
	"url",
	"httpUrl",
	"uuid",
	"uuidv4",
	"uuidv6",
	"uuidv7",
	"guid",
	"cuid",
	"cuid2",
	"ulid",
	"emoji",
	"nanoid",
	"jwt",
	"ipv4",
	"ipv6",
	"cidrv4",
	"cidrv6",
	"base64",
	"base64url",
	"xid",
	"ksuid",
	"e164",
] as const;

export const KNOWN_FORMATS = new Set<string>(STRING_FORMAT_NAMES);

export const MAX_RECURSION_DEPTH = 100;
