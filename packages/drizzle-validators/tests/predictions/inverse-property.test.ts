import { describe, expect, test } from "bun:test";
import { z } from "zod";
import * as v from "valibot";
import { errorsOf, predictedKeys } from "../../src/predictions/zod";
import { errorsOfV, predictedVKeys } from "../../src/predictions/valibot";

describe("Inverse Property: Soundness and Completeness", () => {
  const corpus = [
    undefined,
    null,
    123,
    15.5,
    "abc",
    "",
    "x".repeat(500),
    [],
    { extra: 1 },
    "invalid-email",
    "2026-11-09T00:00:00.000Z",
    "not-a-uuid",
    true,
    false,
    -100,
  ];

  test("Zod soundness & completeness across varied column schemas", () => {
    const testCases: Record<string, z.ZodTypeAny> = {
      reqStr: z.string().min(2).max(10),
      optInt: z.int().optional(),
      reqEmail: z.string().email(),
      reqEnum: z.enum(["admin", "user"]),
      reqUuid: z.uuidv4(),
      reqNumBounds: z.number().gte(10).lte(100),
      reqMultipleOf: z.number().multipleOf(5),
      reqLen: z.string().length(4),
      reqRegex: z.string().regex(/^[a-z]+$/),
    };

    for (const [name, fieldSchema] of Object.entries(testCases)) {
      const objSchema = z.object({ [name]: fieldSchema });
      const predicted = predictedKeys(fieldSchema);
      const seenCandidates = new Set<string>();

      for (const inputVal of corpus) {
        const inputObj = { [name]: inputVal };
        const errors = errorsOf(objSchema, inputObj);

        for (const err of errors) {
          if (err.field !== name) continue;

          // Soundness 1: kind is in predicted.keys
          expect(predicted.keys).toContain(err.kind as any);
          // Soundness 2: all candidates are in predicted.keys
          for (const cand of err.candidates) {
            expect(predicted.keys).toContain(cand as any);
            seenCandidates.add(cand);
          }
        }
      }

      // Completeness: For core presence keys, verify they were seen if test input triggered them
      if (predicted.keys.includes("required")) {
        expect(seenCandidates).toContain("required");
      }
      if (predicted.keys.includes("null")) {
        expect(seenCandidates).toContain("null");
      }
      if (predicted.keys.includes("invalid_type")) {
        expect(seenCandidates).toContain("invalid_type");
      }
    }
  });

  test("Valibot soundness & completeness", () => {
    const testCases: Record<string, any> = {
      reqStr: v.pipe(v.string(), v.minLength(2), v.maxLength(10)),
      optInt: v.optional(v.pipe(v.number(), v.integer())),
      reqEmail: v.pipe(v.string(), v.email()),
      reqEnum: v.picklist(["admin", "user"]),
      reqUuid: v.pipe(v.string(), v.uuid()),
      reqNumBounds: v.pipe(v.number(), v.minValue(10), v.maxValue(100)),
      reqMultipleOf: v.pipe(v.number(), v.multipleOf(5)),
      reqLen: v.pipe(v.string(), v.length(4)),
    };

    for (const [name, fieldSchema] of Object.entries(testCases)) {
      const objSchema = v.object({ [name]: fieldSchema });
      const predicted = predictedVKeys(fieldSchema);
      const seenCandidates = new Set<string>();

      for (const inputVal of corpus) {
        const inputObj = { [name]: inputVal };
        const errors = errorsOfV(objSchema, inputObj);

        for (const err of errors) {
          if (err.field !== name) continue;

          // Soundness 1: kind is in predicted.keys
          expect(predicted.keys).toContain(err.kind as any);
          // Soundness 2: all candidates are in predicted.keys
          for (const cand of err.candidates) {
            expect(predicted.keys).toContain(cand as any);
            seenCandidates.add(cand);
          }
        }
      }

      if (predicted.keys.includes("required")) {
        expect(seenCandidates).toContain("required");
      }
      if (predicted.keys.includes("null")) {
        expect(seenCandidates).toContain("null");
      }
      if (predicted.keys.includes("invalid_type")) {
        expect(seenCandidates).toContain("invalid_type");
      }
    }
  });
});
