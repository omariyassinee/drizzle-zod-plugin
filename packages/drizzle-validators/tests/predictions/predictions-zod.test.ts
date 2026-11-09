import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { predictedKeys, predictedKeysObject } from "../../src/predictions/zod";
import { refineZSchema } from "../../src/refine";

describe("predictedKeys (Zod)", () => {
  test("1. Presence & Wrappers: required and null tracking", () => {
    // Plain string (unwrapped)
    const baseStr = z.string();
    const pBase = predictedKeys(baseStr);
    expect(pBase.keys).toContain("required");
    expect(pBase.keys).toContain("null");
    expect(pBase.coreType.optional).toBe(false);
    expect(pBase.coreType.nullable).toBe(false);

    // .optional() drops required
    const optStr = z.string().optional();
    const pOpt = predictedKeys(optStr);
    expect(pOpt.keys).not.toContain("required");
    expect(pOpt.keys).toContain("null");
    expect(pOpt.coreType.optional).toBe(true);

    // .nullable() drops null
    const nullStr = z.string().nullable();
    const pNull = predictedKeys(nullStr);
    expect(pNull.keys).toContain("required");
    expect(pNull.keys).not.toContain("null");
    expect(pNull.coreType.nullable).toBe(true);

    // .default() and .catch() drop required
    const defStr = z.string().default("foo");
    const pDef = predictedKeys(defStr);
    expect(pDef.keys).not.toContain("required");
    expect(pDef.coreType.optional).toBe(true);

    const catchStr = z.string().catch("fallback");
    const pCatch = predictedKeys(catchStr);
    expect(pCatch.keys).not.toContain("required");
    expect(pCatch.keys).not.toContain("null");

    // .required() and .nonnullable() inside refineSchema restore required and null
    const schema = z.object({
      bio: z.string().optional().nullable(),
    });
    const refined = refineZSchema(schema, (f) => ({
      bio: f.bio.required().nonnullable(),
    }));
    const pRefinedBio = predictedKeys(refined.shape.bio);
    expect(pRefinedBio.keys).toContain("required");
    expect(pRefinedBio.keys).toContain("null");
    expect(pRefinedBio.coreType.optional).toBe(false);
    expect(pRefinedBio.coreType.nullable).toBe(false);
  });

  test("2. Integer vs. Number: int check and range bounds", () => {
    const zInt = z.int();
    const pInt = predictedKeys(zInt);
    expect(pInt.keys).toEqual(["required", "null", "invalid_type", "int"]);
    expect(pInt.coreType.intCheck).toBe(true);

    const numInt = z.number().int();
    const pNumInt = predictedKeys(numInt);
    expect(pNumInt.keys).toEqual(["required", "null", "invalid_type", "int"]);
    expect(pNumInt.coreType.intCheck).toBe(true);

    // Integer with range checks (e.g. gte and lte)
    const rangeInt = z.int().gte(-2147483648).lte(2147483647);
    const pRangeInt = predictedKeys(rangeInt);
    expect(pRangeInt.keys).toEqual([
      "required",
      "null",
      "invalid_type",
      "int",
      "min",
      "too_small",
      "max",
      "too_big",
    ]);
    expect(pRangeInt.meta.min).toEqual({
      minimum: -2147483648,
      inclusive: true,
    });
    expect(pRangeInt.meta.max).toEqual({
      maximum: 2147483647,
      inclusive: true,
    });
  });

  test("3. Sized vs. Unsized Bounds", () => {
    // Sized: string min & max
    const strBounds = z.string().min(3).max(10);
    const pStr = predictedKeys(strBounds);
    expect(pStr.keys).toEqual([
      "required",
      "null",
      "invalid_type",
      "min_length",
      "min",
      "too_small",
      "max_length",
      "max",
      "too_big",
    ]);
    expect(pStr.meta.min_length).toEqual({ minimum: 3, inclusive: true });
    expect(pStr.meta.min).toEqual({ minimum: 3, inclusive: true });
    expect(pStr.meta.max_length).toEqual({ maximum: 10, inclusive: true });
    expect(pStr.meta.max).toEqual({ maximum: 10, inclusive: true });

    // Sized: length()
    const strLen = z.string().length(5);
    const pStrLen = predictedKeys(strLen);
    expect(pStrLen.keys).toEqual([
      "required",
      "null",
      "invalid_type",
      "length",
      "too_small",
      "too_big",
    ]);
    expect(pStrLen.meta.length).toEqual({ exact: 5 });

    // Unsized: number min & max
    const numBounds = z.number().min(3).max(10);
    const pNum = predictedKeys(numBounds);
    expect(pNum.keys).toEqual([
      "required",
      "null",
      "invalid_type",
      "min",
      "too_small",
      "max",
      "too_big",
    ]);
    expect(pNum.keys).not.toContain("min_length");
    expect(pNum.keys).not.toContain("max_length");
  });

  test("4. Format Cascades", () => {
    // uuidv4 format
    const uuid = z.uuidv4();
    const pUuid = predictedKeys(uuid);
    expect(pUuid.keys).toEqual([
      "required",
      "null",
      "invalid_type",
      "uuidv4",
      "uuid",
      "format",
      "invalid_format",
    ]);
    expect(pUuid.meta.uuidv4).toEqual({ format: "uuidv4" });
    expect(pUuid.meta.uuid).toEqual({ format: "uuidv4" });

    // httpUrl format
    const url = z.httpUrl();
    const pUrl = predictedKeys(url);
    expect(pUrl.keys).toEqual([
      "required",
      "null",
      "invalid_type",
      "httpUrl",
      "url",
      "format",
      "invalid_format",
    ]);

    // email format check
    const emailStr = z.string().email();
    const pEmail = predictedKeys(emailStr);
    expect(pEmail.keys).toEqual([
      "required",
      "null",
      "invalid_type",
      "email",
      "format",
      "invalid_format",
    ]);

    // Plain string predicts neither format nor invalid_format
    const plainStr = z.string();
    const pPlain = predictedKeys(plainStr);
    expect(pPlain.keys).not.toContain("format");
    expect(pPlain.keys).not.toContain("invalid_format");
  });

  test("5. Overwrites Ignored", () => {
    const trimmed = z.string().trim().toLowerCase();
    const pTrimmed = predictedKeys(trimmed);
    expect(pTrimmed.keys).toEqual(["required", "null", "invalid_type"]);
  });

  test("6. Enum, Union, Strict Object, Custom Refinements", () => {
    const enumSchema = z.enum(["admin", "user"]);
    const pEnum = predictedKeys(enumSchema);
    expect(pEnum.keys).toEqual([
      "required",
      "null",
      "invalid_value",
      "invalid_type",
    ]);
    expect(pEnum.meta.invalid_value).toEqual({ values: ["admin", "user"] });

    const unionSchema = z.union([z.string(), z.number()]);
    const pUnion = predictedKeys(unionSchema);
    expect(pUnion.keys).toEqual([
      "required",
      "null",
      "invalid_union",
      "invalid_type",
    ]);

    const strictObj = z.strictObject({ a: z.string() });
    const pStrict = predictedKeys(strictObj);
    expect(pStrict.keys).toEqual([
      "required",
      "null",
      "invalid_type",
      "unrecognized_keys",
    ]);

    const refinedCustom = z.string().refine((val) => val.length > 0);
    const pRefined = predictedKeys(refinedCustom);
    expect(pRefined.keys).toContain("custom");
  });

  test("7. predictedKeysObject", () => {
    const tableSchema = z.object({
      id: z.int(),
      name: z.string().min(1),
      email: z.string().email().optional(),
    });

    const issues = predictedKeysObject(tableSchema);
    expect(issues.id.keys).toContain("int");
    expect(issues.name.keys).toContain("min_length");
    expect(issues.email.keys).not.toContain("required");
    expect(issues.email.keys).toContain("email");
  });
});
