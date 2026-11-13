import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { createProjectSchema } from "../shared/validators";
import {
  predictedKeysObject,
  errorsOf,
  type FieldErrorRecord,
} from "drizzle-validators/predictions";

export function App() {
  const [serverResult, setServerResult] = useState<string>("");
  const [structuredErrors, setStructuredErrors] = useState<FieldErrorRecord[]>(
    [],
  );

  const predictions = predictedKeysObject(createProjectSchema);

  const form = useForm({
    defaultValues: {
      name: "",
      slug: "",
      ownerEmail: "",
      estimatedHours: 0,
    },

    // TanStack Form natively supports Standard Schema (Zod 4 implements it),
    // so the refined schema is passed directly as a validator.
    validators: { onSubmit: createProjectSchema },
    onSubmit: async ({ value }) => {
      setServerResult("Submitting…");
      const issues = errorsOf(createProjectSchema, value);
      setStructuredErrors(issues);

      try {
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        });
        const data = (await res.json()) as { ok?: boolean; error?: unknown };
        if (res.ok) {
          setServerResult(
            `✅ Created project ${(data as { project: { name: string } }).project.name}`,
          );
        } else {
          setServerResult(`❌ Server rejected: ${JSON.stringify(data.error)}`);
        }
      } catch (e) {
        setServerResult(`❌ Network error: ${String(e)}`);
      }
    },
  });

  return (
    <main
      style={{
        maxWidth: 480,
        margin: "0 auto",
        padding: "2rem",
        fontFamily: "system-ui",
      }}
    >
      <h1>TanStack Form + Standard Schema</h1>
      <p style={{ color: "#666" }}>
        Schema: <code>refineSchema</code> from Drizzle tables + declarative
        error map. Same schema re-validated by the Hono server.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void form.handleSubmit();
        }}
        style={{ display: "grid", gap: "0.75rem" }}
      >
        <form.Field name="name">
          {(field) => (
            <label>
              Project name
              {predictions.name?.meta && (
                <FieldConstraintHint
                  hint={`Min: ${predictions.name.meta.min?.minimum ?? 2}, Max: ${predictions.name.meta.max?.maximum ?? 120}`}
                />
              )}
              <input
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                style={{ width: "100%" }}
              />
              {field.state.meta.errors.length > 0 && (
                <FieldError msg={errorMessages(field.state.meta.errors)} />
              )}
            </label>
          )}
        </form.Field>

        <form.Field name="slug">
          {(field) => (
            <label>
              Slug
              {predictions.slug?.meta && (
                <FieldConstraintHint
                  hint={`Min: ${predictions.slug.meta.min?.minimum ?? 3}, Max: ${predictions.slug.meta.max?.maximum ?? 64}`}
                />
              )}
              <input
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                style={{ width: "100%" }}
              />
              {field.state.meta.errors.length > 0 && (
                <FieldError msg={errorMessages(field.state.meta.errors)} />
              )}
            </label>
          )}
        </form.Field>

        <form.Field name="ownerEmail">
          {(field) => (
            <label>
              Owner email
              {predictions.ownerEmail?.meta && (
                <FieldConstraintHint
                  hint={`Format: ${predictions.ownerEmail.meta.email?.format ?? "email"}, Max: ${predictions.ownerEmail.meta.max?.maximum ?? 255}`}
                />
              )}
              <input
                name={field.name}
                type="email"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                style={{ width: "100%" }}
              />
              {field.state.meta.errors.length > 0 && (
                <FieldError msg={errorMessages(field.state.meta.errors)} />
              )}
            </label>
          )}
        </form.Field>

        <form.Field name="estimatedHours">
          {(field) => (
            <label>
              Estimated hours
              {predictions.estimatedHours?.meta && (
                <FieldConstraintHint
                  hint={`Min: ${predictions.estimatedHours.meta.min?.minimum ?? 1} (integer)`}
                />
              )}
              <input
                name={field.name}
                type="number"
                value={field.state.value ?? ""}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.valueAsNumber)}
                style={{ width: "100%" }}
              />
              {field.state.meta.errors.length > 0 && (
                <FieldError msg={errorMessages(field.state.meta.errors)} />
              )}
            </label>
          )}
        </form.Field>

        <form.Subscribe
          selector={(state) => [state.canSubmit, state.isSubmitting]}
        >
          {([canSubmit, isSubmitting]) => (
            <button
              type="submit"
              disabled={!canSubmit}
              style={{ padding: "0.5rem" }}
            >
              {isSubmitting ? "Submitting…" : "Create project"}
            </button>
          )}
        </form.Subscribe>
      </form>

      {structuredErrors.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <h3>Structured Extraction (errorsOf)</h3>
          <ul>
            {structuredErrors.map((rec, i) => (
              <li key={i}>
                <code>{rec.field}</code>: <strong>[{rec.kind}]</strong>{" "}
                {rec.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {serverResult && (
        <pre
          style={{
            background: "#f4f4f4",
            padding: "0.75rem",
            marginTop: "1rem",
          }}
        >
          {serverResult}
        </pre>
      )}
    </main>
  );
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <span style={{ color: "#c00", fontSize: "0.85rem" }}>{msg}</span>;
}

function FieldConstraintHint({ hint }: { hint: string }) {
  return (
    <span style={{ color: "#888", fontSize: "0.75rem", marginLeft: "0.5rem" }}>
      ({hint})
    </span>
  );
}

// TanStack Form's Standard Schema errors are issue OBJECTS ({ message, path,
// ... }), not plain strings. Extract the human-readable message so the UI
// doesn't render "[object Object]".
function errorMessages(errors: readonly unknown[]): string {
  return errors
    .map((e) =>
      typeof e === "string"
        ? e
        : ((e as { message?: unknown })?.message ?? String(e)),
    )
    .filter((m): m is string => typeof m === "string")
    .join(", ");
}
