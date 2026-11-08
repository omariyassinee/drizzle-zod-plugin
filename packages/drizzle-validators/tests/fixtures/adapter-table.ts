import {
	pgEnum,
	pgTable,
	boolean,
	integer,
	jsonb,
	serial,
	text,
	timestamp,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

export const moodEnum = pgEnum("mood", ["happy", "sad"]);

export const tbUsers = pgTable("tb_users", {
	id: serial("id").primaryKey(),
	name: text("name").notNull(),
	email: varchar("email", { length: 255 }).notNull(),
	age: integer("age"),
	isActive: boolean("is_active").default(true),
	userId: uuid("user_id").notNull(),
	mood: moodEnum("mood"),
	createdAt: timestamp("created_at").notNull(),
	meta: jsonb("meta"),
	tags: text("tags").array().notNull(),
});
