# drizzle-validators

Vite plugin + CLI that generate zero-overhead, virtual validation schemas (Zod, Valibot, or TypeBox) directly from Drizzle ORM tables at dev and build time.

## ⚡ What It Solves

Importing `drizzle-zod` or `drizzle-orm` in client-side code bloats JavaScript bundles and pulls server-only ORM dependencies into the browser.

`drizzle-validators` evaluates your Drizzle tables in a server process and exposes **virtual modules** containing plain, standalone validation code (`z.object(...)`, `v.object(...)`, `t.Object(...)`) for the target library. **Zero Drizzle code reaches your client bundle** — so the same validators run on the server (trusted input) and in the browser (forms, client-side checks) as one end-to-end validation layer.

## 📦 Installation

```bash
npm install -D drizzle-validators
# or
bun add -d drizzle-validators
```

## ⚙️ Quick Setup

Add the plugin to your `vite.config.ts`. The **first argument is the validator
target (required)**; the second is an optional options object:

```ts
import { defineConfig } from 'vite';
import { drizzleValidators } from 'drizzle-validators';

export default defineConfig({
  plugins: [
    drizzleValidators('zod', {
      schemaPath: './src/db/schema.ts',
      // outputPath: './validators' // optional: write files for inspection
    }),
  ],
});
```

By default (`outputPath` omitted), generated schemas are served virtually in-memory — no clutter appears in your project tree. TypeScript types are provided by a hidden `node_modules/@types/virtual-drizzle-validators` shim (auto-included by TypeScript), so nothing appears in your project tree. If you want visible schema files for inspection, simply provide `outputPath`.

## 🚀 Usage & Tree-Shaking

### 1. Root Import (Automatic Tree-Shaking)

The root virtual module acts as a barrel of static ES subpath re-exports with `/* @__PURE__ */` annotations. Unreferenced tables and unused schemas within tables are automatically tree-shaken away by Rollup, Esbuild, or Rolldown during production builds.

```ts
import { usersInsertSchema, postsSelectSchema } from 'virtual:drizzle-validators';

const newUser = usersInsertSchema.parse(formData);
```

### 2. Per-Table Sub-Module Imports

You can also import directly from per-table sub-modules for granular scoping:

```ts
import { insertSchema, selectSchema, updateSchema } from 'virtual:drizzle-validators/usersTable';

const newUser = insertSchema.parse(formData);
```

## 🛠️ Schema Refinement (`refineZSchema`)

Drizzle-generated schemas reflect raw database column constraints. When building forms, UI inputs, or API boundaries, you often need **custom error messages**, **additional validation rules**, or **type extensions** without losing type safety or untouched fields.

The `refineZSchema` helper is exported directly by your virtual modules (or from `drizzle-validators/refine` for standalone files):

```ts
import * as z from "zod";
import { insertSchema, refineZSchema } from "virtual:drizzle-validators/usersTable";

export const insertUserSchema = refineZSchema(insertSchema, (fields) => ({
  // 1. Add extra validations (e.g., min age, regex, etc.)
  age: fields.age.min(18, { error: "You must be at least 18 years old to register" }),

  // 2. Extend unions, enums, or transformations
  role: fields.role.or(z.literal("superadmin")),

  // 3. Override errors or replace a field's core validator while preserving wrappers
  email: fields.email.as(z.email({
    error: "Please provide a valid email address",
  })),

  // 4. Assign a raw schema to replace a field wholesale
  displayName: z.string().min(2),
}));
```

### Key Capabilities

- **`setError(message)` / `withError(message)`**: Overrides the error message on existing field checks without adding redundant rules.
- **Transparent Optional & Nullable Handling**: You can call methods like `.min()`, `.max()`, or `.setError()` directly on optional or nullable fields without manually unwrapping and re-wrapping `.optional()` / `.nullable()`.
- **Wrapper-preserving replacement**: Use `.as(newSchema)` to replace a field's core validator while retaining outer wrappers. Pass `{ transferChecks: false }` to omit inherited column checks.
- **Explicit wrapper controls**: `.unwrap()`, `.required()`, and `.nonnullable()` make wrapper changes visible in the refinement expression.
- **Native Zod formats**: Use `.as(z.email())`, `.as(z.url())`, or `.as(z.uuid())`; format-specific aliases and `.format()` are intentionally not part of the API.
- **Validator callback argument**: The callback receives **only** the fields proxy — the Zod namespace is intentionally *not* injected as a second argument. Materializing `z` would pull Zod's full export graph (~454 KB minified) into every consumer bundle, breaking tree-shaking. Import the named builders you need yourself (`import { email, string } from "zod"`).
- **Full TypeScript Type Safety**: Preserves the exact inferred types of all untouched fields while accurately typing modified fields.

### Valibot (`refineVSchema`)

Valibot-target virtual modules export `refineVSchema` (from `drizzle-validators/refine/valibot` for standalone files) with the same API contract — `.as()`, `.pipe()`, `.setError()`, `.required()`, `.nonnullable()`, and the declarative `errorMap`:

```ts
import * as v from "valibot";
import { insertSchema, refineVSchema } from "virtual:drizzle-validators/usersTable";

export const insertUserSchema = refineVSchema(insertSchema, (fields) => ({
  // 1. Add extra validations
  age: fields.age.pipe(v.minValue(18, "You must be at least 18")),

  // 2. Replace a field's core validator while preserving wrappers
  email: fields.email.as(v.pipe(v.string(), v.email("Please provide a valid email"))),

  // 3. Override errors
  nickname: fields.nickname.setError("Nickname is required"),

  // 4. Native v.pipe(fields.col, ...) also works
  displayName: v.pipe(fields.displayName, v.minLength(2)),
}));

// Declarative error map (2-arg form)
export const mapped = refineVSchema(insertSchema, {
  age: { min_value: "Too young" },
  email: { required: "Email is required" },
});
```

