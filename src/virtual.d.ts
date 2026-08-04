declare module "virtual:drizzle-zod" {
	const schemas: Record<string, any>;
	export default schemas;
}

declare module "virtual:drizzle-zod/*" {
	export const insertSchema: any;
	export const selectSchema: any;
	export const updateSchema: any;
}
