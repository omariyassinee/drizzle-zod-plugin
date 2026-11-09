import { STRING_FORMAT_NAMES, type StringFormat } from "../constants";

export type PortableErrorKey =
  | "required"
  | "null"
  | "invalid_type"
  | "invalid_value"
  | "min"
  | "max"
  | "min_length"
  | "max_length"
  | "length"
  | "too_small"
  | "too_big"
  | "int"
  | "multiple_of"
  | "not_multiple_of"
  | "format"
  | "invalid_format"
  | "regex"
  | "starts_with"
  | "ends_with"
  | "includes"
  | "custom"
  | "unrecognized_keys"
  | "invalid_union"
  | StringFormat;

export interface KeyConstraintMeta {
  minimum?: number | bigint | Date;
  maximum?: number | bigint | Date;
  inclusive?: boolean;
  exact?: number;
  multipleOf?: number | bigint;
  format?: string;
  pattern?: string;
  prefix?: string;
  suffix?: string;
  includes?: string;
  values?: readonly unknown[];
}

export interface CoreTypeDescriptor {
  type: string;
  format?: string;
  optional: boolean;
  nullable: boolean;
  sizedOrigin: boolean;
  intCheck: boolean;
  isEnum: boolean;
  isObject: boolean;
  isStrictObject: boolean;
  isUnion: boolean;
}

export interface PredictedIssue<K extends string = PortableErrorKey> {
  /** Ordered, deduplicated error keys (core presence/type keys first, then check keys in attachment order). */
  readonly keys: readonly K[];
  /** Static constraint metadata keyed by predicted error key. */
  readonly meta: Readonly<Partial<Record<K, Readonly<KeyConstraintMeta>>>>;
  /** Structural descriptor of the unwrapped core schema and its outer wrappers. */
  readonly coreType: Readonly<CoreTypeDescriptor>;
}

export type ObjectPredictedIssues<
  TShape extends Record<string, any> = Record<string, any>,
> = {
  readonly [K in keyof TShape]: PredictedIssue;
};

export interface FieldErrorRecord<
  TField extends string = string,
  TKind extends string = PortableErrorKey,
> {
  /** Top-level field name, or dot-joined path for nested fields (e.g. "address.city" or "tags.0"). */
  field: TField;
  /** Raw property path segments from the validator issue. */
  path: (string | number)[];
  /** Most specific portable error key (always equals candidates[0] and is in predictedKeys(field).keys). */
  kind: TKind;
  /** Full specificity cascade from most specific to coarse fallback (e.g. ["min_length", "min", "too_small"]). */
  candidates: readonly TKind[];
  /** Final resolved human-readable error message. */
  message: string;
  /** Normalized runtime issue parameters (minimum, maximum, format, multipleOf, expected, received). */
  ctx?: Readonly<Record<string, unknown>>;
  /** Offending input value when provided by the validator engine. */
  input?: unknown;
}

export interface PredictOptions {
  /** Include core presence/type keys (required, null, invalid_type, invalid_value, etc.). @default true */
  includeCore?: boolean;
  /** Include check/pipe-derived constraint keys (min, max, format, email, int, etc.). @default true */
  includeChecks?: boolean;
}

export interface ErrorsOfOptions<TErrorMap = unknown> {
  /** Emit only the first FieldErrorRecord per unique `field` path. @default false */
  sparse?: boolean;
  /** Optional declarative SchemaErrorMap to resolve custom messages on the fly without re-cloning the schema. */
  errorMap?: TErrorMap;
}

/** Parent format fallback when a versioned/protocol format key is not explicitly set. */
export const FORMAT_PARENT: Readonly<Record<string, PortableErrorKey>> = {
  uuidv4: "uuid",
  uuidv6: "uuid",
  uuidv7: "uuid",
  httpUrl: "url",
};

export const SPECIFIC_FORMAT_KEYS: ReadonlySet<string> = new Set<string>([
  "regex",
  "starts_with",
  "ends_with",
  "includes",
  ...STRING_FORMAT_NAMES,
]);

export const SIZED_ORIGIN_TYPES: ReadonlySet<string> = new Set<string>([
  "string",
  "array",
  "set",
]);

/** Expands a canonical format name into its ordered specificity cascade. */
export function expandFormatCascade(formatName: string): PortableErrorKey[] {
  const keys: PortableErrorKey[] = [];
  if (SPECIFIC_FORMAT_KEYS.has(formatName)) {
    keys.push(formatName as PortableErrorKey);
    const parent = FORMAT_PARENT[formatName];
    if (parent) keys.push(parent);
  }
  keys.push("format", "invalid_format");
  return keys;
}

/** Expands a minimum bound check into its ordered specificity cascade. */
export function expandMinCascade(sizedOrigin: boolean): PortableErrorKey[] {
  return sizedOrigin
    ? ["min_length", "min", "too_small"]
    : ["min", "too_small"];
}

/** Expands a maximum bound check into its ordered specificity cascade. */
export function expandMaxCascade(sizedOrigin: boolean): PortableErrorKey[] {
  return sizedOrigin ? ["max_length", "max", "too_big"] : ["max", "too_big"];
}

/** Expands an exact length check into its ordered specificity cascade. */
export function expandLengthCascade(): PortableErrorKey[] {
  return ["length", "too_small", "too_big"];
}

/** Expands a multipleOf check into its ordered specificity cascade. */
export function expandMultipleOfCascade(): PortableErrorKey[] {
  return ["multiple_of", "not_multiple_of"];
}

/** Full fallback key set for opaque/unknown schema cores (guarantees soundness). */
export const ALL_PORTABLE_KEYS: readonly PortableErrorKey[] = Object.freeze([
  "required",
  "null",
  "invalid_type",
  "invalid_value",
  "min_length",
  "max_length",
  "length",
  "min",
  "max",
  "too_small",
  "too_big",
  "int",
  "multiple_of",
  "not_multiple_of",
  ...STRING_FORMAT_NAMES,
  "regex",
  "starts_with",
  "ends_with",
  "includes",
  "format",
  "invalid_format",
  "custom",
  "unrecognized_keys",
  "invalid_union",
]);
