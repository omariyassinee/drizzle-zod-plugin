import * as v from "valibot";
import { DrizzleValidatorsError } from "./errors";
import {
  applyErrorMapToCoreV,
  isAuthoredVMessage,
  makeVObjectHandler,
  objectFieldMapsOf,
  mapOfV,
  normalizeVEntry,
  type FieldErrorMapV,
} from "./valibot-error-map";

// Unlike the Zod engine (which avoids importing zod because its namespace
// can never tree-shake), valibot is ~2.5 KB and this module is reachable
// ONLY from the valibot-only subpath and valibot virtual modules — so the
// real builders are used directly instead of hand-rolling pipe runners.

export const REFINED_VFIELD_STATE = Symbol.for(
  "drizzle-validators.refined-vfield",
);

export type AnyValibotNode = Record<string, any> & {
  kind?: string;
  type?: string;
  pipe?: unknown[];
  wrapped?: AnyValibotNode;
  entries?: Record<string, unknown>;
  message?: unknown;
  fallback?: unknown;
  default?: unknown;
  requirement?: unknown;
};

// Deliberately loose internal view: valibot's precise generics fight the
// proxy/rebuild machinery, so the engine works in BaseSchema terms and
// casts v.pipe results at the boundaries.
export type AnyValibotSchema = v.BaseSchema<unknown, any, v.BaseIssue<unknown>>;

export function isValibotSchema(value: unknown): value is AnyValibotNode {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as AnyValibotNode).kind === "schema" &&
    typeof (value as AnyValibotNode).type === "string" &&
    typeof (value as AnyValibotNode)["~run"] === "function"
  );
}

function isValibotAction(value: unknown): value is AnyValibotNode {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as AnyValibotNode).kind;
  return (
    kind === "validation" || kind === "transformation" || kind === "metadata"
  );
}

function isValibotPipedSchema(value: unknown): value is AnyValibotNode {
  return (
    isValibotSchema(value) &&
    Array.isArray((value as AnyValibotNode).pipe) &&
    (value as AnyValibotNode).pipe!.length > 0
  );
}

/**
 * Descriptor-preserving clone: keeps getters (and methods like `~run`)
 * bound to the CLONE, so a reconstructed wrapper runs against its own
 * `wrapped`. Never mutates the source (C1 invariant).
 */
