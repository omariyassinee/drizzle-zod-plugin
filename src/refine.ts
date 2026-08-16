import { z } from "zod";

function setErrorOnField(field: z.ZodTypeAny, errorMsg: string): z.ZodTypeAny {
	const cloned = field.clone();
	const def = (cloned as any)._def;
	if (def) {
		def.error = () => errorMsg;
		if (Array.isArray(def.checks)) {
			for (const check of def.checks) {
				const zodDef = check?._zod?.def ?? check?.def;
				if (zodDef) {
					zodDef.error = () => errorMsg;
				}
			}
		}
	}
	return cloned;
}

export type RefinedField<T extends z.ZodTypeAny> = T & {
	/**
	 * Overrides the error message on all existing checks and validations of this field
	 * without adding duplicate validation rules.
	 */
	setError(message: string): T;
	/**
	 * Alias for `setError`. Overrides the error message on existing validations of this field.
	 */
	withError(message: string): T;
};

type UnwrapZod<T extends z.ZodTypeAny> = T extends z.ZodOptional<infer Inner>
	? RefinedField<Omit<Inner, "type" | "_def"> & z.ZodOptional<Inner>>
	: T extends z.ZodNullable<infer Inner>
		? RefinedField<Omit<Inner, "type" | "_def"> & z.ZodNullable<Inner>>
		: RefinedField<T>;

export type RefinableShape<T extends Record<string, z.ZodTypeAny>> = {
	[K in keyof T]: UnwrapZod<T[K]>;
};

/**
 * Wraps a field schema in a Proxy that automatically delegates inner type methods
 * (e.g. `.min()`, `.email()`, `.max()`) on `z.optional()` and `z.nullable()` fields,
 * and exposes `.setError()` / `.withError()` to override error messages on existing checks.
 */
function wrapFieldProxy(field: z.ZodTypeAny): any {
	const def = (field as any)._def;
	if (def?.type === "optional" || def?.type === "nullable") {
		const isOptional = def.type === "optional";
		const innerType = def.innerType;
		const innerProxied = wrapFieldProxy(innerType);

		return new Proxy(field, {
			get(target, prop, receiver) {
				if (prop === "setError" || prop === "withError") {
					return (msg: string) => {
						const updatedInner = setErrorOnField(innerType, msg);
						return isOptional ? updatedInner.optional() : updatedInner.nullable();
					};
				}
				if (prop in target) {
					const val = Reflect.get(target, prop, receiver);
					if (typeof val === "function") return val.bind(target);
					return val;
				}
				if (
					typeof prop === "string" &&
					prop in innerProxied &&
					typeof innerProxied[prop] === "function"
				) {
					return (...args: any[]) => {
						const result = innerProxied[prop](...args);
						return isOptional ? result.optional() : result.nullable();
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		});
	}

	return new Proxy(field, {
		get(target, prop, receiver) {
			if (prop === "setError" || prop === "withError") {
				return (msg: string) => setErrorOnField(target, msg);
			}
			const val = Reflect.get(target, prop, receiver);
			if (typeof val === "function") return val.bind(target);
			return val;
		},
	});
}

/**
 * Refines a base Zod object schema by applying custom field validations or custom error messages,
 * preserving untouched fields and maintaining full TypeScript type inference.
 *
 * Exposes `.setError("...")` / `.withError("...")` on fields to override existing check messages,
 * and automatically delegates methods on optional or nullable fields.
 *
 * @example
 * ```ts
 * import { insertSchema as baseInsertSchema } from "virtual:drizzle-zod/users";
 * import { refineSchema } from "@omariyassine/drizzle-zod-plugin";
 *
 * export const insertSchema = refineSchema(baseInsertSchema, (fields) => ({
 *   email: fields.email.setError("You sir are noob because you don't know what emails are like"),
 *   age: fields.age.min(18, { error: "Must be 18 or older to sign up" }),
 * }));
 * ```
 */
export function refineSchema<
	T extends z.ZodObject<any>,
	R extends Record<string, z.ZodTypeAny>,
>(
	baseSchema: T,
	refinementFn: (fields: RefinableShape<T["shape"]>) => R,
): z.ZodObject<Omit<T["shape"], keyof R> & R> {
	const proxiedShape: Record<string, any> = {};
	for (const [key, field] of Object.entries(baseSchema.shape)) {
		proxiedShape[key] = wrapFieldProxy(field as z.ZodTypeAny);
	}

	const modifiedFields = refinementFn(proxiedShape as any);
	return z.object({
		...baseSchema.shape,
		...modifiedFields,
	}) as any;
}
