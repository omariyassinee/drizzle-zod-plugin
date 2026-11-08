import { doctorFormSchema, appointmentFormSchema } from "../shared/validators";
import { Hono } from "hono";

import * as z from "zod";

const app = new Hono();

app.post("/doctors", async (c) => {
	const body = await c.req.json().catch(() => null);
	const result = doctorFormSchema.safeParse(body);
	if (!result.success)
		return c.json({ error: z.flattenError(result.error) }, 400);
	return c.json({ ok: true, doctor: result.data }, 201);
});

app.post("/appointments", async (c) => {
	const body = await c.req.json().catch(() => null);
	const result = appointmentFormSchema.safeParse(body);
	if (!result.success) {
		return c.json({ error: z.flattenError(result.error) }, 400);
	}
	return c.json({ ok: true, appointment: result.data }, 201);
});

export { app };
