import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

// Loaded through a dynamic `await import()` from root-schema.ts — the
// esbuild metafile must capture this file in depPaths (P2-14) so cache
// hashes invalidate when it changes.
export const invoices = pgTable("invoices", {
	id: serial("id").primaryKey(),
	accountId: integer("account_id").notNull(),
	status: text("status", { enum: ["open", "paid", "void"] }).notNull(),
});

export const subscriptions = pgTable("subscriptions", {
	id: serial("id").primaryKey(),
	accountId: integer("account_id").notNull(),
	plan: text("plan", { enum: ["free", "pro", "team"] }).notNull(),
});
