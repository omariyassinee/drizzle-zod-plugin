// Cloudflare-Worker-shaped edge handler. Proves the generated valibot
// validators are isomorphic: the same validators parse in a bundle with
// zero drizzle-orm in it.
//
// Disk import (CLI-generated files) + virtual import (noBuildRegen build)
// exercise both resolution paths in one bundle.
import { selectSchema as deliverySelect } from "virtual:drizzle-validators/deliveries";

import { insertSchema as webhookInsert } from "virtual:drizzle-validators/webhooks";

import * as v from "valibot";

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "POST" && url.pathname === "/webhooks") {
			const body = (await request.json().catch(() => null)) as unknown;
			const result = v.safeParse(webhookInsert, body);
			if (!result.success) {
				return Response.json(
					{ error: "invalid_webhook", issues: v.flatten(result.issues) },
					{ status: 400 },
				);
			}
			return Response.json(
				{ ok: true, webhook: result.output },
				{ status: 201 },
			);
		}

		if (request.method === "GET" && url.pathname === "/deliveries") {
			const rows: unknown = await listDeliveries();
			const result = v.safeParse(v.array(deliverySelect), rows);
			if (!result.success) {
				return Response.json({ error: "invalid_rows" }, { status: 500 });
			}
			return Response.json({ deliveries: result.output });
		}

		return new Response("not found", { status: 404 });
	},
};

// Stand-in for a D1 binding — the shapes are what matter, not the storage.
const listDeliveries = async (): Promise<unknown[]> => [
	{
		id: 1,
		webhookId: 1,
		status: "delivered",
		attempts: 1,
		responseCode: 200,
	},
];
