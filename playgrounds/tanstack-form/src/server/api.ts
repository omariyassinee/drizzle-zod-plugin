// Hono API server — consumes the SAME refined schemas as the TanStack Form
// client. The client validates with Standard Schema, the server re-validates
// with the identical schema before "persisting".
import { Hono } from "hono";
import * as z from "zod";
import { createProjectSchema } from "../shared/validators";

const app = new Hono();

// In-memory "database" for the playground.
const projects = new Map<string, { id: string; name: string; slug: string }>();

app.post("/api/projects", async (c) => {
	const body = await c.req.json().catch(() => null);
	const result = createProjectSchema.safeParse(body);
	if (!result.success) {
		return c.json({ error: z.flattenError(result.error) }, 400);
	}
	const { name, slug } = result.data;
	if (projects.has(slug)) {
		return c.json(
			{
				error: {
					formErrors: [],
					fieldErrors: { slug: ["Slug is already taken"] },
				},
			},
			409,
		);
	}
	const id = crypto.randomUUID();
	projects.set(slug, { id, name, slug });
	return c.json({ ok: true, project: { id, name, slug } }, 201);
});

app.get("/api/health", (c) => c.json({ ok: true }));

export { app };
