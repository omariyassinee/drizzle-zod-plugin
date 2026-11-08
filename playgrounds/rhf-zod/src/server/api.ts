// Hono API server — consumes the SAME refined schemas as the client form.
// This is the "server validation" half of the playground: the client
// validates with react-hook-form + zodResolver, the server re-validates
// with the identical schema before "persisting".
import { Hono } from "hono";
import * as z from "zod";

import { registerSchema, loginSchema } from "../shared/validators";

const app = new Hono();

// In-memory "database" for the playground.
const users = new Map<
  string,
  { id: string; email: string; username: string }
>();

app.post("/api/register", async (c) => {
  const body = await c.req.json().catch(() => null);
  const result = registerSchema.safeParse(body);
  if (!result.success) {
    return c.json({ error: z.flattenError(result.error) }, 400);
  }
  const { email, username } = result.data;
  if (users.has(email)) {
    return c.json({ error: { email: "Email is already registered" } }, 409);
  }
  const id = crypto.randomUUID();
  users.set(email, { id, email, username });
  // In a real app: hash `password` and store the hash.
  return c.json({ ok: true, user: { id, email, username } }, 201);
});

app.post("/api/login", async (c) => {
  const body = await c.req.json().catch(() => null);
  const result = loginSchema.safeParse(body);
  if (!result.success) {
    return c.json({ error: z.flattenError(result.error) }, 400);
  }
  const { email } = result.data;
  const user = users.get(email);
  if (!user) {
    return c.json({ error: { email: "No account found for this email" } }, 401);
  }
  return c.json({ ok: true, user });
});

app.get("/api/health", (c) => c.json({ ok: true }));

export { app };
