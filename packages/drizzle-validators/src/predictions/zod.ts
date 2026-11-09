import type { z } from "zod";
import { resolveStringFormatName } from "../format-names";
import {
  candidateKeys,
  normalizeEntry,
  siteOf,
} from "../error-map";
import { unwrapAll } from "../refine";
import { getZodDef, UNWRAP_PROXY } from "../zod-compat";
import {
  ALL_PORTABLE_KEYS,
  expandFormatCascade,
  expandLengthCascade,
  expandMaxCascade,
  expandMinCascade,
  expandMultipleOfCascade,
  SIZED_ORIGIN_TYPES,
  type CoreTypeDescriptor,
  type ErrorsOfOptions,
  type FieldErrorRecord,
  type KeyConstraintMeta,
  type ObjectPredictedIssues,
  type PortableErrorKey,
  type PredictedIssue,
  type PredictOptions,
} from "./core";

const KNOWN_ZOD_CORES = new Set([
  "string",
  "number",
  "bigint",
  "boolean",
  "date",
  "array",
  "set",
  "tuple",
  "record",
  "enum",
  "literal",
  "object",
  "union",
  "discriminatedUnion",
  "null",
  "undefined",
  "void",
  "never",
]);

function assignMeta(
  meta: Record<string, KeyConstraintMeta>,
  keys: readonly PortableErrorKey[],
  value: KeyConstraintMeta,
): void {
  for (const k of keys) {
    meta[k] = { ...meta[k], ...value };
  }
}

/**
 * Introspects a single Zod field schema (unwrapping proxies and optional/nullable/default/catch/readonly layers)
 * and returns the exact ordered set of error keys it can emit alongside static constraint metadata.
 */
