import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useState } from "react";

import {
	registerSchema,
	registerFormSchema,
	type RegisterFormValues,
} from "../shared/validators";

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

	const predictions = predictedKeysObject(registerFormSchema);

	const {
		register,
		handleSubmit,
		formState: { errors, isSubmitting },
	} = useForm<RegisterFormValues>({
		resolver: zodResolver(registerSchema),
		defaultValues: {
			email: "",
			username: "",
			age: undefined,
			password: "",
			confirmPassword: "",
		},
	});

	const onSubmit = async (values: RegisterFormValues) => {
		setServerResult("Submitting…");
		const clientIssues = errorsOf(registerFormSchema, values);
		setStructuredErrors(clientIssues);

		try {
			const res = await fetch("/api/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(values),
			});
			const data = (await res.json()) as { ok?: boolean; error?: unknown };
			if (res.ok) {
				setServerResult(
					`✅ Registered ${(data as { user: { email: string } }).user.email}`,
				);
			} else {
				setServerResult(`❌ Server rejected: ${JSON.stringify(data.error)}`);
			}
		} catch (e) {
			setServerResult(`❌ Network error: ${String(e)}`);
		}
	};

	return (
		<main
			style={{
				maxWidth: 480,
				margin: "0 auto",
				padding: "2rem",
				fontFamily: "system-ui",
			}}
		>
			<h1>react-hook-form + zodResolver</h1>
			<p style={{ color: "#666" }}>
				Schema: <code>refineSchema</code> from Drizzle tables + declarative
				error map. Same schema re-validated by the Hono server.
			</p>

			<form
				onSubmit={handleSubmit(onSubmit)}
				noValidate
				style={{ display: "grid", gap: "0.75rem" }}
			>
				<label>
					Email
					{predictions.email?.meta && (
						<FieldConstraintHint
							hint={`Format: ${predictions.email.meta.email?.format ?? "email"}, Max: ${predictions.email.meta.max?.maximum ?? 255}`}
						/>
					)}
					<input
						type="email"
						{...register("email")}
						style={{ width: "100%" }}
					/>
					{errors.email && <FieldError msg={errors.email.message} />}
				</label>

				<label>
					Username
					{predictions.username?.meta && (
						<FieldConstraintHint
							hint={`Min: ${predictions.username.meta.min?.minimum ?? 3}, Max: ${predictions.username.meta.max?.maximum ?? 32}`}
						/>
					)}
					<input {...register("username")} style={{ width: "100%" }} />
					{errors.username && <FieldError msg={errors.username.message} />}
				</label>

				<label>
					Age
					{predictions.age?.meta && (
						<FieldConstraintHint
							hint={`Min: ${predictions.age.meta.min?.minimum ?? 18} (integer)`}
						/>
					)}
					<input
						type="number"
						{...register("age", { valueAsNumber: true })}
						style={{ width: "100%" }}
					/>
					{errors.age && <FieldError msg={errors.age.message} />}
				</label>

				<label>
					Password
					{predictions.password?.meta && (
						<FieldConstraintHint
							hint={`Min: ${predictions.password.meta.min?.minimum ?? 8}`}
						/>
					)}
					<input
						type="password"
						{...register("password")}
						style={{ width: "100%" }}
					/>
					{errors.password && <FieldError msg={errors.password.message} />}
				</label>

				<label>
					Confirm password
					{predictions.confirmPassword?.meta && (
						<FieldConstraintHint
							hint={`Min: ${predictions.confirmPassword.meta.min?.minimum ?? 8}`}
						/>
					)}
					<input
						type="password"
						{...register("confirmPassword")}
						style={{ width: "100%" }}
					/>
					{errors.confirmPassword && (
						<FieldError msg={errors.confirmPassword.message} />
					)}
				</label>

				<button
					type="submit"
					disabled={isSubmitting}
					style={{ padding: "0.5rem" }}
				>
					{isSubmitting ? "Submitting…" : "Register"}
				</button>
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
