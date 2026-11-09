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

export const priorityEnum = pgEnum("priority", [
  "low",
  "medium",
  "high",
  "urgent",
]);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 120 }).notNull(),
  slug: varchar("slug", { length: 64 }).notNull(),
  description: text("description"), // nullable
  ownerEmail: varchar("owner_email", { length: 255 }).notNull(),
  priority: priorityEnum("priority").notNull().default("medium"),
  estimatedHours: integer("estimated_hours").notNull(),
  isArchived: boolean("is_archived").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .default(sql`gen_random_uuid()`),
  title: varchar("title", { length: 200 }).notNull(),
  assigneeEmail: varchar("assignee_email", { length: 255 }).notNull(),
  storyPoints: integer("story_points").notNull(),
  dueInDays: integer("due_in_days").notNull(),
  completed: boolean("completed").notNull().default(false),
});

// Deliberately never imported by the client — tree-shaking must drop it.
export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  action: text("action").notNull(),
});
