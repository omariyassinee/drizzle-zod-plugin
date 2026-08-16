import { expect, test } from "bun:test";
import { z } from "zod";
import { refineSchema } from "../src/refine";

test("Complex Types: Discriminated Union and Union fields", () => {
	const eventPayloadSchema = z.discriminatedUnion("type", [
		z.object({
			type: z.literal("appointment_created"),
			patientId: z.string().uuid(),
		}),
		z.object({
			type: z.literal("day_blocked"),
			reason: z.string(),
		}),
	]);

	const tableSchema = z.object({
		id: z.number(),
		event: eventPayloadSchema,
		contactPreference: z.union([z.literal("sms"), z.literal("email")]),
	});

	const refined = refineSchema(tableSchema, (fields) => ({
		contactPreference: fields.contactPreference.or(z.literal("whatsapp")),
	}));

	// 1. Valid event appointment_created
	const validAppt = refined.safeParse({
		id: 1,
		event: {
			type: "appointment_created",
			patientId: "123e4567-e89b-12d3-a456-426614174000",
		},
		contactPreference: "sms",
	});
	expect(validAppt.success).toBe(true);

	// 2. Valid extended union branch (whatsapp)
	const validWhatsapp = refined.safeParse({
		id: 2,
		event: {
			type: "day_blocked",
			reason: "Holiday",
		},
		contactPreference: "whatsapp",
	});
	expect(validWhatsapp.success).toBe(true);

	// 3. Invalid union branch
	const invalidBranch = refined.safeParse({
		id: 3,
		event: {
			type: "day_blocked",
			reason: "Holiday",
		},
		contactPreference: "phone_call",
	});
	expect(invalidBranch.success).toBe(false);
});

test("Complex Types: Record, Map, and Set fields in schemas", () => {
	const settingsSchema = z.object({
		labels: z.record(z.string(), z.string()).optional(),
		tagSet: z.set(z.string()).optional(),
	});

	const refined = refineSchema(settingsSchema, (fields) => ({
		labels: fields.labels,
		tagSet: fields.tagSet,
	}));

	// 1. Valid Record
	const valid = refined.safeParse({
		labels: { env: "production", region: "us-east-1" },
		tagSet: new Set(["urgent", "vip"]),
	});
	expect(valid.success).toBe(true);

	// 2. Invalid Record value type
	const invalidRecord = refined.safeParse({
		labels: { count: 123 },
	});
	expect(invalidRecord.success).toBe(false);
});

test("Complex Types: Tuple columns with validation", () => {
	const geoSchema = z.object({
		coordinates: z.tuple([z.number(), z.number()]).optional(),
	});

	const refined = refineSchema(geoSchema, (fields) => ({
		coordinates: fields.coordinates,
	}));

	// 1. Valid tuple [lat, lng]
	expect(refined.safeParse({ coordinates: [37.7749, -122.4194] }).success).toBe(true);

	// 2. Invalid tuple length or type
	expect(refined.safeParse({ coordinates: [37.7749] }).success).toBe(false);
	expect(refined.safeParse({ coordinates: [37.7749, "not-a-number"] }).success).toBe(false);
});

test("Complex Types: Enum extract and exclude refinements", () => {
	const orderSchema = z.object({
		status: z.enum(["placed", "processing", "shipped", "delivered", "cancelled"]),
	});

	// Restrict to active statuses only
	const activeOrderSchema = refineSchema(orderSchema, (fields) => ({
		status: fields.status.extract(["placed", "processing", "shipped"]),
	}));

	expect(activeOrderSchema.safeParse({ status: "placed" }).success).toBe(true);
	expect(activeOrderSchema.safeParse({ status: "processing" }).success).toBe(true);
	expect(activeOrderSchema.safeParse({ status: "delivered" }).success).toBe(false);
	expect(activeOrderSchema.safeParse({ status: "cancelled" }).success).toBe(false);

	// Exclude cancelled status
	const nonCancelledSchema = refineSchema(orderSchema, (fields) => ({
		status: fields.status.exclude(["cancelled"]),
	}));

	expect(nonCancelledSchema.safeParse({ status: "delivered" }).success).toBe(true);
	expect(nonCancelledSchema.safeParse({ status: "cancelled" }).success).toBe(false);
});
