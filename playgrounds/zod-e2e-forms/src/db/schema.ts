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

export const specialtyEnum = pgEnum("specialty", [
	"cardiology",
	"dermatology",
	"neurology",
	"pediatrics",
]);

export const doctors = pgTable("doctors", {
	id: uuid("id").primaryKey().defaultRandom(),
	email: varchar("email", { length: 120 }).notNull(),
	phone: varchar("phone", { length: 20 }), // nullable
	age: integer("age").notNull(),
	specialty: specialtyEnum("specialty").notNull().default("cardiology"),
	licenseCode: varchar("license_code", { length: 8 }).notNull(),
	createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const appointments = pgTable("appointments", {
	id: uuid("id").primaryKey().defaultRandom(),
	doctorId: uuid("doctor_id")
		.notNull()
		.default(sql`gen_random_uuid()`), // DB-side default → optional zod field
	clinicId: uuid("clinic_id").notNull(),
	reason: text("reason"), // nullable, refined out of client form
	internalNotes: text("internal_notes"), // omitted from the client form
	isFollowUp: boolean("is_follow_up").default(false),
});

// Deliberately NEVER imported by the client — tree-shaking must drop it.
export const auditLogs = pgTable("audit_logs", {
	id: uuid("id").primaryKey().defaultRandom(),
	action: text("action").notNull(),
});
