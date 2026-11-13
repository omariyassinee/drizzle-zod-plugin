// Cross-target runtime parity via the GENERATED FILES on disk (bun-importable).
// The virtual-module equivalents are exercised by src/virtual-entry.ts
// through the plugin's loaders at build time.
import { insertSchema as accountsInsertValibot, refineVSchema } from "./gen/valibot/accounts";
import { accountsInsertSchema } from "./gen/zod/accounts";

import * as v from "valibot";
import * as z from "zod";

const a = refineVSchema(accountsInsertValibot, (f) => ({
  email: f.email.as(v.pipe(v.string(), v.email())),
}));

export function validateAccountDual(raw: unknown) {
  const zodResult = accountsInsertSchema.safeParse(raw);
  const valibotResult = v.safeParse(accountsInsertValibot, raw);

  return {
    zod: zodResult.success,
    valibot: valibotResult.success,
    agree: zodResult.success === valibotResult.success,
  };
}

export { z, v };
