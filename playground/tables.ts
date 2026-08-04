import {
	bigint,
	boolean,
	integer,
	json,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	serial,
	text,
	timestamp,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["admin", "user", "guest"]);
export const statusEnum = pgEnum("status", ["pending", "active", "suspended"]);

// 1. Users table
export const users = pgTable("users", {
	id: uuid("id").primaryKey().defaultRandom(),
	name: text("name").notNull(),
	email: varchar("email", { length: 255 }).notNull().unique(),
	isActive: boolean("is_active").default(true).notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at"),
	bio: text("bio"),
});

// 2. Profiles table
export const profiles = pgTable("profiles", {
	id: serial("id").primaryKey(),
	userId: uuid("user_id").notNull(),
	avatarUrl: text("avatar_url"),
	website: text("website"),
	role: roleEnum("role").default("user").notNull(),
	metadata: jsonb("metadata"),
});

// 3. Posts table
export const posts = pgTable("posts", {
	id: serial("id").primaryKey(),
	authorId: uuid("author_id").notNull(),
	title: varchar("title", { length: 256 }).notNull(),
	slug: varchar("slug", { length: 256 }).notNull().unique(),
	content: text("content").notNull(),
	published: boolean("published").default(false).notNull(),
	publishedAt: timestamp("published_at"),
});

// 4. Comments table
export const comments = pgTable("comments", {
	id: serial("id").primaryKey(),
	postId: integer("post_id").notNull(),
	authorId: uuid("author_id").notNull(),
	body: text("body").notNull(),
	parentId: integer("parent_id"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

// 5. Categories table
export const categories = pgTable("categories", {
	id: serial("id").primaryKey(),
	name: varchar("name", { length: 100 }).notNull(),
	description: text("description"),
});

// 6. PostCategories junction table
export const postCategories = pgTable("post_categories", {
	postId: integer("post_id").notNull(),
	categoryId: integer("category_id").notNull(),
});

// 7. Tags table
export const tags = pgTable("tags", {
	id: uuid("id").primaryKey().defaultRandom(),
	name: varchar("name", { length: 50 }).notNull().unique(),
});

// 8. Orders table
export const orders = pgTable("orders", {
	id: uuid("id").primaryKey().defaultRandom(),
	customerId: uuid("customer_id").notNull(),
	totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
	status: statusEnum("status").default("pending").notNull(),
	orderDate: timestamp("order_date").defaultNow().notNull(),
});

// 9. OrderItems table
export const orderItems = pgTable("order_items", {
	id: serial("id").primaryKey(),
	orderId: uuid("order_id").notNull(),
	productId: integer("product_id").notNull(),
	quantity: integer("quantity").default(1).notNull(),
	unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
});

// 10. Products table
export const products = pgTable("products", {
	id: serial("id").primaryKey(),
	name: varchar("name", { length: 255 }).notNull(),
	sku: varchar("sku", { length: 100 }).notNull().unique(),
	price: numeric("price", { precision: 10, scale: 2 }).notNull(),
	stockQuantity: integer("stock_quantity").default(0).notNull(),
	isAvailable: boolean("is_available").default(true).notNull(),
	attributes: json("attributes"),
});

// 11. AuditLogs table
export const auditLogs = pgTable("audit_logs", {
	id: serial("id").primaryKey(),
	action: text("action").notNull(),
	actorId: uuid("actor_id"),
	timestamp: timestamp("timestamp").defaultNow().notNull(),
	details: jsonb("details"),
});

// 12. Notifications table
export const notifications = pgTable("notifications", {
	id: uuid("id").primaryKey().defaultRandom(),
	recipientId: uuid("recipient_id").notNull(),
	title: text("title").notNull(),
	message: text("message").notNull(),
	read: boolean("read").default(false).notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

// 13. Subscriptions table
export const subscriptions = pgTable("subscriptions", {
	id: uuid("id").primaryKey().defaultRandom(),
	userId: uuid("user_id").notNull(),
	stripeCustomerId: text("stripe_customer_id").notNull(),
	status: text("status").notNull(),
	currentPeriodStart: timestamp("current_period_start").notNull(),
	currentPeriodEnd: timestamp("current_period_end").notNull(),
});

// 14. Files table
export const files = pgTable("files", {
	id: uuid("id").primaryKey().defaultRandom(),
	name: text("name").notNull(),
	mimeType: varchar("mime_type", { length: 127 }).notNull(),
	size: bigint("size", { mode: "number" }).notNull(),
	storagePath: text("storage_path").notNull(),
	uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
});

// 15. Settings table
export const settings = pgTable("settings", {
	id: serial("id").primaryKey(),
	userId: uuid("user_id"),
	key: varchar("key", { length: 100 }).notNull(),
	value: jsonb("value").notNull(),
	isSystem: boolean("is_system").default(false).notNull(),
});

// 16. Teams table
export const teams = pgTable("teams", {
	id: uuid("id").primaryKey().defaultRandom(),
	name: varchar("name", { length: 255 }).notNull(),
	ownerId: uuid("owner_id").notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});
