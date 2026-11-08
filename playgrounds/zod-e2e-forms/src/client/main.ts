// Client form: imports ONLY per-table submodules — the root barrel (and
// every other table, e.g. auditLogs) must tree-shake out of this bundle.
import { z } from "zod";
import { appointmentFormSchema, doctorFormSchema } from "../shared/validators";

const form = document.querySelector<HTMLFormElement>("#doctor-form");
const alert = document.querySelector<HTMLDivElement>("#alert");
const errors = document.querySelector<HTMLPreElement>("#errors");

form?.addEventListener("submit", (e) => {
	e.preventDefault();
	const data = new FormData(form);
	const phone = (data.get("phone") as string)?.trim();
	const result = doctorFormSchema.safeParse({
		email: data.get("email") ?? "",
		phone: phone || undefined,
		age: Number(data.get("age")),
		licenseCode: data.get("licenseCode") ?? "",
	});

	if (alert) {
		alert.hidden = false;
	}

	if (!result.success) {
		if (alert) {
			alert.className = "alert alert-error";
			alert.textContent = "Validation failed. Please review the errors below.";
		}
		if (errors) {
			errors.hidden = false;
			errors.textContent = JSON.stringify(z.flattenError(result.error), null, 2);
		}
	} else {
		if (alert) {
			alert.className = "alert alert-success";
			alert.textContent = "Registration succeeded!";
		}
		if (errors) {
			errors.hidden = true;
			errors.textContent = "";
		}
	}
});