function cloneValibotNode<T extends object>(
  node: T,
  overrides: Record<string, unknown> = {},
): T {
  const clone = Object.create(
    Object.getPrototypeOf(node),
    Object.getOwnPropertyDescriptors(node),
  );
  for (const [key, val] of Object.entries(overrides)) {
    Object.defineProperty(clone, key, {
      value: val,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return clone as T;
}

// ───────────────────────── Wrappers ─────────────────────────

type VWrapperDef =
  | {
      type: "optional" | "exact_optional" | "nullable" | "nullish";
      node: AnyValibotNode;
      default?: unknown;
      hasDefault: boolean;
    }
  | {
      type: "non_optional" | "non_nullable" | "non_nullish";
      node: AnyValibotNode;
      message?: unknown;
    }
  | {
      type: "fallback";
      node: AnyValibotNode;
      fallback: unknown;
    };

const OPTIONAL_TYPES = new Set([
  "optional",
  "exact_optional",
  "nullable",
  "nullish",
]);
const NON_TYPES = new Set(["non_optional", "non_nullable", "non_nullish"]);

export function unwrapAllV(field: unknown): {
  core: AnyValibotNode;
  wrappers: VWrapperDef[];
} {
  const wrappers: VWrapperDef[] = [];
  let current = field as AnyValibotNode;

  while (current && typeof current === "object") {
    // v.fallback attaches a `fallback` property to a CLONE of the inner
    // schema (not a wrapper node) — record it and keep peeling.
    if (
      "fallback" in current &&
      current.fallback !== undefined &&
      !OPTIONAL_TYPES.has(current.type ?? "") &&
      !NON_TYPES.has(current.type ?? "")
    ) {
      wrappers.push({
        type: "fallback",
        node: current,
        fallback: current.fallback,
      });
    }
    if (OPTIONAL_TYPES.has(current.type ?? "")) {
      wrappers.push({
        type: current.type as "optional",
        node: current,
        default: current.default,
        hasDefault: current.default !== undefined,
      });
      current = current.wrapped!;
      continue;
    }
    if (NON_TYPES.has(current.type ?? "")) {
      wrappers.push({
        type: current.type as any,
        node: current,
        message: current.message,
      });
      current = current.wrapped!;
      continue;
    }
    break;
  }

  return { core: current, wrappers };
}

/**
 * Maps wrapper `type` strings (snake_case, as recorded by unwrapAllV) to
 * valibot's builder functions. `(v as any)[wrapper.type]` is undefined for
 * snake_case names (valibot's namespace is camelCase: exactOptional,
 * nonOptional, nonNullable, nonNullish).
 */
const WRAPPER_BUILDERS: Record<string, (...args: any[]) => AnyValibotSchema> = {
  optional: v.optional as any,
  exact_optional: v.exactOptional as any,
  nullable: v.nullable as any,
  nullish: v.nullish as any,
  non_optional: v.nonOptional as any,
  non_nullable: v.nonNullable as any,
  non_nullish: v.nonNullish as any,
  readonly: v.readonly as any,
};

function applyWrappersV(
  core: AnyValibotNode,
  wrappers: VWrapperDef[],
): AnyValibotSchema {
  let current: AnyValibotSchema = core as AnyValibotSchema;
  for (let index = wrappers.length - 1; index >= 0; index--) {
    const wrapper = wrappers[index]!;
    switch (wrapper.type) {
      case "optional":
      case "exact_optional":
      case "nullable":
      case "nullish": {
        // Prefer the original wrapper node (preserves its message) with
        // only `wrapped` swapped; real builders handle the rest.
        if (wrapper.node.type === wrapper.type) {
          current = cloneValibotNode(wrapper.node as object, {
            wrapped: current,
          }) as AnyValibotSchema;
        } else {
          // narrowed (e.g. nullish -> nullable via .required())
          const builder = WRAPPER_BUILDERS[wrapper.type]!;
          current = wrapper.hasDefault
            ? builder(current, wrapper.default)
            : builder(current);
        }
        break;
      }
      case "non_optional":
      case "non_nullable":
      case "non_nullish": {
        if (wrapper.node.type === wrapper.type) {
          current = cloneValibotNode(wrapper.node as object, {
            wrapped: current,
          }) as AnyValibotSchema;
        } else {
          const builder = WRAPPER_BUILDERS[wrapper.type]!;
          current = wrapper.message
            ? builder(current, wrapper.message)
            : builder(current);
        }
        break;
      }
      case "fallback":
        current = v.fallback(current, wrapper.fallback) as AnyValibotSchema;
        break;
    }
  }
  return current;
}

// ───────────────────────── Action transfer ─────────────────────────

const PRIMARY_STRING_FORMATS = new Set([
  "email",
  "url",
  "uuid",
  "cuid2",
  "ulid",
  "nanoid",
  "ipv4",
  "ipv6",
  "ip",
  "iso_date",
  "iso_time",
  "iso_date_time",
  "iso_timestamp",
  "base64",
  "credit_card",
  "imei",
  "emoji",
  "bic",
  "iban",
  "mac",
  "mac48",
  "mac64",
  "hexadecimal",
  "hex_color",
  "octal",
  "decimal",
  "digits",
  "slug",
]);

const COMBINABLE_ACTIONS = new Set([
  "regex",
  "starts_with",
  "ends_with",
  "includes",
  "not_value",
  "not_length",
  "not_bytes",
  "not_size",
  "not_words",
  "not_graphemes",
]);

const ACTION_CORE_COMPAT: Record<string, (coreType: string) => boolean> = {
  min_value: (t) =>
    t === "number" || t === "bigint" || t === "date" || t === "string",
  max_value: (t) =>
    t === "number" || t === "bigint" || t === "date" || t === "string",
  gt_value: (t) => t === "number" || t === "bigint" || t === "date",
  lt_value: (t) => t === "number" || t === "bigint" || t === "date",
  value: (t) =>
    t === "number" || t === "bigint" || t === "date" || t === "string",
  multiple_of: (t) => t === "number" || t === "bigint",
  integer: (t) => t === "number",
  safe_integer: (t) => t === "number",
  finite: (t) => t === "number",
  min_length: (t) => t === "string" || t === "array",
  max_length: (t) => t === "string" || t === "array",
  length: (t) => t === "string" || t === "array",
  non_empty: (t) => t === "string" || t === "array",
  min_size: (t) => t === "set" || t === "map" || t === "blob",
  max_size: (t) => t === "set" || t === "map" || t === "blob",
  size: (t) => t === "set" || t === "map" || t === "blob",
  min_bytes: (t) => t === "string",
  max_bytes: (t) => t === "string",
  bytes: (t) => t === "string",
  // primary string formats — every one targets string cores only
  email: (t) => t === "string",
  uuid: (t) => t === "string",
  url: (t) => t === "string",
  ipv4: (t) => t === "string",
  ipv6: (t) => t === "string",
  ip: (t) => t === "string",
  iso_date: (t) => t === "string",
  iso_time: (t) => t === "string",
  iso_date_time: (t) => t === "string",
  iso_timestamp: (t) => t === "string",
  base64: (t) => t === "string",
  credit_card: (t) => t === "string",
  imei: (t) => t === "string",
  emoji: (t) => t === "string",
  bic: (t) => t === "string",
  iban: (t) => t === "string",
  mac: (t) => t === "string",
  mac48: (t) => t === "string",
  mac64: (t) => t === "string",
  hexadecimal: (t) => t === "string",
  hex_color: (t) => t === "string",
  octal: (t) => t === "string",
  decimal: (t) => t === "string",
  digits: (t) => t === "string",
  slug: (t) => t === "string",
  cuid2: (t) => t === "string",
  ulid: (t) => t === "string",
  nanoid: (t) => t === "string",
  regex: (t) => t === "string",
  starts_with: (t) => t === "string",
  ends_with: (t) => t === "string",
  includes: (t) => t === "string",
  trim: (t) => t === "string",
  normalize: (t) => t === "string",
  to_lower_case: (t) => t === "string",
  to_upper_case: (t) => t === "string",
  check: () => true,
  raw_check: () => true,
  partial_check: () => true,
  readonly: () => true,
};

function actionSignature(action: AnyValibotNode): string {
  if (PRIMARY_STRING_FORMATS.has(action.type ?? "")) {
    return "string_format:primary";
  }
  if (COMBINABLE_ACTIONS.has(action.type ?? "")) {
    return `string_format:${action.type}`;
  }
  return action.type ?? "";
}

function toFinite(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Cross-action satisfiability (mirrors the Zod engine): an exact-signature
 * match is skipped by the occupied set, but a source bound that CONFLICTS
 * with a different target bound is dropped rather than synthesized into an
 * impossible schema (e.g. Drizzle's maxLength(8) onto minLength(10)).
 */
function conflictsWithTargetV(
  action: AnyValibotNode,
  targetActions: AnyValibotNode[],
): boolean {
  const requirement = toFinite(action.requirement);
  if (Number.isNaN(requirement)) return false;
  const bounds = {
    minLength: null as number | null,
    maxLength: null as number | null,
    lengthEquals: null as number | null,
    minValue: null as number | null,
    maxValue: null as number | null,
  };
  for (const target of targetActions) {
    const value = toFinite(target.requirement);
    if (Number.isNaN(value)) continue;
    switch (target.type) {
      case "min_length":
        bounds.minLength = Math.max(bounds.minLength ?? -Infinity, value);
        break;
      case "max_length":
        bounds.maxLength = Math.min(bounds.maxLength ?? Infinity, value);
        break;
      case "length":
        bounds.lengthEquals = value;
        break;
      case "non_empty":
        bounds.minLength = Math.max(bounds.minLength ?? -Infinity, 1);
        break;
      case "min_value":
      case "gt_value":
        bounds.minValue = Math.max(bounds.minValue ?? -Infinity, value);
        break;
      case "max_value":
      case "lt_value":
        bounds.maxValue = Math.min(bounds.maxValue ?? Infinity, value);
        break;
      case "value":
        bounds.lengthEquals = bounds.lengthEquals ?? null;
        bounds.minValue = value;
        bounds.maxValue = value;
        break;
    }
  }
  switch (action.type) {
    case "min_length":
      return (
        requirement > (bounds.maxLength ?? bounds.lengthEquals ?? Infinity)
      );
    case "max_length":
      return requirement < (bounds.minLength ?? bounds.lengthEquals ?? 0);
    case "length":
      return (
        requirement < (bounds.minLength ?? 0) ||
        requirement > (bounds.maxLength ?? Infinity)
      );
    case "non_empty":
      return (bounds.maxLength ?? Infinity) < 1;
    case "min_value":
    case "gt_value":
      return bounds.maxValue !== null && requirement > bounds.maxValue;
    case "max_value":
    case "lt_value":
      return bounds.minValue !== null && requirement < bounds.minValue;
    default:
      return false;
  }
}

/**
 * Merges a source (Drizzle-generated) core's pipe actions onto a user
 * target schema, honoring signature dedup (target wins), per-core-type
 * compatibility, and bound satisfiability. Returns the merged schema; the
 * inputs are never mutated.
 */
export function transferActionsV(
  source: AnyValibotNode,
  target: AnyValibotNode,
  options?: { transferChecks?: boolean },
): AnyValibotSchema {
  if (options?.transferChecks === false) return target as AnyValibotSchema;
  if (!isValibotPipedSchema(source)) return target as AnyValibotSchema;

  const sourceActions = (source.pipe as AnyValibotNode[]).slice(1);
  const targetIsPiped = isValibotPipedSchema(target);
  const targetBase = targetIsPiped
    ? ((target as AnyValibotNode).pipe as AnyValibotNode[])[0]!
    : (target as AnyValibotNode);
  const targetActions: AnyValibotNode[] = targetIsPiped
    ? ((target as AnyValibotNode).pipe as AnyValibotNode[]).slice(1)
    : [];

  const occupied = new Set(targetActions.map(actionSignature));
  const transferred: AnyValibotNode[] = [];
  for (const action of sourceActions) {
    if (!isValibotAction(action)) continue;
    const compat = ACTION_CORE_COMPAT[action.type ?? ""];
    if (!compat) {
      throw new DrizzleValidatorsError(
        `Unknown valibot action type "${action.type}" encountered during check transfer. ` +
          `Pass { transferChecks: false } to .as() to skip inherited actions.`,
      );
    }
    if (!compat(String(targetBase.type ?? ""))) continue;
    const signature = actionSignature(action);
    if (occupied.has(signature)) continue;
    if (conflictsWithTargetV(action, targetActions)) continue;
    occupied.add(signature);
    transferred.push(action);
  }

  if (transferred.length === 0) return target as AnyValibotSchema;
  // Rebuild from the UNPIPED base explicitly: v.pipe() with an already-
  // piped first argument DISCARDS that schema's existing actions and
  // re-anchors to a clone of its base, so the target's own actions must
  // be re-listed here.
  return v.pipe(
    targetBase as never,
    ...(targetActions as never[]),
    ...(transferred as never[]),
  ) as unknown as AnyValibotSchema;
}

/**
 * Appends NEW actions to a field's existing pipe, preserving execution
 * order: the source (column) actions run FIRST, then the newly appended
 * actions. This is the opposite of transferActionsV (used by .as()), which
 * puts the target's actions first and transfers compatible source actions
 * onto them. Used by `.pipe(...)` and native `v.pipe(fields.col, ...)`.
 *
 * Non-overridden, non-conflicting source actions are retained ahead of the
 * new actions; exact-signature duplicates and unsatisfiable bounds are
 * dropped (the new action wins).
 */
export function appendActionsV(
  source: AnyValibotNode,
  newActions: AnyValibotNode[],
): AnyValibotSchema {
  const base = isValibotPipedSchema(source)
    ? (source.pipe as AnyValibotNode[])[0]!
    : source;
  const sourceActions = isValibotPipedSchema(source)
    ? (source.pipe as AnyValibotNode[]).slice(1)
    : [];

  const occupiedByNew = new Set(newActions.map(actionSignature));
  const retainedSource: AnyValibotNode[] = [];

  for (const action of sourceActions) {
    if (!isValibotAction(action)) continue;
    const sig = actionSignature(action);
    if (occupiedByNew.has(sig)) continue;
    if (conflictsWithTargetV(action, newActions)) continue;
    retainedSource.push(action);
  }

  const combined = [...retainedSource, ...newActions];
  if (combined.length === 0) return base as AnyValibotSchema;
  return v.pipe(
    base as never,
    ...(combined as never[]),
  ) as unknown as AnyValibotSchema;
}

// ───────────────────────── Field proxy ─────────────────────────

function setErrorOnVField(
  field: AnyValibotNode,
  message: string,
): AnyValibotSchema {
  // `.setError()` is an EXPLICIT override: it replaces the message on the
  // base schema (pipe[0]) AND on every non-metadata action in the pipe.
  // Unlike the declarative error map (which respects authored messages),
  // setError always wins — including over a previous .setError() call.
  if (!Array.isArray(field.pipe) || field.pipe.length === 0) {
    return cloneValibotNode(field as object, { message }) as AnyValibotSchema;
  }
  const rawBase = (field.pipe as AnyValibotNode[])[0]!;
  const base = cloneValibotNode(rawBase as object, { message });
  const nextActions = (field.pipe as AnyValibotNode[])
    .slice(1)
    .map((action) => {
      if (
        typeof action === "object" &&
        action !== null &&
        action.kind !== "metadata"
      ) {
        return cloneValibotNode(action as object, { message });
      }
      return action;
    });
  // Rebuild through the REAL v.pipe — the pipe runner closes over its
  // arguments array, so a replaced `pipe` property is silently ignored.
  return v.pipe(
    base as never,
    ...(nextActions as never[]),
  ) as unknown as AnyValibotSchema;
}

function wrapVFieldProxy(
  core: AnyValibotNode,
  wrappers: VWrapperDef[],
  forcedError?: string,
): AnyValibotSchema {
  const state = { core, wrappers, forcedError };
  return new Proxy(core as object, {
    get(current, prop, receiver) {
      if (prop === REFINED_VFIELD_STATE) return state;
      if (prop === "as") {
        return (newCore: unknown, options?: { transferChecks?: boolean }) => {
          if (!isValibotSchema(newCore)) {
            throw new DrizzleValidatorsError(
              `.as() expects a valid valibot schema, got ${typeof newCore}.`,
            );
          }
          const merged = transferActionsV(
            core,
            newCore as unknown as AnyValibotNode,
            options,
          );
          return wrapVFieldProxy(
            merged as AnyValibotNode,
            wrappers,
            forcedError,
          );
        };
      }
      if (prop === "pipe") {
        return (...actions: unknown[]) => {
          for (const action of actions) {
            if (!isValibotAction(action)) {
              throw new DrizzleValidatorsError(
                `.pipe() expects valibot actions (v.minLength(...), v.email(), ...), ` +
                  `received ${typeof action}.`,
              );
            }
          }
          // Preserve execution order: inherited column actions run
          // FIRST, then the newly appended actions.
          const merged = appendActionsV(core, actions as AnyValibotNode[]);
          return wrapVFieldProxy(
            merged as AnyValibotNode,
            wrappers,
            forcedError,
          );
        };
      }
      if (prop === "setError" || prop === "withError") {
        return (message: string) =>
          wrapVFieldProxy(
            setErrorOnVField(core, message) as AnyValibotNode,
            wrappers,
            message,
          );
      }
      if (prop === "unwrap") {
        return () => wrapVFieldProxy(core, [], forcedError);
      }
      if (prop === "required" || prop === "nonnullable") {
        return () => {
          const next: VWrapperDef[] = [];
          for (const wrapper of wrappers) {
            if (prop === "required") {
              if (
                wrapper.type === "optional" ||
                wrapper.type === "exact_optional"
              ) {
                continue;
              }
              if (wrapper.type === "nullish") {
                next.push({
                  type: "nullable",
                  node: wrapper.node,
                  default: wrapper.default,
                  hasDefault: wrapper.hasDefault,
                });
                continue;
              }
            } else {
              if (wrapper.type === "nullable") continue;
              if (wrapper.type === "nullish") {
                next.push({
                  type: "optional",
                  node: wrapper.node,
                  default: wrapper.default,
                  hasDefault: wrapper.hasDefault,
                });
                continue;
              }
            }
            next.push(wrapper);
          }
          return wrapVFieldProxy(core, next, forcedError);
        };
      }
      return Reflect.get(current, prop, receiver);
    },
  }) as AnyValibotSchema;
}

function resolveReturnedVField(value: unknown): {
  schema: AnyValibotSchema;
  forcedError?: string;
} {
  // Case 1: the field proxy itself.
  if (typeof value === "object" && value !== null) {
    const state = (value as Record<symbol, unknown>)[REFINED_VFIELD_STATE] as
      | { core: AnyValibotNode; wrappers: VWrapperDef[]; forcedError?: string }
      | undefined;
    if (state) {
      return {
        schema: applyWrappersV(state.core, state.wrappers),
        forcedError: state.forcedError,
      };
    }
    // Case 2: a native v.pipe(fields.col, ...actions) — valibot keeps the
    // proxy at pipe[0]. Rebuild from the core's UNPIPED base with the
    // user's actions, then transfer the source's own actions (same path
    // as the .pipe proxy method) — never re-pipe the proxied core
    // itself, or its actions would run twice.
    if (
      isValibotPipedSchema(value) &&
      typeof (value as AnyValibotNode).pipe![0] === "object"
    ) {
      const innerState = (
        (value as AnyValibotNode).pipe![0] as Record<symbol, unknown>
      )[REFINED_VFIELD_STATE] as
        | {
            core: AnyValibotNode;
            wrappers: VWrapperDef[];
            forcedError?: string;
          }
        | undefined;
      if (innerState) {
        const { core, wrappers, forcedError } = innerState;
        const newActions = (value as AnyValibotNode).pipe!.slice(1);
        // Preserve execution order: inherited column actions run
        // FIRST, then the newly appended actions.
        const merged = appendActionsV(core, newActions as AnyValibotNode[]);
        return {
          schema: applyWrappersV(merged as AnyValibotNode, wrappers),
          forcedError,
        };
      }
    }
  }
  // Case 3: a plain valibot schema.
  if (isValibotSchema(value)) {
    return { schema: value as AnyValibotSchema };
  }
  throw new DrizzleValidatorsError(
    `Invalid refinement for a field: expected a valibot schema or a field proxy, received ${typeof value}.`,
  );
}

// ───────────────────────── Type layer ─────────────────────────

export type UnpipeV<T extends AnyValibotSchema> =
  T extends v.SchemaWithPipe<
    readonly [infer TBase extends AnyValibotSchema, ...any[]]
  >
    ? TBase
    : T;

export type DeepUnwrapV<T extends AnyValibotSchema> =
  T extends v.OptionalSchema<infer Inner extends AnyValibotSchema, any>
    ? DeepUnwrapV<Inner>
    : T extends v.ExactOptionalSchema<infer Inner extends AnyValibotSchema, any>
      ? DeepUnwrapV<Inner>
      : T extends v.NullableSchema<infer Inner extends AnyValibotSchema, any>
        ? DeepUnwrapV<Inner>
        : T extends v.NullishSchema<infer Inner extends AnyValibotSchema, any>
          ? DeepUnwrapV<Inner>
          : T extends v.NonOptionalSchema<
                infer Inner extends AnyValibotSchema,
                any
              >
            ? DeepUnwrapV<Inner>
            : T extends v.NonNullableSchema<
                  infer Inner extends AnyValibotSchema,
                  any
                >
              ? DeepUnwrapV<Inner>
              : T extends v.NonNullishSchema<
                    infer Inner extends AnyValibotSchema,
                    any
                  >
                ? DeepUnwrapV<Inner>
                : // v.fallback attaches a `fallback` property to a
                  // CLONE of the inner schema (not a wrapper node).
                  // Matching via v.SchemaWithFallback<infer Inner, any>
                  // forces TS to resolve the complex Fallback<TSchema>
                  // constraint during inference and blows the
                  // instantiation depth (TS2589) — match the
                  // `fallback` property structurally instead.
                  T extends AnyValibotSchema & { fallback: unknown }
                  ? DeepUnwrapV<Omit<T, "fallback">>
                  : T;

/**
 * Recursive wrapper preservation: drizzle/valibot emission wraps each
 * field at most once (e.g. v.optional(v.pipe(...))), but the chain is
 * rebuilt recursively so nested wrappers survive. Applied only ONCE per
 * field in ResolveRefinedVField (never recursively through VFieldProxy),
 * so it stays within TS's instantiation depth.
 */
export type PreserveVWrapper<
  TOriginal extends AnyValibotSchema,
  TNewCore extends AnyValibotSchema,
> =
  TOriginal extends v.OptionalSchema<
    infer Inner extends AnyValibotSchema,
    infer TDefault
  >
    ? v.OptionalSchema<PreserveVWrapper<Inner, TNewCore>, TDefault>
    : TOriginal extends v.ExactOptionalSchema<
          infer Inner extends AnyValibotSchema,
          infer TDefault
        >
      ? v.ExactOptionalSchema<PreserveVWrapper<Inner, TNewCore>, TDefault>
      : TOriginal extends v.NullableSchema<
            infer Inner extends AnyValibotSchema,
            infer TDefault
          >
        ? v.NullableSchema<PreserveVWrapper<Inner, TNewCore>, TDefault>
        : TOriginal extends v.NullishSchema<
              infer Inner extends AnyValibotSchema,
              infer TDefault
            >
          ? v.NullishSchema<PreserveVWrapper<Inner, TNewCore>, TDefault>
          : TOriginal extends v.NonOptionalSchema<
                infer Inner extends AnyValibotSchema,
                infer TMsg
              >
            ? v.NonOptionalSchema<PreserveVWrapper<Inner, TNewCore>, TMsg>
            : TOriginal extends v.NonNullableSchema<
                  infer Inner extends AnyValibotSchema,
                  infer TMsg
                >
              ? v.NonNullableSchema<PreserveVWrapper<Inner, TNewCore>, TMsg>
              : TOriginal extends v.NonNullishSchema<
                    infer Inner extends AnyValibotSchema,
                    infer TMsg
                  >
                ? v.NonNullishSchema<PreserveVWrapper<Inner, TNewCore>, TMsg>
                : TOriginal extends v.SchemaWithFallback<
                      infer Inner extends AnyValibotSchema,
                      infer TFallback
                    >
                  ? v.SchemaWithFallback<
                      PreserveVWrapper<Inner, TNewCore>,
                      TFallback
                    >
                  : TNewCore;

type RemoveVOptional<T extends AnyValibotSchema> =
  T extends v.OptionalSchema<infer Inner extends AnyValibotSchema, any>
    ? RemoveVOptional<Inner>
    : T extends v.ExactOptionalSchema<infer Inner extends AnyValibotSchema, any>
      ? RemoveVOptional<Inner>
      : T extends v.NullishSchema<
            infer Inner extends AnyValibotSchema,
            infer TDefault
          >
        ? v.NullableSchema<RemoveVOptional<Inner>, TDefault>
        : T;

type RemoveVNullable<T extends AnyValibotSchema> =
  T extends v.NullableSchema<infer Inner extends AnyValibotSchema, any>
    ? RemoveVNullable<Inner>
    : T extends v.NullishSchema<
          infer Inner extends AnyValibotSchema,
          infer TDefault
        >
      ? v.OptionalSchema<RemoveVNullable<Inner>, TDefault>
      : T;

/**
 * Type-level brand carried by every field proxy. The runtime proxy stores
 * `{ core, wrappers }`; this brand's `{ core, wrapper }` shape is a
 * type-level fiction used ONLY for inference (ResolveRefinedVField reads
 * TCore/TWrapper out of it). Extends AnyValibotSchema so a proxied field
 * satisfies valibot's BaseSchema constraint inside SchemaWithPipe.
 */
export type VFieldBrand<
  TCore extends AnyValibotSchema = AnyValibotSchema,
  TWrapper extends AnyValibotSchema = TCore,
> = AnyValibotSchema & {
  readonly [REFINED_VFIELD_STATE]: {
    readonly core: TCore;
    readonly wrapper: TWrapper;
  };
};

/**
 * The per-field callback proxy view. Two independent type parameters:
 * `TCore` is the unwrapped core (with its pipe actions intact) and
 * `TWrapper` is the original wrapped entry. `DeepUnwrapV` is applied only
 * at the RefinableVShape boundary and in `.as()`, never on the left-hand
 * side of this type — that was what blew TS's instantiation depth before.
 */
export type VFieldProxy<
  TCore extends AnyValibotSchema,
  TWrapper extends AnyValibotSchema = TCore,
> = TCore &
  VFieldBrand<TCore, TWrapper> & {
    // Zod-style: the first position carries the RAW new core (not
    // DeepUnwrapV<TNewCore>) — applying DeepUnwrapV there makes TS
    // recursively expand it through the VFieldProxy return type during
    // contextual typing and blows the instantiation depth (TS2589).
    // The wrapper is preserved around the UNWRAPPED core instead.
    as<TNewCore extends AnyValibotSchema>(
      newCoreSchema: TNewCore,
      options?: VAsOptions,
    ): VFieldProxy<TNewCore, PreserveVWrapper<TWrapper, DeepUnwrapV<TNewCore>>>;
    pipe<
      const TItems extends readonly v.PipeItem<
        any,
        any,
        v.BaseIssue<unknown>
      >[],
    >(
      ...actions: TItems
    ): VFieldProxy<
      v.SchemaWithPipe<readonly [UnpipeV<TCore>, ...TItems]>,
      TWrapper
    >;
    setError(message: string): VFieldProxy<TCore, TWrapper>;
    withError(message: string): VFieldProxy<TCore, TWrapper>;
    unwrap(): VFieldProxy<TCore, TCore>;
    required(): VFieldProxy<TCore, RemoveVOptional<TWrapper>>;
    nonnullable(): VFieldProxy<TCore, RemoveVNullable<TWrapper>>;
  };

export type RefinableVShape<TEntries extends Record<string, AnyValibotSchema>> =
  {
    [K in keyof TEntries]: VFieldProxy<DeepUnwrapV<TEntries[K]>, TEntries[K]>;
  };

export type VRefinementCallbackResult<
  TEntries extends Record<string, AnyValibotSchema>,
> = {
  [K in keyof TEntries]?: AnyValibotSchema;
} & {
  [key: string]: AnyValibotSchema | undefined;
};

type ResolveRefinedVField<TOriginal extends AnyValibotSchema, TReturned> =
  // 1. Native v.pipe(fields.x, ...actions) — SchemaWithPipe wrapping a
  //    proxy. Checked FIRST: SchemaWithPipe<[VFieldProxy, ...]> also
  //    carries the brand (Omit preserves it), so it must be sliced out
  //    before the direct-proxy branch or the new actions would be lost.
  Extract<
    TReturned,
    v.SchemaWithPipe<readonly [VFieldBrand<any, any>, ...any[]]>
  > extends infer TPiped
    ? [TPiped] extends [never]
      ? // 2. Direct VFieldProxy return (fields.x, fields.x.as(...),
        //    fields.x.pipe(...), fields.x.setError(...), ...).
        Extract<TReturned, VFieldBrand<any, any>> extends infer TBranded
        ? [TBranded] extends [never]
          ? // 3. Plain schema replacement.
            Extract<TReturned, TOriginal> extends never
            ? Exclude<TReturned, undefined> extends AnyValibotSchema
              ? Exclude<TReturned, undefined>
              : TOriginal
            : TOriginal
          : TBranded extends VFieldBrand<
                infer TCore extends AnyValibotSchema,
                infer TWrapper extends AnyValibotSchema
              >
            ? PreserveVWrapper<TWrapper, DeepUnwrapV<TCore>>
            : TOriginal
        : TOriginal
      : TPiped extends v.SchemaWithPipe<
            readonly [
              VFieldBrand<
                infer TCore extends AnyValibotSchema,
                infer TWrapper extends AnyValibotSchema
              >,
              ...infer TActions extends readonly v.PipeItem<
                any,
                any,
                v.BaseIssue<unknown>
              >[],
            ]
          >
        ? PreserveVWrapper<
            TWrapper,
            v.SchemaWithPipe<readonly [UnpipeV<TCore>, ...TActions]>
          >
        : TOriginal
    : TOriginal;

export type RefinedVEntries<
  TEntries extends Record<string, AnyValibotSchema>,
  R extends VRefinementCallbackResult<TEntries>,
> = Omit<TEntries, keyof R> & {
  [K in keyof R]: K extends keyof TEntries
    ? ResolveRefinedVField<TEntries[K], R[K]>
    : R[K] extends AnyValibotSchema
      ? R[K]
      : never;
};

export type RebuiltVObject<
  TBase extends AnyValibotSchema,
  TNewEntries extends v.ObjectEntries,
> =
  TBase extends v.StrictObjectSchema<any, infer TMsg>
    ? v.StrictObjectSchema<TNewEntries, TMsg>
    : TBase extends v.LooseObjectSchema<any, infer TMsg>
      ? v.LooseObjectSchema<TNewEntries, TMsg>
      : TBase extends v.ObjectWithRestSchema<any, infer TRest, infer TMsg>
        ? v.ObjectWithRestSchema<TNewEntries, TRest, TMsg>
        : TBase extends v.ObjectSchema<any, infer TMsg>
          ? v.ObjectSchema<TNewEntries, TMsg>
          : TBase extends v.SchemaWithPipe<
                readonly [
                  infer TInner extends AnyValibotSchema,
                  ...infer TPipeRest extends readonly v.PipeItem<
                    any,
                    any,
                    v.BaseIssue<unknown>
                  >[],
                ]
              >
            ? v.SchemaWithPipe<
                readonly [RebuiltVObject<TInner, TNewEntries>, ...TPipeRest]
              >
            : v.ObjectSchema<TNewEntries, undefined>;

export type VEntriesOf<T extends AnyValibotSchema> = T extends {
  entries: infer E extends Record<string, AnyValibotSchema>;
}
  ? E
  : T extends { pipe: readonly [infer B extends AnyValibotSchema, ...any[]] }
    ? VEntriesOf<B>
    : Record<string, AnyValibotSchema>;

// ───────────────────────── refineVSchema ─────────────────────────

export interface VAsOptions {
  transferChecks?: boolean;
}

export type VErrorMessage = v.ErrorMessage<v.BaseIssue<unknown>>;

function rebuildValibotObject(
  baseSchema: unknown,
  newEntries: Record<string, AnyValibotSchema>,
  fieldMaps?: Record<string, FieldErrorMapV>,
  forcedFieldErrors?: Record<string, string>,
): AnyValibotSchema {
  const isPiped = isValibotPipedSchema(baseSchema);
  const rawObject = isPiped
    ? ((baseSchema as AnyValibotNode).pipe as AnyValibotNode[])[0]!
    : (baseSchema as AnyValibotNode);
  const OBJECT_TYPES = new Set([
    "object",
    "strict_object",
    "loose_object",
    "object_with_rest",
  ]);
  if (!isValibotSchema(rawObject) || !OBJECT_TYPES.has(rawObject.type ?? "")) {
    throw new DrizzleValidatorsError(
      `refineVSchema expects a valibot object schema, got "${rawObject?.type ?? typeof baseSchema}".`,
    );
  }

  const overrides: Record<string, unknown> = {
    entries: { ...newEntries },
  };

  // Attach the object-level missing-key handler to the RAW object node
  // BEFORE v.pipe() wraps it: required-key issues are emitted by the
  // object's own ~run, so a handler on the outer SchemaWithPipe would
  // never fire. Respect authored object messages (isAuthoredVMessage).
  const hasFieldMaps = fieldMaps && Object.keys(fieldMaps).length > 0;
  const hasForced =
    forcedFieldErrors && Object.keys(forcedFieldErrors).length > 0;
  if (
    (hasFieldMaps || hasForced) &&
    !isAuthoredVMessage(rawObject as { message?: unknown })
  ) {
    const prev = objectFieldMapsOf(
      (rawObject as { message?: unknown }).message,
    );
    const merged: Record<string, FieldErrorMapV> = { ...(prev ?? {}) };
    if (fieldMaps) {
      for (const [key, map] of Object.entries(fieldMaps)) {
        merged[key] = { ...(prev?.[key] ?? {}), ...map };
      }
    }
    // setError() forced messages take HIGHEST priority: they override
    // any fallback errorMap entry for the same field.
    if (forcedFieldErrors) {
      for (const [key, message] of Object.entries(forcedFieldErrors)) {
        merged[key] = { ...(merged[key] ?? {}), default: message };
      }
    }
    overrides.message = makeVObjectHandler(merged);
  }

  const rebuilt = cloneValibotNode(
    rawObject as object,
    overrides,
  ) as AnyValibotSchema;
  if (isPiped) {
    return v.pipe(
      rebuilt as never,
      ...(((baseSchema as AnyValibotNode).pipe as unknown[]).slice(
        1,
      ) as never[]),
    ) as unknown as AnyValibotSchema;
  }
  return rebuilt;
}

export function refineVSchema<
  T extends AnyValibotSchema,
  R extends VRefinementCallbackResult<VEntriesOf<T>>,
>(
  baseSchema: T,
  refinementFn: (fields: RefinableVShape<VEntriesOf<T>>) => R,
): RebuiltVObject<T, RefinedVEntries<VEntriesOf<T>, R>>;

export function refineVSchema<
  T extends AnyValibotSchema,
  R extends VRefinementCallbackResult<VEntriesOf<T>>,
>(
  baseSchema: T,
  refinementFn: (fields: RefinableVShape<VEntriesOf<T>>) => R,
  errorMap: { [key: string]: VErrorMessage | FieldErrorMapV | undefined },
): RebuiltVObject<T, RefinedVEntries<VEntriesOf<T>, R>>;

export function refineVSchema<T extends AnyValibotSchema>(
  baseSchema: T,
  errorMap: { [K in keyof VEntriesOf<T>]?: VErrorMessage | FieldErrorMapV },
): T;

export function refineVSchema(
  baseSchema: unknown,
  second: unknown,
  third?: unknown,
): AnyValibotSchema {
  const baseCore = baseSchema as AnyValibotNode;
  if (!isValibotSchema(baseCore)) {
    throw new DrizzleValidatorsError(
      `refineVSchema expects a valibot object schema, received ${typeof baseSchema}.`,
    );
  }
  const rawObject = isValibotPipedSchema(baseCore)
    ? (baseCore.pipe as AnyValibotNode[])[0]!
    : baseCore;
  const sourceEntries = (rawObject.entries ?? {}) as Record<string, unknown>;

  const nextEntries: Record<string, AnyValibotSchema> = {
    ...(sourceEntries as Record<string, AnyValibotSchema>),
  };
  let errorMap: unknown;
  let fieldMaps: Record<string, FieldErrorMapV> | undefined;
  // setError() on a REQUIRED field must also style the missing-key (`{}`)
  // issue, which valibot emits from the OBJECT node — record the forced
  // message per field so rebuildValibotObject can merge it into the
  // object-level handler with highest priority.
  const forcedFieldErrors: Record<string, string> = {};

  if (typeof second === "function") {
    // Lazy fields proxy: each access wraps that entry's unwrapped core.
    const fields = new Proxy({} as Record<string, AnyValibotSchema>, {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        const entry = sourceEntries[prop];
        if (entry === undefined) {
          throw new DrizzleValidatorsError(
            `Unknown field "${prop}" — the schema has: ${Object.keys(sourceEntries).join(", ")}.`,
          );
        }
        const { core, wrappers } = unwrapAllV(entry);
        return wrapVFieldProxy(core, wrappers);
      },
      has(_target, prop) {
        return typeof prop === "string" && prop in sourceEntries;
      },
    });
    const result = (second as (fields: unknown) => unknown)(fields);
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new DrizzleValidatorsError(
        "refineVSchema callback must return an object mapping field names to schemas.",
      );
    }
    for (const [key, value] of Object.entries(result)) {
      if (value === undefined) continue;
      const resolved = resolveReturnedVField(value);
      nextEntries[key] = resolved.schema;
      if (resolved.forcedError !== undefined) {
        forcedFieldErrors[key] = resolved.forcedError;
      }
    }
    errorMap = third;
  } else if (second && typeof second === "object") {
    if (third !== undefined) {
      throw new DrizzleValidatorsError(
        "refineVSchema: the refinement callback must come before the error map: refineVSchema(schema, callback, errorMap).",
      );
    }
    errorMap = second;
  } else {
    throw new DrizzleValidatorsError(
      "refineVSchema expects a refinement callback function or an error map object as its second argument.",
    );
  }

  if (errorMap !== undefined) {
    if (!errorMap || typeof errorMap !== "object" || Array.isArray(errorMap)) {
      throw new DrizzleValidatorsError(
        "refineVSchema errorMap must be a plain object mapping field names to error messages.",
      );
    }
    for (const [key, entry] of Object.entries(
      errorMap as Record<string, unknown>,
    )) {
      if (entry === undefined) continue;
      const field = nextEntries[key];
      if (!field) {
        throw new DrizzleValidatorsError(
          `Cannot apply an error map to unknown field "${key}". Known fields: ${Object.keys(nextEntries).join(", ")}.`,
        );
      }
      const normalized = normalizeVEntry(entry, key);
      if (Object.keys(normalized).length === 0) continue;
      fieldMaps ??= {};
      fieldMaps[key] = { ...(fieldMaps[key] ?? {}), ...normalized };
      const { core, wrappers } = unwrapAllV(field);
      const nextCore = applyErrorMapToCoreV(core, normalized, cloneValibotNode);
      if (nextCore !== core) {
        nextEntries[key] = applyWrappersV(nextCore, wrappers);
      }
    }
  }

  // Pass fieldMaps + forcedFieldErrors into rebuildValibotObject so the
  // object-level missing-key handler is attached to the RAW object node
  // BEFORE v.pipe() wraps it (required-key issues are emitted by the
  // object's own ~run, so a handler on the outer SchemaWithPipe never
  // fires). setError() forced messages override fallback errorMap entries.
  return rebuildValibotObject(
    baseSchema,
    nextEntries,
    fieldMaps,
    forcedFieldErrors,
  );
}