export function predictedKeys(
  field: z.ZodTypeAny,
  options?: PredictOptions,
): PredictedIssue {
  const includeCore = options?.includeCore ?? true;
  const includeChecks = options?.includeChecks ?? true;

  const rawField = ((field as any)?.[UNWRAP_PROXY] ?? field) as z.ZodTypeAny;
  const { core, wrappers } = unwrapAll(rawField);
  const def = getZodDef(core);

  const optional = wrappers.some(
    (w) =>
      w.type === "optional" ||
      w.type === "exactOptional" ||
      w.type === "default" ||
      w.type === "catch",
  );
  const nullable = wrappers.some(
    (w) => w.type === "nullable" || w.type === "catch",
  );

  if (!def || !KNOWN_ZOD_CORES.has(def.type)) {
    return {
      keys: includeCore ? ALL_PORTABLE_KEYS : [],
      meta: Object.freeze({}),
      coreType: Object.freeze({
        type: def?.type ?? "unknown",
        optional,
        nullable,
        sizedOrigin: false,
        intCheck: false,
        isEnum: false,
        isObject: false,
        isStrictObject: false,
        isUnion: false,
      }),
    };
  }

  const coreTypeStr = def.type;
  const sizedOrigin = SIZED_ORIGIN_TYPES.has(coreTypeStr);
  const topFormat =
    coreTypeStr === "string" && typeof def.format === "string"
      ? resolveStringFormatName(def)
      : undefined;
  const topInt =
    coreTypeStr === "number" && /int/i.test(String(def.format ?? ""));
  const isEnum = coreTypeStr === "enum" || coreTypeStr === "literal";
  const isObject = coreTypeStr === "object";
  const catchallDef =
    isObject && def.catchall ? getZodDef(def.catchall) : undefined;
  const isStrictObject = isObject && catchallDef?.type === "never";
  const isUnion =
    coreTypeStr === "union" || coreTypeStr === "discriminatedUnion";

  const keySet = new Set<PortableErrorKey>();
  const meta: Record<string, KeyConstraintMeta> = {};

  let hasIntCheck = topInt;

  if (includeCore) {
    if (!optional && coreTypeStr !== "undefined" && coreTypeStr !== "void") {
      keySet.add("required");
    }
    if (!nullable && coreTypeStr !== "null") {
      keySet.add("null");
    }
    if (isEnum) {
      keySet.add("invalid_value");
      keySet.add("invalid_type");
      const values = Array.isArray((def as any).values)
        ? (def as any).values
        : (def as any).entries
          ? Object.values((def as any).entries)
          : undefined;
      if (values) meta.invalid_value = { values };
    } else if (isUnion) {
      keySet.add("invalid_union");
      keySet.add("invalid_type");
    } else {
      keySet.add("invalid_type");
    }

    if (isStrictObject) {
      keySet.add("unrecognized_keys");
    }
  }

  if (includeChecks) {
    // Top-level Zod 4 format / integer primitives (e.g. z.email(), z.uuidv4(), z.int())
    if (topFormat) {
      const cascade = expandFormatCascade(topFormat);
      for (const k of cascade) keySet.add(k);
      assignMeta(meta, cascade, { format: topFormat });
    }
    if (topInt) {
      keySet.add("int");
    }

    if (Array.isArray(def.checks)) {
      for (const check of def.checks) {
        const checkDef = getZodDef(check);
        if (!checkDef || typeof checkDef.check !== "string") continue;

        switch (checkDef.check) {
          case "overwrite":
            break;
          case "min_length": {
            const cascade = expandMinCascade(true);
            for (const k of cascade) keySet.add(k);
            if (checkDef.minimum !== undefined) {
              assignMeta(meta, cascade, {
                minimum: checkDef.minimum as number,
                inclusive: true,
              });
            }
            break;
          }
          case "max_length": {
            const cascade = expandMaxCascade(true);
            for (const k of cascade) keySet.add(k);
            if (checkDef.maximum !== undefined) {
              assignMeta(meta, cascade, {
                maximum: checkDef.maximum as number,
                inclusive: true,
              });
            }
            break;
          }
          case "length_equals": {
            const cascade = expandLengthCascade();
            for (const k of cascade) keySet.add(k);
            if (checkDef.length !== undefined) {
              assignMeta(meta, cascade, { exact: checkDef.length as number });
            }
            break;
          }
          case "greater_than": {
            const cascade = expandMinCascade(sizedOrigin);
            for (const k of cascade) keySet.add(k);
            if (checkDef.value !== undefined) {
              assignMeta(meta, cascade, {
                minimum: checkDef.value as number | bigint | Date,
                inclusive: Boolean(checkDef.inclusive ?? true),
              });
            }
            break;
          }
          case "less_than": {
            const cascade = expandMaxCascade(sizedOrigin);
            for (const k of cascade) keySet.add(k);
            if (checkDef.value !== undefined) {
              assignMeta(meta, cascade, {
                maximum: checkDef.value as number | bigint | Date,
                inclusive: Boolean(checkDef.inclusive ?? true),
              });
            }
            break;
          }
          case "multiple_of": {
            const cascade = expandMultipleOfCascade();
            for (const k of cascade) keySet.add(k);
            if (checkDef.value !== undefined) {
              assignMeta(meta, cascade, {
                multipleOf: checkDef.value as number | bigint,
              });
            }
            break;
          }
          case "number_format": {
            if (/int/i.test(String(checkDef.format ?? ""))) {
              hasIntCheck = true;
              keySet.add("int");
            }
            break;
          }
          case "string_format": {
            const fmt = resolveStringFormatName(checkDef);
            if (fmt) {
              const cascade = expandFormatCascade(fmt);
              for (const k of cascade) keySet.add(k);
              const fmtMeta: KeyConstraintMeta = { format: fmt };
              if (checkDef.pattern instanceof RegExp) {
                fmtMeta.pattern = checkDef.pattern.source;
              }
              if (typeof checkDef.prefix === "string") {
                fmtMeta.prefix = checkDef.prefix;
              }
              if (typeof checkDef.suffix === "string") {
                fmtMeta.suffix = checkDef.suffix;
              }
              if (typeof checkDef.includes === "string") {
                fmtMeta.includes = checkDef.includes;
              }
              assignMeta(meta, cascade, fmtMeta);
            }
            break;
          }
          case "custom": {
            keySet.add("custom");
            break;
          }
          default:
            break;
        }
      }
    }
  }

  const coreType: CoreTypeDescriptor = Object.freeze({
    type: coreTypeStr,
    ...(topFormat ? { format: topFormat } : {}),
    optional,
    nullable,
    sizedOrigin,
    intCheck: hasIntCheck,
    isEnum,
    isObject,
    isStrictObject,
    isUnion,
  });

  return {
    keys: Object.freeze(Array.from(keySet)),
    meta: Object.freeze(meta),
    coreType,
  };
}

/**
 * Predicts the error surface for every field of a ZodObject schema.
 */
export function predictedKeysObject<T extends z.ZodObject<any>>(
  schema: T,
  options?: PredictOptions,
): ObjectPredictedIssues<T["shape"]> {
  const out: Record<string, PredictedIssue> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    out[key] = predictedKeys(field as z.ZodTypeAny, options);
  }
  return Object.freeze(out) as ObjectPredictedIssues<T["shape"]>;
}

