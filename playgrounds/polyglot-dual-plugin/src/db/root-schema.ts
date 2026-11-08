import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

export const accounts = pgTable("accounts", {
	id: serial("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull(),
	seats: integer("seats").default(1),
});

export const legacyTable = pgTable("legacy", {
	id: serial("id").primaryKey(),
	note: text("note"),
});

// Dynamic import boundary (P2-14): billing tables must still land in the
// generation dependency graph.
export const billing = await import("./billing-tables.ts");

export const invoices = billing.invoices;
export const subscriptions = billing.subscriptions;
