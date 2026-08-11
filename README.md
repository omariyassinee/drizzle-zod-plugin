# drizzle-zod-plugin

Vite plugin to generate zero-overhead, virtual Zod validation schemas directly from Drizzle ORM tables at dev and build time.

## ⚡ What It Solves

Importing `drizzle-zod` or `drizzle-orm` in client-side code bloats JavaScript bundles and pulls server-only ORM dependencies into the browser.

`drizzle-zod-plugin` evaluates your Drizzle tables in a server process and exposes **virtual Zod modules** containing plain, standalone Zod definitions (`z.object(...)`). **Zero Drizzle code reaches your client bundle.**

## 📦 Installation

```bash
npm install -D drizzle-zod-plugin
# or
bun add -d drizzle-zod-plugin
```

## ⚙️ Quick Setup

Add the plugin to your `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import { drizzleZodVirtual } from 'drizzle-zod-plugin';

export default defineConfig({
  plugins: [
    drizzleZodVirtual({
      schemaPath: './src/db/schema.ts',
      // outputPath: './zod-schemas/generated.ts' // optional
    }),
  ],
});
```

By default (`outputPath` omitted), all generated files stay **internal** — no files appear in your project tree. The virtual module is served in-memory, while TypeScript types are still emitted into `node_modules/@types/virtual-drizzle-zod/index.d.ts` so you get full autocomplete and inference. If you want visible schema files for inspection, simply provide `outputPath`.

## 🚀 Usage

### 1. Per-Table Sub-Module Imports (Recommended)

```ts
import { insertSchema, selectSchema, updateSchema } from 'virtual:drizzle-zod/users';

const newUser = insertSchema.parse(formData);
```

### 2. Root Barrel Import

```ts
import { usersInsertSchema, postsInsertSchema } from 'virtual:drizzle-zod';
```

## 🎛️ Plugin Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `schemaPath` | `string` | *(Required)* | Path to your server Drizzle schema file |
| `tables` | `string[]` | *Auto-detected* | Table export names to include |
| `moduleId` | `string` | `'virtual:drizzle-zod'` | Base virtual module specifier |
| `outputPath` | `string` | *Internal* | Path to write generated files for inspection. Omitted by default — types remain purely internal. |

## 📄 License

MIT
