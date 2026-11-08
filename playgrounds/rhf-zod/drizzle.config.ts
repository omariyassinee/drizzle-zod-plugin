// Plain-object drizzle config — the plugin reads `schema` for auto-detection.
export default {
	dialect: "postgresql",
	schema: "./src/db/schema.ts",
};
