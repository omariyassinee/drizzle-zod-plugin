import {
	pgTable,
	pgEnum,
	uuid,
	integer,
	bigint,
	jsonb,
	timestamp,
	bytea,
	numeric,
} from "drizzle-orm/pg-core";

import {
	mysqlTable,
	mysqlEnum,
	varchar,
	bigint as mysqlBigint,
	json,
	datetime,
	blob,
} from "drizzle-orm/mysql-core";

// High-frequency telemetry: BigInt counters, JSONB sensor maps, raw
// firmware blobs — the shapes TypeBox is good at, at high volume.
export const firmwareVersionEnum = pgEnum("firmware_version", [
	"v1",
	"v2",
	"v3",
]);

export const telemetryPackets = pgTable("telemetry_packets", {
	id: uuid("id").primaryKey().defaultRandom(),
	deviceId: uuid("device_id").notNull(),
	firmware: firmwareVersionEnum("firmware").notNull().default("v1"),
	sequence: bigint("sequence", { mode: "bigint" }).notNull(),
	uptimeSeconds: bigint("uptime_seconds", { mode: "number" }),
	signalStrength: numeric("signal_strength", { precision: 8, scale: 4 }),
	sensorMap: jsonb("sensor_map").$type<Record<string, number>>(),
	reportedAt: timestamp("reported_at", { withTimezone: true }).notNull(),
	firmwareImage: bytea("firmware_image"),
});

export const deviceRegistry = mysqlTable("device_registry", {
	id: mysqlBigint("id", { mode: "number" }).primaryKey().autoincrement(),
	deviceKey: varchar("device_key", { length: 64 }).notNull(),
	channel: mysqlEnum("channel", ["lte", "lora", "wifi"]).notNull(),
	latencyMs: mysqlBigint("latency_ms", { mode: "bigint" }),
	metadata: json("metadata"),
	lastSeen: datetime("last_seen"),
	otaImage: blob("ota_image", { mode: "buffer" }),
});