function getAt(obj: unknown, path: (string | number)[]): unknown {
  let curr = obj;
  for (const seg of path) {
    if (curr == null || typeof curr !== "object") return undefined;
    curr = (curr as any)[seg];
  }
  return curr;
}

function resolveFieldSchemaAtPath(
  rootSchema: z.ZodTypeAny,
  path: PropertyKey[],
): z.ZodTypeAny | undefined {
  let current: z.ZodTypeAny | undefined = rootSchema;
  for (const segment of path) {
    if (!current) return undefined;
    const { core } = unwrapAll(current);
    const def = getZodDef(core);
    if (!def) return undefined;
    if (def.type === "object" && def.shape && typeof segment === "string") {
      current = def.shape[segment];
    } else if (def.type === "array" && def.element && typeof segment === "number") {
      current = def.element;
    } else {
      return core;
    }
  }
  return current;
}

function extractIssueCtx(
  issue: Record<string, any>,
): Readonly<Record<string, unknown>> | undefined {
  const ctx: Record<string, unknown> = {};
  const keys = [
    "minimum",
    "maximum",
    "inclusive",
    "exact",
    "format",
    "pattern",
    "prefix",
    "suffix",
    "includes",
    "divisor",
    "multipleOf",
    "expected",
    "values",
    "keys",
  ] as const;
  for (const k of keys) {
    if (issue[k] !== undefined) {
      ctx[k === "divisor" ? "multipleOf" : k] = issue[k];
    }
  }
  return Object.keys(ctx).length > 0 ? Object.freeze(ctx) : undefined;
}

export function errorsOf<T extends z.ZodObject<any>>(
  schema: T,
  input: unknown,
  options?: ErrorsOfOptions,
): FieldErrorRecord[] {
  const parsed = schema.safeParse(input);
  if (parsed.success) return [];

  const seenFields = new Set<string>();
  const records: FieldErrorRecord[] = [];

  for (const rawIssue of parsed.error.issues) {
    const issue = rawIssue as Record<string, any>;
    const rawPath: PropertyKey[] = Array.isArray(issue.path) ? issue.path : [];
    const path = rawPath
      .filter((p): p is string | number => typeof p === "string" || typeof p === "number");
    const field = path.length > 0 ? path.join(".") : "_root";

    if (options?.sparse && seenFields.has(field)) {
      continue;
    }
    seenFields.add(field);

    const instDef = getZodDef(issue.inst);
    const isCheck = Boolean(instDef && typeof instDef.check === "string" && instDef.type === undefined);
    let site = instDef ? siteOf(instDef, isCheck) : undefined;

    if (!site) {
      const fieldSchema = resolveFieldSchemaAtPath(schema, rawPath);
      const coreDef = fieldSchema ? getZodDef(unwrapAll(fieldSchema).core) : getZodDef(schema);
      site = coreDef
        ? siteOf(coreDef, false)
        : { isCheck: false, intCheck: false, sizedOrigin: false, formatName: undefined };
    }

    const resolvedInput = "input" in issue ? issue.input : getAt(input, path);
    const issueWithInput =
      "input" in issue ? issue : { ...issue, input: resolvedInput };
    const candidates = candidateKeys(issueWithInput, site) as PortableErrorKey[];
    const fallbackCandidates: readonly PortableErrorKey[] =
      candidates.length > 0 ? candidates : ["custom"];
    const kind = fallbackCandidates[0]!;

    let message = String(issue.message ?? "Invalid input");
    if (options?.errorMap && typeof options.errorMap === "object") {
      const fieldMap = (options.errorMap as Record<string, any>)[field];
      if (fieldMap) {
        const normalized = normalizeEntry(fieldMap, field);
        for (const k of [...fallbackCandidates, "default"]) {
          const entry = normalized[k];
          if (entry !== undefined) {
            const resolved = typeof entry === "function" ? entry(issueWithInput as any) : entry;
            if (resolved !== undefined) {
              message = resolved;
              break;
            }
          }
        }
      }
    }

    const ctx = extractIssueCtx(issue);
    records.push({
      field,
      path,
      kind,
      candidates: Object.freeze(fallbackCandidates),
      message,
      ...(ctx ? { ctx } : {}),
      ...(resolvedInput !== undefined ? { input: resolvedInput } : "input" in issue ? { input: issue.input } : {}),
    });
  }

  return records;
}
