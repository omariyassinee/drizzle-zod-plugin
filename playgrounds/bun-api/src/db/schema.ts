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

export const orderStatusEnum = pgEnum("order_status", [
	"pending",
	"paid",
	"shipped",
	"delivered",
	"cancelled",
]);

export const customers = pgTable("customers", {
	id: uuid("id").primaryKey().defaultRandom(),
	email: varchar("email", { length: 255 }).notNull(),
	fullName: varchar("full_name", { length: 120 }).notNull(),
	phone: varchar("phone", { length: 20 }), // nullable
	age: integer("age").notNull(),
	country: varchar("country", { length: 2 }).notNull(),
	isVip: boolean("is_vip").notNull().default(false),
	createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const orders = pgTable("orders", {
	id: uuid("id").primaryKey().defaultRandom(),
	customerId: uuid("customer_id").notNull().default(sql`gen_random_uuid()`),
	status: orderStatusEnum("status").notNull().default("pending"),
	totalCents: integer("total_cents").notNull(),
	shippingNote: text("shipping_note"), // nullable
	createdAt: timestamp("created_at").notNull().defaultNow(),
});
