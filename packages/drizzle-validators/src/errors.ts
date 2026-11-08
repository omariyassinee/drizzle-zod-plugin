/**
 * The package's own error type.
 *
 * Known failures (unserializable columns, missing peers, bad configs, …)
 * are thrown as `DrizzleValidatorsError` with an actionable message and
 * NO stack trace — there is nothing to trace in our own code, and every
 * logger (CLI, Vite, rolldown) prints a clean one-liner.
 *
 * Anything else thrown is unexpected; those keep full stacks so they can
 * be traced, and the formatter below prints them in full detail.
 */
export class DrizzleValidatorsError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "DrizzleValidatorsError";
		// Known errors are self-explanatory: strip the stack so bundler
		// output shows only the clear message.
		this.stack = undefined;
	}
}

export function isDrizzleValidatorsError(e: unknown): e is DrizzleValidatorsError {
	return e instanceof DrizzleValidatorsError;
}

const HEADER = "[drizzle-validators]";

/**
 * Formats an error for console output.
 *
 * - `DrizzleValidatorsError`: branded header + the actionable message.
 * - anything else: header + "unexpected error" + full name, message,
 *   stack, and `cause` chain — unexpected failures need to be traced.
 */
export function formatError(e: unknown): string {
	if (isDrizzleValidatorsError(e)) {
		return `${HEADER} ${e.message}`;
	}

	const lines: string[] = [`${HEADER} Unexpected error — this is a bug or an environment problem, please trace/report it:`];
	if (e instanceof Error) {
		lines.push(`${e.name}: ${e.message}`);
		if (e.stack) lines.push(e.stack);
		if (e.cause !== undefined) {
			lines.push(`caused by: ${formatError(e.cause)}`);
		}
	} else {
		lines.push(String(e));
	}
	return lines.join("\n");
}
