# @omariyassine/drizzle-zod-plugin

Vite plugin to generate zero-overhead, virtual Zod validation schemas directly from Drizzle ORM tables at dev and build time.

## ⚡ What It Solves

Importing `drizzle-zod` or `drizzle-orm` in client-side code bloats JavaScript bundles and pulls server-only ORM dependencies into the browser.

`drizzle-zod-plugin` evaluates your Drizzle tables in a server process and exposes **virtual Zod modules** containing plain, standalone Zod definitions (`z.object(...)`). **Zero Drizzle code reaches your client bundle.**

## 📦 Installation

```bash
npm install -D @omariyassine/drizzle-zod-plugin
# or
bun add -d @omariyassine/drizzle-zod-plugin
```

## ⚙️ Quick Setup

Add the plugin to your `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import { drizzleZodVirtual } from '@omariyassine/drizzle-zod-plugin';

export default defineConfig({
  plugins: [
    drizzleZodVirtual({
      schemaPath: './src/db/schema.ts',
      // outputPath: './zod-schemas/generated.ts' // optional
    }),
  ],
});
```

By default (`outputPath` omitted), generated schemas are served virtually in-memory — no clutter appears in your project tree. TypeScript types are emitted into `virtual-drizzle-zod.d.ts` in your project root so you get full autocomplete and inference. If you want visible schema files for inspection, simply provide `outputPath`.

## 🚀 Usage & Tree-Shaking

### 1. Root Import (Automatic Tree-Shaking)

The root virtual module acts as a barrel of static ES subpath re-exports with `/* @__PURE__ */` annotations. Unreferenced tables and unused schemas within tables are automatically tree-shaken away by Rollup, Esbuild, or Rolldown during production builds.

```ts
import { usersInsertSchema, postsSelectSchema } from 'virtual:drizzle-zod';

const newUser = usersInsertSchema.parse(formData);
```

### 2. Per-Table Sub-Module Imports

You can also import directly from per-table sub-modules for granular scoping:

```ts
import { insertSchema, selectSchema, updateSchema } from 'virtual:drizzle-zod/users';

const newUser = insertSchema.parse(formData);
```

## 🎛️ Plugin Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `schemaPath` | `string` | *(Optional)* | Path to your server Drizzle schema file. Auto-detected from `drizzle.config.ts` if omitted. |
| `tables` | `string[]` | *Auto-detected* | Table export names to include |
| `moduleId` | `string` | `'virtual:drizzle-zod'` | Base virtual module specifier |
| `outputPath` | `string` | *Internal* | Path to write generated files for inspection. Omitted by default — types remain internal. |
| `splitByTable` | `boolean` | `true` | When `true`, generates individual per-table files plus a barrel `index.ts`. |
| `noCache` | `boolean` | `false` | Disable in-memory result caching. |

## 📄 License

[MIT](./LICENSE) © [Yassine Omari](https://github.com/omariyassinee)
