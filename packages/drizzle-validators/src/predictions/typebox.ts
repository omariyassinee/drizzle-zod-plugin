import {
  ALL_PORTABLE_KEYS,
  expandFormatCascade,
  expandLengthCascade,
  expandMaxCascade,
  expandMinCascade,
  expandMultipleOfCascade,
  SIZED_ORIGIN_TYPES,
  type CoreTypeDescriptor,
  type KeyConstraintMeta,
  type ObjectPredictedIssues,
  type PortableErrorKey,
  type PredictedIssue,
  type PredictOptions,
} from "./core";

export * from "./core";

function isOptionalTypeBoxNode(
  node: Record<string, any>,
  isPropertyRequired = true,
): boolean {
  if (!isPropertyRequired) return true;
  for (const sym of Object.getOwnPropertySymbols(node)) {
    if (sym.description?.includes("Optional") || String(sym).includes("Optional")) {
      return true;
    }
  }
  return node["~optional"] === true || node.modifier === "Optional";
}

function unwrapNullableUnion(node: Record<string, any>): {
  core: Record<string, any>;
  nullable: boolean;
} {
  if (node.type === "null") {
    return { core: node, nullable: true };
  }
  if (Array.isArray(node.anyOf)) {
    const nonNullBranches = node.anyOf.filter(
      (b: any) => !(b && typeof b === "object" && b.type === "null"),
    );
    const hadNull = nonNullBranches.length < node.anyOf.length;
    if (hadNull && nonNullBranches.length === 1) {
      return { core: nonNullBranches[0], nullable: true };
    }
    return { core: node, nullable: hadNull };
  }
  return { core: node, nullable: false };
}

export function predictedTKeys(
  field: unknown,
  options?: PredictOptions & { isPropertyRequired?: boolean },
): PredictedIssue {
  const includeCore = options?.includeCore ?? true;
  const includeChecks = options?.includeChecks ?? true;

  if (!field || typeof field !== "object") {
    return {
      keys: includeCore ? ALL_PORTABLE_KEYS : [],
      meta: Object.freeze({}),
      coreType: Object.freeze({
        type: "unknown",
        optional: false,
        nullable: false,
        sizedOrigin: false,
        intCheck: false,
        isEnum: false,
        isObject: false,
        isStrictObject: false,
        isUnion: false,
      }),
    };
  }

  const rawNode = field as Record<string, any>;
  const optional = isOptionalTypeBoxNode(rawNode, options?.isPropertyRequired ?? true);
  const { core, nullable } = unwrapNullableUnion(rawNode);

  const isEnum =
    Array.isArray(core.enum) ||
    core.const !== undefined ||
    (Array.isArray(core.anyOf) &&
      core.anyOf.length > 0 &&
      core.anyOf.every((b: any) => b && typeof b === "object" && "const" in b));
  const isUnion = !isEnum && Array.isArray(core.anyOf);
  const rawType = typeof core.type === "string" ? core.type : isEnum ? "enum" : isUnion ? "union" : "any";

  if (rawType === "any" && Object.keys(core).length === 0) {
    return {
      keys: includeCore ? ALL_PORTABLE_KEYS : [],
      meta: Object.freeze({}),
      coreType: Object.freeze({
        type: "any",
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

  const coreTypeStr = rawType === "integer" ? "number" : rawType;
  const intCheck = rawType === "integer";
  const sizedOrigin = SIZED_ORIGIN_TYPES.has(coreTypeStr);
  const isObject = coreTypeStr === "object";
  const isStrictObject = isObject && core.additionalProperties === false;

  const keySet = new Set<PortableErrorKey>();
  const meta: Record<string, KeyConstraintMeta> = {};

  if (includeCore) {
    if (!optional) keySet.add("required");
    if (!nullable && rawType !== "null") keySet.add("null");
    if (isEnum) {
      keySet.add("invalid_value");
      keySet.add("invalid_type");
      const values = Array.isArray(core.enum)
        ? core.enum
        : core.const !== undefined
          ? [core.const]
          : core.anyOf?.map((b: any) => b.const);
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
    if (intCheck) {
      keySet.add("int");
    }
    if (typeof core.minLength === "number" && typeof core.maxLength === "number" && core.minLength === core.maxLength) {
      const cascade = expandLengthCascade();
      for (const k of cascade) keySet.add(k);
      for (const k of cascade) meta[k] = { exact: core.minLength };
    } else {
      if (typeof core.minLength === "number") {
        const cascade = expandMinCascade(true);
        for (const k of cascade) keySet.add(k);
        for (const k of cascade) meta[k] = { minimum: core.minLength, inclusive: true };
      }
      if (typeof core.maxLength === "number") {
        const cascade = expandMaxCascade(true);
        for (const k of cascade) keySet.add(k);
        for (const k of cascade) meta[k] = { maximum: core.maxLength, inclusive: true };
      }
    }

    if (core.minimum !== undefined || core.exclusiveMinimum !== undefined) {
      const inclusive = core.minimum !== undefined;
      const minVal = inclusive ? core.minimum : core.exclusiveMinimum;
      const cascade = expandMinCascade(sizedOrigin);
      for (const k of cascade) keySet.add(k);
      for (const k of cascade) meta[k] = { minimum: minVal, inclusive };
    }
    if (core.maximum !== undefined || core.exclusiveMaximum !== undefined) {
      const inclusive = core.maximum !== undefined;
      const maxVal = inclusive ? core.maximum : core.exclusiveMaximum;
      const cascade = expandMaxCascade(sizedOrigin);
      for (const k of cascade) keySet.add(k);
      for (const k of cascade) meta[k] = { maximum: maxVal, inclusive };
    }
    if (core.multipleOf !== undefined) {
      const cascade = expandMultipleOfCascade();
      for (const k of cascade) keySet.add(k);
      for (const k of cascade) meta[k] = { multipleOf: core.multipleOf };
    }
    if (typeof core.pattern === "string") {
      const cascade = expandFormatCascade("regex");
      for (const k of cascade) keySet.add(k);
      for (const k of cascade) meta[k] = { format: "regex", pattern: core.pattern };
    }
    if (typeof core.format === "string") {
      const cascade = expandFormatCascade(core.format);
      for (const k of cascade) keySet.add(k);
      for (const k of cascade) meta[k] = { format: core.format };
    }
  }

  const coreType: CoreTypeDescriptor = Object.freeze({
    type: coreTypeStr,
    ...(typeof core.format === "string" ? { format: core.format } : {}),
    optional,
    nullable,
    sizedOrigin,
    intCheck,
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

export function predictedTKeysObject<T extends Record<string, any>>(
  schema: T,
  options?: PredictOptions,
): ObjectPredictedIssues {
  const properties = schema?.properties ?? {};
  const requiredSet = new Set<string>(Array.isArray(schema?.required) ? schema.required : []);
  const out: Record<string, PredictedIssue> = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    out[key] = predictedTKeys(propSchema, {
      ...options,
      isPropertyRequired: requiredSet.has(key),
    });
  }
  return Object.freeze(out);
}
