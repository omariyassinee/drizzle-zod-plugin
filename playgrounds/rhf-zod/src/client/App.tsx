import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { registerSchema, type RegisterFormValues } from "../shared/validators";

export function App() {
	const [serverResult, setServerResult] = useState<string>("");

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
					<input
						type="email"
						{...register("email")}
						style={{ width: "100%" }}
					/>
					{errors.email && <FieldError msg={errors.email.message} />}
				</label>

				<label>
					Username
					<input {...register("username")} style={{ width: "100%" }} />
					{errors.username && <FieldError msg={errors.username.message} />}
				</label>

				<label>
					Age
					<input
						type="number"
						{...register("age", { valueAsNumber: true })}
						style={{ width: "100%" }}
					/>
					{errors.age && <FieldError msg={errors.age.message} />}
				</label>

				<label>
					Password
					<input
						type="password"
						{...register("password")}
						style={{ width: "100%" }}
					/>
					{errors.password && <FieldError msg={errors.password.message} />}
				</label>

				<label>
					Confirm password
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