## 🎛️ Plugin Options

The plugin takes the validator target as its **first, required argument**, and
an optional options object as its second: `drizzleValidators(target, options?)`.

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `schemaPath` | `string` | *(Optional)* | Path to your server Drizzle schema file. Auto-detected from `drizzle.config.ts` if omitted. |
| `tables` | `string[]` | *Auto-detected* | Table export names to include |
| `moduleId` | `string` | `'virtual:drizzle-validators'` | Base virtual module specifier (target-agnostic). |
| `bufferAs` | `"throw" \| "keep"` | `"throw"` | Policy for Node-only `Buffer` columns: fail generation (`throw`) or emit the instance check deliberately for server-only codebases (`keep`). |
| `outputPath` | `string` | *Internal* | Path to write generated files for inspection. Omitted by default — types remain internal. |
| `splitByTable` | `boolean` | `true` | When `true`, generates individual per-table files plus a barrel `index.ts`. |
| `useCache` | `boolean` | `false` | **Dev-only.** Opt into the result caches (in-memory session cache + disk cache) for the dev session; caches never participate in builds. |
| `regenOnBuild` | `boolean` | `false` | Regenerate during production builds. Default: builds never generate — virtual modules are served from previously written generated files. |
| `emitRootDts` | `boolean` | `false` | Also emit `virtual-drizzle-validators.d.ts` into the project tree. Only needed when your tsconfig opts out of `@types` auto-inclusion (`types: []`, custom `typeRoots`) or `node_modules` is read-only. |

### Builds don't generate by default (`regenOnBuild`)

```ts
drizzleValidators("zod", { regenOnBuild: true }) // opts back into build-time generation
```

By default, `vite build` **never generates schemas**: the virtual modules are
served from previously written generated files, and the build fails with an
actionable error if none exist. Dev servers always regenerate.

```bash
dv generate && vite build   # the no-regen build flow
```

## 💻 CLI Usage (`dv`)

You can generate standalone validation schemas on demand via the CLI. Every run is a full regeneration — the CLI reads and writes no cache (the plugin owns caching).

```bash
# Using bunx or npx
bunx dv generate
npx dv generate

# Or run directly (defaults to generate)
bunx dv
```

### CLI Options

```bash
dv generate [options]

Options:
  -s, --schema <path>      Path to Drizzle schema file (auto-detects from drizzle.config.* if omitted)
  -o, --output <path>      Output directory or file path for generated schemas (default: ./validators)
  -t, --tables <names>     Comma-separated list of table names to include
  --split                  Generate separate files per table (default: true)
  --no-split               Generate all schemas in a single file
  -m, --module-id <id>     Virtual module ID (default: virtual:drizzle-validators)
      --target <name>      Validation library to emit: zod (default), valibot, or typebox
  -r, --root <path>        Project root directory (default: current working directory)
  -c, --config <path>      Explicit path to drizzle.config file
      --buffer-as <mode>   Blob buffer serialization policy: throw (default) or keep
  -v, --version            Show version
  -h, --help               Show this help message
```

### Examples

```bash
# Generate schemas into ./validators (auto-detecting schema from drizzle.config.ts)
bunx dv generate

# Generate into a custom folder
bunx dv generate --schema ./src/db/schema.ts --output ./src/validators

# Generate all schemas into a single file
bunx dv generate --no-split --output ./src/validators.ts

# Generate schemas only for specific tables
bunx dv generate --tables users,posts

# Emit Valibot or TypeBox schemas instead of Zod
bunx dv generate --target valibot
bunx dv generate --target typebox --output ./src/validators
```

## 🔄 Other Validation Libraries (Valibot / TypeBox)

Drizzle ships first-class creators for several validation libraries — this plugin
can emit plain, bundle-safe code for any of them via the required first argument
(`drizzle-orm/<target>` must exist in your drizzle-orm version, and the target
library must be installed):

| Target | First argument | Generated import line |
| :--- | :--- | :--- |
| Zod *(default)* | `drizzleValidators("zod", ...)` | `import * as z from 'zod'` |
| Valibot | `drizzleValidators("valibot", ...)` | `import * as v from 'valibot'` |
| TypeBox | `drizzleValidators("typebox", ...)` | `import * as t from 'typebox'` |

The virtual module id (`virtual:drizzle-validators`) and the ambient types file
(`virtual-drizzle-validators.d.ts`) are target-agnostic — the generated import
line inside the module is what tells you which library it is.

```ts
// vite.config.ts
drizzleValidators("valibot", { schemaPath: "./src/db/schema.ts" })

// anywhere in client or server code
import { insertSchema } from "virtual:drizzle-validators/usersTable";
```

Behavior notes:

- Generated code contains **only plain library calls** — no `drizzle-orm` import
  ever reaches your bundle, for every target.
- **`refineZSchema` is Zod-only** and **`refineVSchema` is Valibot-only** (each
  is implemented against its library's internals); `typebox` targets omit
  refinement utilities from the generated barrels and `.d.ts`.
- The emitted per-table files import the target library
  (`import * as v from 'valibot'` / `import * as t from 'typebox'`), which are
  **optional peer dependencies** — install the one you use.
- Node-only `Buffer` columns cannot reach client bundles: generation fails with
  an actionable message unless `bufferAs: "keep"` (same policy for all targets).


## 📄 License

[MIT](./LICENSE) © [Yassine Omari](https://github.com/omariyassinee)
