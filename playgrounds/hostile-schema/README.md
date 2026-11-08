# Hostile Schema — failure ergonomics playground

Not a happy-path app: every test feeds the plugin a deliberately broken
schema from a real Vite-plugin context and asserts the developer-visible
contract — **failures are loud, name the offending column, and never
corrupt previously generated artifacts**.

Covered: Buffer columns (`bufferAs: "throw"`), symbol-keyed fields,
non-identifier table names, tables that aren't exported, unknown `--tables`
entries, `schema: string[]` drizzle configs, custom column types, empty
schemas, and last-good-wins atomicity (a broken schema must leave prior
generated files untouched).
