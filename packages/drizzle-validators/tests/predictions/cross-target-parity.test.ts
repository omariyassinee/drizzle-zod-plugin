import { describe, expect, test } from "bun:test";
import { z } from "zod";
import * as v from "valibot";
import { Type } from "typebox";
import { predictedKeys, predictedKeysObject } from "../../src/predictions/zod";
import {
  predictedVKeys,
  predictedVKeysObject,
} from "../../src/predictions/valibot";
import {
  predictedTKeys,
  predictedTKeysObject,
} from "../../src/predictions/typebox";

describe("Cross-Target Parity (Zod, Valibot, TypeBox)", () => {
  test("String with bounds parity", () => {
    const zStr = z.string().min(3).max(10);
    const vStr = v.pipe(v.string(), v.minLength(3), v.maxLength(10));
    const tStr = Type.String({ minLength: 3, maxLength: 10 });

    const pZ = predictedKeys(zStr);
    const pV = predictedVKeys(vStr);
    const pT = predictedTKeys(tStr);

    expect(pV.keys).toEqual(pZ.keys as any);
    expect(pT.keys).toEqual(pZ.keys as any);

    expect(pV.meta.min_length).toEqual(pZ.meta.min_length);
    expect(pT.meta.min_length).toEqual(pZ.meta.min_length);
    expect(pV.meta.max_length).toEqual(pZ.meta.max_length);
    expect(pT.meta.max_length).toEqual(pZ.meta.max_length);
  });

  test("Integer with range bounds parity", () => {
    const zInt = z.int().gte(-100).lte(100);
    const vInt = v.pipe(
      v.number(),
      v.integer(),
      v.minValue(-100),
      v.maxValue(100),
    );
    const tInt = Type.Integer({ minimum: -100, maximum: 100 });

    const pZ = predictedKeys(zInt);
    const pV = predictedVKeys(vInt);
    const pT = predictedTKeys(tInt);

    expect(pV.keys).toEqual(pZ.keys as any);
    expect(pT.keys).toEqual(pZ.keys as any);

    expect(pV.meta.min).toEqual(pZ.meta.min);
    expect(pT.meta.min).toEqual(pZ.meta.min);
    expect(pV.meta.max).toEqual(pZ.meta.max);
    expect(pT.meta.max).toEqual(pZ.meta.max);
  });

  test("Enum / picklist parity", () => {
    const values = ["draft", "published", "archived"] as const;
    const zEnum = z.enum(values);
    const vEnum = v.picklist(values);
    const tEnum = Type.Union(values.map((val) => Type.Literal(val)));

    const pZ = predictedKeys(zEnum);
    const pV = predictedVKeys(vEnum);
    const pT = predictedTKeys(tEnum);

    expect(pV.keys).toEqual(pZ.keys as any);
    expect(pT.keys).toEqual(pZ.keys as any);
    expect(pV.meta.invalid_value?.values).toEqual(
      pZ.meta.invalid_value?.values,
    );
    expect(pT.meta.invalid_value?.values).toEqual(
      pZ.meta.invalid_value?.values,
    );
  });

  test("Optional and Nullable modifiers parity", () => {
    const zOpt = z.string().optional();
    const vOpt = v.optional(v.string());
    const tOpt = Type.Optional(Type.String());

    const pZOpt = predictedKeys(zOpt);
    const pVOpt = predictedVKeys(vOpt);
    const pTOpt = predictedTKeys(tOpt);

    expect(pVOpt.keys).toEqual(pZOpt.keys as any);
    expect(pTOpt.keys).toEqual(pZOpt.keys as any);
    expect(pVOpt.coreType.optional).toBe(true);
    expect(pTOpt.coreType.optional).toBe(true);

    const zNull = z.string().nullable();
    const vNull = v.nullable(v.string());
    const tNull = Type.Union([Type.String(), Type.Null()]);

    const pZNull = predictedKeys(zNull);
    const pVNull = predictedVKeys(vNull);
    const pTNull = predictedTKeys(tNull);

    expect(pVNull.keys).toEqual(pZNull.keys as any);
    expect(pTNull.keys).toEqual(pZNull.keys as any);
    expect(pVNull.coreType.nullable).toBe(true);
    expect(pTNull.coreType.nullable).toBe(true);
  });

  test("Object schema parity across targets", () => {
    const zObj = z.object({
      id: z.int(),
      name: z.string().min(1),
      email: z.string().email().optional(),
    });

    const vObj = v.object({
      id: v.pipe(v.number(), v.integer()),
      name: v.pipe(v.string(), v.minLength(1)),
      email: v.optional(v.pipe(v.string(), v.email())),
    });

    const tObj = Type.Object({
      id: Type.Integer(),
      name: Type.String({ minLength: 1 }),
      email: Type.Optional(Type.String({ format: "email" })),
    });

    const pZObj = predictedKeysObject(zObj);
    const pVObj = predictedVKeysObject(vObj);
    const pTObj = predictedTKeysObject(tObj);

    expect(pVObj.id?.keys).toEqual(pZObj.id.keys as any);
    expect(pTObj.id?.keys).toEqual(pZObj.id.keys as any);

    expect(pVObj.name?.keys).toEqual(pZObj.name.keys as any);
    expect(pTObj.name?.keys).toEqual(pZObj.name.keys as any);

    expect(pVObj.email?.keys).toEqual(pZObj.email.keys as any);
    expect(pTObj.email?.keys).toEqual(pZObj.email.keys as any);
  });
});
