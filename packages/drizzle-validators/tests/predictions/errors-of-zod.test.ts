import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { errorsOf, predictedKeys } from "../../src/predictions/zod";

describe("errorsOf (Zod)", () => {
  const userSchema = z.object({
    id: z.int(),
    name: z.string().min(2),
    email: z.string().email(),
    role: z.enum(["admin", "user"]),
    bio: z.string().optional(),
  });

  test("returns empty array for valid input", () => {
    const valid = {
      id: 1,
      name: "Alice",
      email: "alice@example.com",
      role: "admin",
    };
    const errors = errorsOf(userSchema, valid);
    expect(errors).toEqual([]);
  });

  test("soundness: err.kind is always in predictedKeys(field).keys", () => {
    const invalid = {
      id: 12.34, // int failure
      name: "A", // min_length failure
      email: "not-an-email", // email format failure
      role: "guest", // invalid_value failure
    };
    const errors = errorsOf(userSchema, invalid);
    expect(errors.length).toBeGreaterThanOrEqual(4);

    for (const err of errors) {
      const fieldSchema = (userSchema.shape as any)[err.field];
      expect(fieldSchema).toBeDefined();
      const predicted = predictedKeys(fieldSchema);

      // Invariant: kind is in predicted.keys
      expect(predicted.keys).toContain(err.kind as any);
      // Invariant: candidates[0] === kind
      expect(err.candidates[0]).toBe(err.kind);
      // Invariant: all candidates are in predicted.keys
      for (const cand of err.candidates) {
        expect(predicted.keys).toContain(cand as any);
      }
    }
  });

  test("sparse option returns only first error per field", () => {
    // A field with multiple failing checks
    const multiCheckSchema = z.object({
      code: z
        .string()
        .min(5)
        .max(10)
        .regex(/^[A-Z]+$/),
    });
    // "" fails min(5) and regex
    const allErrors = errorsOf(multiCheckSchema, { code: "" });
    expect(allErrors.length).toBeGreaterThan(1);

    const sparseErrors = errorsOf(
      multiCheckSchema,
      { code: "" },
      { sparse: true },
    );
    expect(sparseErrors.length).toBe(1);
    expect(sparseErrors[0]!.field).toBe("code");
  });

  test("custom errorMap resolves custom messages on the fly", () => {
    const errors = errorsOf(
      userSchema,
      { id: "not-a-number", name: "", email: "bad", role: "bad" },
      {
        errorMap: {
          name: {
            min_length: "Name is too short!",
          },
          email: {
            email: "Must be a valid email address!",
          },
        },
      },
    );

    const nameErr = errors.find((e) => e.field === "name");
    expect(nameErr?.message).toBe("Name is too short!");

    const emailErr = errors.find((e) => e.field === "email");
    expect(emailErr?.message).toBe("Must be a valid email address!");
  });

  test("extracts runtime ctx and input", () => {
    const errors = errorsOf(userSchema, {
      id: 1,
      name: "A",
      email: "alice@example.com",
      role: "admin",
    });
    const nameErr = errors.find((e) => e.field === "name");
    expect(nameErr).toBeDefined();
    expect(nameErr?.input).toBe("A");
    expect(nameErr?.ctx?.minimum).toBe(2);
  });
});
