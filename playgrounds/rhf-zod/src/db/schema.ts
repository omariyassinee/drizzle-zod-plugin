import { sql } from "drizzle-orm";
import {
	pgTable,
	pgEnum,
	uuid,
	varchar,
	integer,
	text,
	boolean,
	timestamp,
} from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", [
	"member",
	"admin",
	"moderator",
]);

export const users = pgTable("users", {
	id: uuid("id").primaryKey().defaultRandom(),
	email: varchar("email", { length: 255 }).notNull(),
	username: varchar("username", { length: 32 }).notNull(),
	passwordHash: varchar("password_hash", { length: 255 }).notNull(),
	age: integer("age").notNull(),
	role: userRoleEnum("role").notNull().default("member"),
	bio: text("bio"), // nullable
	isActive: boolean("is_active").notNull().default(true),
	createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
	id: uuid("id").primaryKey().defaultRandom(),
	userId: uuid("user_id").notNull().default(sql`gen_random_uuid()`),
	token: varchar("token", { length: 64 }).notNull(),
	expiresAt: timestamp("expires_at").notNull(),
});

// Deliberately never imported by the client — tree-shaking must drop it.
export const auditLogs = pgTable("audit_logs", {
	id: uuid("id").primaryKey().defaultRandom(),
	action: text("action").notNull(),
});
