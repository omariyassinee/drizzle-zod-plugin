# drizzle-validators — monorepo

Bun workspaces monorepo with two packages:

| Workspace | Path | Description |
| :--- | :--- | :--- |
| `drizzle-validators` | [`packages/drizzle-validators`](./packages/drizzle-validators) | The published package: Vite plugin + CLI that generate virtual validation schemas (Zod, Valibot, TypeBox) from Drizzle tables. |
| Playgrounds | [`playgrounds/`](./playgrounds) | Real-world test applications, one workspace per scenario (intentionally empty for now). |

## Development

```bash
bun install              # links the workspace (demo imports the package via workspace:*)
bun test                 # run the package test suite
bun run build            # build the package dist
bun run typecheck        # typecheck all workspaces
```

See [`packages/drizzle-validators/README.md`](./packages/drizzle-validators/README.md) for package docs.
