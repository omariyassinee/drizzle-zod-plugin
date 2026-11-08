import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

export const usersWithOverrides = pgTable("users_override_table", {
	id: serial("id").primaryKey(),
	email: text("email").notNull(),
	age: integer("age"),
	role: text("role").notNull().default("user"),
	bio: text("bio"),
});
