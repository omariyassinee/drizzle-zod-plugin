// Telemetry RPC validation surface — plain functions, no framework, no
// Vite in the runtime loop. TypeBox's JIT compiler (TypeCompiler.Compile)
// consumes the generated schemas directly.
import { Compile as TypeCompiler } from "typebox/compile";
import { Value } from "typebox/value";

import {
  telemetryPacketsInsertSchema,
  telemetryPacketsSelectSchema,
  telemetryPacketsUpdateSchema,
} from "./validators";

// JIT-compile once at module load — the high-throughput path.
const insertCheck = TypeCompiler(telemetryPacketsInsertSchema);
const updateCheck = TypeCompiler(telemetryPacketsUpdateSchema);
const selectCheck = TypeCompiler(telemetryPacketsSelectSchema);

export function validateIncomingPacket(raw: unknown) {
  if (!insertCheck.Check(raw)) {
    const errors = [...Value.Errors(telemetryPacketsInsertSchema, raw)].map(
      (e) => ({ path: e.instancePath, message: e.message }),
    );
    return { valid: false as const, errors };
  }
  return { valid: true as const, data: raw };
}

export function validatePartialFirmwarePatch(raw: unknown) {
  return updateCheck.Check(raw);
}

export function validateStoredRecord(raw: unknown) {
  return selectCheck.Check(raw);
}
