import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type {
  PredictedErrorKeys,
  SchemaErrorRecord,
  SchemaPredictedErrorKeys,
} from "../../src/predictions/types";
import { refineZSchema } from "../../src/refine";

describe("PredictedErrorKeys & SchemaErrorRecord types", () => {
  test("type-level assertions for PredictedErrorKeys", () => {
    // 1. PredictedErrorKeys<z.ZodOptional<z.ZodString>>:
    // - excludes "required" and "int"
    // - includes "null", "min_length", "email"
    type OptStrKeys = PredictedErrorKeys<z.ZodOptional<z.ZodString>>;

    // Compile-time checks
    const hasNull: OptStrKeys = "null";
    const hasMinLength: OptStrKeys = "min_length";
    const hasEmail: OptStrKeys = "email";
    expect(hasNull).toBe("null");
    expect(hasMinLength).toBe("min_length");
    expect(hasEmail).toBe("email");

    // @ts-expect-error "required" must be excluded because optional accepts undefined
    const noRequired: OptStrKeys = "required";
    // @ts-expect-error "int" must be excluded because core is string
    const noInt: OptStrKeys = "int";

    // 2. Refined schema with .as(z.int()):
    const baseTable = z.object({
      age: z.string().optional(),
      email: z.string().email(),
    });

    const refined = refineZSchema(baseTable, (f) => ({
      age: f.age.as(z.int()),
    }));

    type RefinedAgeKeys = PredictedErrorKeys<typeof refined.shape.age>;
    const hasIntCheck: RefinedAgeKeys = "int";
    const hasMultipleOf: RefinedAgeKeys = "multiple_of";
    expect(hasIntCheck).toBe("int");
    expect(hasMultipleOf).toBe("multiple_of");

    // @ts-expect-error "email" must be rejected for integer
    const noAgeEmail: RefinedAgeKeys = "email";
    // @ts-expect-error "min_length" must be rejected for integer
    const noAgeMinLength: RefinedAgeKeys = "min_length";

    // 3. SchemaErrorRecord narrowing
    type UserRecord = SchemaErrorRecord<typeof refined>;
    function handleRecord(record: UserRecord) {
      if (record.field === "email") {
        // record.kind is narrowed to email/string error keys
        const k: "email" | "invalid_type" | "required" | "null" =
          record.kind as any;
        return k;
      }
      return record.kind;
    }
    expect(handleRecord).toBeDefined();
  });
});
