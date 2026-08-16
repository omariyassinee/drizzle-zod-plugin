import { z } from "zod";

type WrapperDef = {
	type: "optional" | "nullable" | "exactOptional" | "default";
	defaultValue?: any;
};

/**
 * Extracts all outer wrapper layers (optional, nullable, exactOptional, default)
 * into an ordered stack and returns the innermost core schema.
 */
function unwrapAll(field: z.ZodTypeAny): {
	core: z.ZodTypeAny;
	wrappers: WrapperDef[];
} {
	const wrappers: WrapperDef[] = [];
	let current: any = field;

	while (current) {
		const def = current._def ?? current.def;
		if (!def) break;

		if (def.type === "optional") {
			wrappers.push({ type: "optional" });
			current = def.innerType;
		} else if (def.type === "nullable") {
			wrappers.push({ type: "nullable" });
			current = def.innerType;
		} else if (def.type === "exactOptional") {
			wrappers.push({ type: "exactOptional" });
			current = def.innerType;
		} else if (def.type === "default") {
			const defaultVal =
				typeof def.defaultValue === "function"
					? def.defaultValue()
					: def.defaultValue;
			wrappers.push({ type: "default", defaultValue: defaultVal });
			current = def.innerType;
		} else {
			break;
		}
	}

	return { core: current, wrappers };
}

/**
 * Re-applies extracted wrapper layers in reverse order (innermost to outermost).
 */
function applyWrappers(
	core: z.ZodTypeAny,
	wrappers: WrapperDef[],
): z.ZodTypeAny {
	let current: any = core;
	for (let i = wrappers.length - 1; i >= 0; i--) {
		const w = wrappers[i];
		if (!w) continue;
		if (w.type === "optional") {
			current = current.optional();
		} else if (w.type === "nullable") {
			current = current.nullable();
		} else if (w.type === "exactOptional") {
			current = current.exactOptional
				? current.exactOptional()
				: current.optional();
		} else if (w.type === "default") {
			current = current.default(w.defaultValue);
		}
	}
	return current;
}

/**
 * Recursively overrides error messages across a field definition and all nested innerType checks.
 */
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
		if (def.innerType) {
			def.innerType = setErrorOnField(def.innerType, errorMsg);
		}
	}
	return cloned;
}

export type RefinedField<T extends z.ZodTypeAny> = T & {
	/**
	 * Overrides the error message on all existing checks and validations of this field
	 * without adding duplicate validation rules.
	 */
	setError(message: string): RefinedField<T>;
	/**
	 * Alias for `setError`. Overrides the error message on existing validations of this field.
	 */
	withError(message: string): RefinedField<T>;
};

type DeepUnwrap<T extends z.ZodTypeAny> =
	T extends z.ZodOptional<infer Inner extends z.ZodTypeAny>
		? DeepUnwrap<Inner>
		: T extends z.ZodNullable<infer Inner extends z.ZodTypeAny>
			? DeepUnwrap<Inner>
			: T extends z.ZodExactOptional<infer Inner extends z.ZodTypeAny>
				? DeepUnwrap<Inner>
				: T extends z.ZodDefault<infer Inner extends z.ZodTypeAny>
					? DeepUnwrap<Inner>
					: T;

export type RefinableShape<T extends Record<string, z.ZodTypeAny>> = {
	[K in keyof T]: RefinedField<DeepUnwrap<T[K]>>;
};

export type RefinementCallbackResult<
	TShape extends Record<string, z.ZodTypeAny>,
> = {
	[K in keyof TShape]?: z.ZodTypeAny;
} & {
	[key: string]: z.ZodTypeAny | undefined;
};

/**
 * Wraps a field schema in a Proxy that automatically delegates inner type methods
 * (e.g. `.min()`, `.email()`, `.max()`) on nested wrappers (`z.optional()`, `z.nullable()`,
 * `z.default()`, `z.exactOptional()`), re-proxies results to allow method chaining,
 * and exposes `.setError()` / `.withError()` to override error messages on existing checks.
 */
function wrapFieldProxy(field: z.ZodTypeAny): any {
	const { core, wrappers } = unwrapAll(field);

	return new Proxy(field, {
		has(target, prop) {
			if (prop === "setError" || prop === "withError") return true;
			if (prop in target) return true;
			return prop in core;
		},
		get(target, prop, receiver) {
			if (prop === "setError" || prop === "withError") {
				return (msg: string) => {
					const updated = setErrorOnField(target, msg);
					return wrapFieldProxy(updated);
				};
			}

			if (prop in target) {
				const val = Reflect.get(target, prop, receiver);
				if (typeof val === "function") return val.bind(target);
			}

			if (
				typeof prop === "string" &&
				typeof (core as any)[prop] === "function"
			) {
				return (...args: any[]) => {
					const coreResult = (core as any)[prop](...args);
					const wrappedResult = applyWrappers(coreResult, wrappers);
					return wrapFieldProxy(wrappedResult);
				};
			}

			return Reflect.get(target, prop, receiver);
		},
	});
}

/**
 * Refines a base Zod object schema by applying custom field validations or custom error messages,
 * preserving untouched fields and maintaining full TypeScript type inference.
 *
 * Exposes `.setError("...")` / `.withError("...")` on fields to override existing check messages,
 * and automatically delegates methods on optional, nullable, default, or exactOptional fields.
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
	R extends RefinementCallbackResult<T["shape"]>,
>(
	baseSchema: T,
	refinementFn: (fields: RefinableShape<T["shape"]>) => R,
): z.ZodObject<
	Omit<T["shape"], keyof R> & {
		[K in keyof R]: K extends keyof T["shape"] ? T["shape"][K] : R[K];
	}
> {
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



