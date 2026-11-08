// Plain-object drizzle config — drizzle-kit accepts both forms; the plugin
// only reads `schema` for auto-detection.
export default {
	dialect: "postgresql",
	schema: "./src/db/schema.ts",
};
