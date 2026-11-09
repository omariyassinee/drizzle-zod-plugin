import type { z } from "zod";
import type { DeepUnwrap, FieldErrorMapForCore } from "../refine";
import type { FieldErrorRecord, PortableErrorKey } from "./core";

/** True when `T` accepts `undefined` at the outer wrapper level. */
type AcceptsUndefined<T extends z.ZodTypeAny> =
  T extends z.ZodOptional<any> | z.ZodExactOptional<any> | z.ZodDefault<any> | z.ZodCatch<any>
    ? true
    : T extends z.ZodNullable<infer Inner extends z.ZodTypeAny>
      ? AcceptsUndefined<Inner>
      : T extends z.ZodReadonly<infer Inner extends z.ZodTypeAny>
        ? AcceptsUndefined<Inner>
        : false;

/** True when `T` accepts `null` at the outer wrapper level. */
type AcceptsNull<T extends z.ZodTypeAny> =
  T extends z.ZodNullable<any> | z.ZodCatch<any>
    ? true
    : T extends z.ZodOptional<infer Inner extends z.ZodTypeAny>
      ? AcceptsNull<Inner>
      : T extends z.ZodExactOptional<infer Inner extends z.ZodTypeAny>
        ? AcceptsNull<Inner>
        : T extends z.ZodDefault<infer Inner extends z.ZodTypeAny>
          ? AcceptsNull<Inner>
          : T extends z.ZodReadonly<infer Inner extends z.ZodTypeAny>
            ? AcceptsNull<Inner>
            : false;

type WrapperOmittedKeys<TField extends z.ZodTypeAny> =
  | "default"
  | (AcceptsUndefined<TField> extends true ? "required" : never)
  | (AcceptsNull<TField> extends true ? "null" : never);

/**
 * Compile-time string-literal union of portable error keys that `TField` can emit.
 *
 * - Reflects `.as(z.email())` / `.as(z.number())` core replacements via `DeepUnwrap<TField>`.
 * - Reflects `.optional()`, `.nullable()`, `.required()`, `.nonnullable()`, `.unwrap()` via wrapper inspection.
 */
export type PredictedErrorKeys<TField extends z.ZodTypeAny> = Exclude<
  keyof FieldErrorMapForCore<DeepUnwrap<TField>> & string,
  WrapperOmittedKeys<TField>
>;

/**
 * Maps every field `K` of a `ZodObject` to its `PredictedErrorKeys<TShape[K]>`.
 */
export type SchemaPredictedErrorKeys<T extends z.ZodObject<any>> = {
  [K in keyof T["shape"] & string]: PredictedErrorKeys<T["shape"][K]>;
};

/**
 * Discriminated union of `FieldErrorRecord` across all top-level fields of `T`.
 * Narrowing `if (err.field === "age")` narrows `err.kind` to `PredictedErrorKeys<T["shape"]["age"]>`.
 */
export type SchemaErrorRecord<T extends z.ZodObject<any>> = {
  [K in keyof T["shape"] & string]: FieldErrorRecord<
    K,
    PredictedErrorKeys<T["shape"][K]>
  >;
}[keyof T["shape"] & string] | FieldErrorRecord<string, PortableErrorKey>;
