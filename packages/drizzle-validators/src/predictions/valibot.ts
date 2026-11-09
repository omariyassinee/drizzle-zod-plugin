import { safeParse } from "valibot";
import { candidateVKeys, normalizeVEntry, unwrapAllV } from "../valibot-error-map";
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

export * from "./core";

const VALIBOT_FORMAT_MAP: Readonly<Record<string, string>> = {
  email: "email",
  url: "url",
  uuid: "uuid",
  cuid2: "cuid2",
  ulid: "ulid",
  nanoid: "nanoid",
  ipv4: "ipv4",
  ipv6: "ipv6",
  base64: "base64",
  emoji: "emoji",
  regex: "regex",
  starts_with: "starts_with",
  ends_with: "ends_with",
  includes: "includes",
  iso_date: "date",
  iso_time: "time",
  iso_date_time: "datetime",
  iso_timestamp: "datetime",
};

export function predictedVKeys(
  field: unknown,
  options?: PredictOptions,
): PredictedIssue {
  const includeCore = options?.includeCore ?? true;
  const includeChecks = options?.includeChecks ?? true;

  const { core, wrappers } = unwrapAllV(field as any);

  let optional = false;
  let nullable = false;
  for (let i = wrappers.length - 1; i >= 0; i--) {
    const w = wrappers[i]!;
    if (w.type === "optional" || w.type === "exact_optional" || w.type === "fallback") {
      optional = true;
    } else if (w.type === "nullable") {
      nullable = true;
    } else if (w.type === "nullish") {
      optional = true;
      nullable = true;
    } else if (w.type === "non_optional") {
      optional = false;
    } else if (w.type === "non_nullable") {
      nullable = false;
    } else if (w.type === "non_nullish") {
      optional = false;
      nullable = false;
    }
  }
  const base =
    core && Array.isArray((core as any).pipe) && (core as any).pipe.length > 0
      ? (core as any).pipe[0]
      : core;
  const pipeActions: any[] =
    core && Array.isArray((core as any).pipe) ? (core as any).pipe.slice(1) : [];

  const coreTypeStr: string = typeof base?.type === "string" ? base.type : "unknown";
  if (coreTypeStr === "unknown" || coreTypeStr === "any") {
    return {
      keys: includeCore ? ALL_PORTABLE_KEYS : [],
      meta: Object.freeze({}),
      coreType: Object.freeze({
        type: coreTypeStr,
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

  const sizedOrigin = SIZED_ORIGIN_TYPES.has(coreTypeStr);
  const isEnum =
    coreTypeStr === "picklist" ||
    coreTypeStr === "enum" ||
    coreTypeStr === "literal";
  const isStrictObject = coreTypeStr === "strict_object";
  const isObject =
    coreTypeStr === "object" ||
    coreTypeStr === "strict_object" ||
    coreTypeStr === "loose_object" ||
    coreTypeStr === "object_with_rest";
  const isUnion = coreTypeStr === "union" || coreTypeStr === "variant";

  const keySet = new Set<PortableErrorKey>();
  const meta: Record<string, KeyConstraintMeta> = {};
  let hasIntCheck = false;

  if (includeCore) {
    if (!optional) keySet.add("required");
    if (!nullable) keySet.add("null");
    if (isEnum) {
      keySet.add("invalid_value");
      keySet.add("invalid_type");
      const values = Array.isArray(base.options)
        ? base.options
        : base.literal !== undefined
          ? [base.literal]
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
    for (const action of pipeActions) {
      if (!action || action.kind !== "validation") continue;
      const aType = String(action.type ?? "");

      switch (aType) {
        case "min_length": {
          const cascade = expandMinCascade(true);
          for (const k of cascade) keySet.add(k);
          if (action.requirement !== undefined) {
            for (const k of cascade) meta[k] = { minimum: action.requirement, inclusive: true };
          }
          break;
        }
        case "max_length": {
          const cascade = expandMaxCascade(true);
          for (const k of cascade) keySet.add(k);
          if (action.requirement !== undefined) {
            for (const k of cascade) meta[k] = { maximum: action.requirement, inclusive: true };
          }
          break;
        }
        case "length": {
          const cascade = expandLengthCascade();
          for (const k of cascade) keySet.add(k);
          if (action.requirement !== undefined) {
            for (const k of cascade) meta[k] = { exact: action.requirement };
          }
          break;
        }
        case "min_value":
        case "gt_value": {
          const cascade = expandMinCascade(sizedOrigin);
          for (const k of cascade) keySet.add(k);
          if (action.requirement !== undefined) {
            for (const k of cascade) {
              meta[k] = {
                minimum: action.requirement,
                inclusive: aType === "min_value",
              };
            }
          }
          break;
        }
        case "max_value":
        case "lt_value": {
          const cascade = expandMaxCascade(sizedOrigin);
          for (const k of cascade) keySet.add(k);
          if (action.requirement !== undefined) {
            for (const k of cascade) {
              meta[k] = {
                maximum: action.requirement,
                inclusive: aType === "max_value",
              };
            }
          }
          break;
        }
        case "multiple_of": {
          const cascade = expandMultipleOfCascade();
          for (const k of cascade) keySet.add(k);
          if (action.requirement !== undefined) {
            for (const k of cascade) meta[k] = { multipleOf: action.requirement };
          }
          break;
        }
        case "integer":
        case "safe_integer": {
          hasIntCheck = true;
          keySet.add("int");
          break;
        }
        case "check":
        case "raw_check":
        case "partial_check": {
          keySet.add("custom");
          break;
        }
        default: {
          const mappedFormat = VALIBOT_FORMAT_MAP[aType];
          if (mappedFormat) {
            const cascade = expandFormatCascade(mappedFormat);
            for (const k of cascade) keySet.add(k);
            for (const k of cascade) {
              meta[k] = {
                format: mappedFormat,
                ...(action.requirement instanceof RegExp
                  ? { pattern: action.requirement.source }
                  : {}),
              };
            }
          }
          break;
        }
      }
    }
  }

  const coreType: CoreTypeDescriptor = Object.freeze({
    type: coreTypeStr,
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

export function predictedVKeysObject<T extends Record<string, any>>(
  schema: T,
  options?: PredictOptions,
): ObjectPredictedIssues {
  const { core } = unwrapAllV(schema);
  const base =
    core && Array.isArray((core as any).pipe) && (core as any).pipe.length > 0
      ? (core as any).pipe[0]
      : core;
  const entries = (base?.entries ?? {}) as Record<string, unknown>;
  const out: Record<string, PredictedIssue> = {};
  for (const [key, field] of Object.entries(entries)) {
    out[key] = predictedVKeys(field, options);
  }
  return Object.freeze(out);
}

function getAt(obj: unknown, path: (string | number)[]): unknown {
  let curr = obj;
  for (const seg of path) {
    if (curr == null || typeof curr !== "object") return undefined;
    curr = (curr as any)[seg];
  }
  return curr;
}

export function errorsOfV(
  schema: any,
  input: unknown,
  options?: ErrorsOfOptions,
): FieldErrorRecord[] {
  const result = safeParse(schema, input);
  if (result.success) return [];

  const seenFields = new Set<string>();
  const records: FieldErrorRecord[] = [];

  for (const issue of result.issues) {
    const path: (string | number)[] = Array.isArray(issue.path)
      ? issue.path
          .map((p: any) => p?.key)
          .filter((k: unknown): k is string | number => typeof k === "string" || typeof k === "number")
      : [];
    const field = path.length > 0 ? path.join(".") : "_root";

    if (options?.sparse && seenFields.has(field)) {
      continue;
    }
    seenFields.add(field);

    const candidates = candidateVKeys(issue as any) as PortableErrorKey[];
    const fallbackCandidates: readonly PortableErrorKey[] =
      candidates.length > 0 ? candidates : ["custom"];
    const kind = fallbackCandidates[0]!;

    const resolvedInput = "input" in issue ? issue.input : getAt(input, path);

    let message = String(issue.message ?? "Invalid input");
    if (options?.errorMap && typeof options.errorMap === "object") {
      const fieldMap = (options.errorMap as Record<string, any>)[field];
      if (fieldMap) {
        const normalized = normalizeVEntry(fieldMap, field);
        for (const k of [...fallbackCandidates, "default"]) {
          const entry = normalized[k];
          if (entry !== undefined) {
            const resolved = typeof entry === "function" ? entry(issue as any) : entry;
            if (resolved !== undefined) {
              message = resolved;
              break;
            }
          }
        }
      }
    }

    const ctx: Record<string, unknown> = {};
    if (issue.requirement !== undefined) {
      if (issue.type === "min_length" || issue.type === "min_value" || issue.type === "gt_value") {
        ctx.minimum = issue.requirement;
      } else if (issue.type === "max_length" || issue.type === "max_value" || issue.type === "lt_value") {
        ctx.maximum = issue.requirement;
      } else if (issue.type === "length") {
        ctx.exact = issue.requirement;
      } else if (issue.type === "multiple_of") {
        ctx.multipleOf = issue.requirement;
      } else {
        ctx.requirement = issue.requirement;
      }
    }
    if (issue.expected !== undefined) ctx.expected = issue.expected;
    if (issue.received !== undefined) ctx.received = issue.received;

    records.push({
      field,
      path,
      kind,
      candidates: Object.freeze(fallbackCandidates),
      message,
      ...(Object.keys(ctx).length > 0 ? { ctx: Object.freeze(ctx) } : {}),
      ...(resolvedInput !== undefined ? { input: resolvedInput } : "input" in issue ? { input: issue.input } : {}),
    });
  }

  return records;
}
