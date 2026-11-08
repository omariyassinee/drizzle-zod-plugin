// Consumes BOTH virtual barrels so the build exercises both plugin
// instances' resolveId/load paths simultaneously.
import { accountsInsertSchema } from "virtual:validators-zod";
import { insertSchema } from "virtual:validators-valibot/accounts";

export const bothLoaded = accountsInsertSchema !== undefined && insertSchema !== undefined;
