import {
	boolean,
	bigint,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	serial,
	smallint,
	text,
	varchar,
} from "drizzle-orm/pg-core";

// Dedicated fixture for the cross-target differential matrix
// (tests/stress-matrix.test.ts). Kept separate from root-schema.ts so the
// lifecycle tests' table counts stay untouched.

export const stressStatus = pgEnum("stress_status", ["active", "banned"]);

export const stress = pgTable("stress", {
	id: serial("id").primaryKey(),
	meta: jsonb("meta"),
	tags: text("tags").array(),
	count: integer("count"),
	small: smallint("small"),
	bigNum: bigint("big_num", { mode: "number" }),
	bigBig: bigint("big_big", { mode: "bigint" }),
	nickname: varchar("nickname", { length: 32 }),
	bio: text("bio"),
	status: stressStatus("status").notNull(),
	score: text("score").default("zero").notNull(),
	active: boolean("active").notNull(),
});
