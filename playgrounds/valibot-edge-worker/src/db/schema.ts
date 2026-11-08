import {
	sqliteTable,
	text,
	integer,
	blob,
} from "drizzle-orm/sqlite-core";

// Cloudflare D1 webhook registry — the tables the edge worker validates.
export const webhooks = sqliteTable("webhooks", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	url: text("url").notNull(),
	event: text("event", { enum: ["push", "pr", "issue"] }).notNull(),
	secret: text("secret").notNull(),
	retries: integer("retries").default(3),
	isActive: integer("is_active", { mode: "boolean" }).default(true),
	labels: text("labels", { mode: "json" }).$type<string[]>(),
});

export const deliveries = sqliteTable("deliveries", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	webhookId: integer("webhook_id").notNull(),
	status: text("status", { enum: ["pending", "delivered", "failed"] })
		.notNull(),
	attempts: integer("attempts").notNull().default(0),
	responseCode: integer("response_code"),
});

// Excluded from generation via the `tables` filter — exists to prove the
// filter bypasses it (and, if valibot ever surfaces a Buffer schema, that
// bufferAs: "throw" guards it).
export const rawBinaryPayloads = sqliteTable("raw_binary_payloads", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	data: blob("data", { mode: "buffer" }).notNull(),
});
