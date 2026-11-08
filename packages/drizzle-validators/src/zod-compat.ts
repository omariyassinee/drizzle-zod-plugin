import { object, strictObject, looseObject, type z } from "zod";
import { DrizzleValidatorsError } from "./errors";

export const UNWRAP_PROXY = Symbol.for("drizzle-validators.unwrap-proxy");

export type InternalZodDef = Record<string, any>;

export function getZodDef(value: unknown): InternalZodDef | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as any;
	return candidate._zod?.def ?? candidate._def ?? candidate.def;
}

export function getZodConstructor(
	value: unknown,
	context: string,
): new (
	def: InternalZodDef,
) => z.ZodType {
	const cnstrc = (value as any)?._zod?.constr;
	if (typeof cnstrc !== "function") {
		throw new DrizzleValidatorsError(
			`Cannot rebuild Zod schema during ${context}: constructor is unavailable.`,
		);
	}
	return cnstrc;
}

export function isZodSchema(value: unknown): value is z.ZodTypeAny {
	const def = getZodDef(value);
	return Boolean(def && typeof def.type === "string");
}

export function isExactOptionalSchema(value: unknown): boolean {
	const traits = (value as any)?._zod?.traits;
	return traits instanceof Set && traits.has("ZodExactOptional");
}

export function hasLazyDefaultGetter(def: InternalZodDef): boolean {
	return (
		Object.getOwnPropertyDescriptor(def, "defaultValue")?.get !== undefined
	);
}

export type ZodErrorOverride =
	| string
	| ((issue: Record<string, any>) => string | undefined);

export function cloneZodCheck(
	check: unknown,
	errorOverride?: ZodErrorOverride,
): z.ZodTypeAny {
	const checkDef = getZodDef(check);
	if (!checkDef) {
		throw new DrizzleValidatorsError(
			"Cannot clone a malformed Zod check without a definition.",
		);
	}
	const nextDef = { ...checkDef };
	if (errorOverride !== undefined) {
		nextDef.error =
			typeof errorOverride === "function" ? errorOverride : () => errorOverride;
	}
	return new (getZodConstructor(check, "check cloning"))(nextDef);
}

export function cloneSchemaWithDef<T extends z.ZodTypeAny>(
	schema: T,
	overrides: Partial<InternalZodDef>,
	context: string,
): T {
	const def = getZodDef(schema);
	if (!def) {
		throw new DrizzleValidatorsError(
			`Cannot clone schema during ${context}: definition is unavailable.`,
		);
	}

	const defaultAccessor = Object.getOwnPropertyDescriptor(def, "defaultValue");
	const nextDef: InternalZodDef = { ...def, ...overrides };
	if (defaultAccessor?.get && !("defaultValue" in overrides)) {
		Reflect.deleteProperty(nextDef, "defaultValue");
		Object.defineProperty(nextDef, "defaultValue", {
			configurable: true,
			get() {
				return def.defaultValue;
			},
		});
	}
	return new (getZodConstructor(schema, context))(nextDef) as T;
}

export function rebuildZodObject(
	baseSchema: z.ZodObject<any>,
	newShape: Record<string, z.ZodTypeAny>,
): z.ZodObject<any> {
	const baseDef = getZodDef(baseSchema);
	const catchall = baseDef?.catchall;
	const catchallDef = getZodDef(catchall);

	let rebuilt: z.ZodObject<any>;
	if (catchallDef?.type === "never") {
		rebuilt = strictObject(newShape);
	} else if (catchallDef?.type === "unknown") {
		rebuilt = looseObject(newShape);
	} else if (catchall) {
		rebuilt = object(newShape).catchall(catchall as any);
	} else {
		rebuilt = object(newShape);
	}

	for (const check of baseDef?.checks ?? []) {
		if (typeof rebuilt.check === "function") {
			rebuilt = rebuilt.check(cloneZodCheck(check) as any) as typeof rebuilt;
		}
	}

	if (typeof (baseSchema as any).description === "string") {
		rebuilt = rebuilt.describe((baseSchema as any).description);
	}
	return rebuilt;
}
