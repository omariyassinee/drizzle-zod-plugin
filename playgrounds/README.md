# Playgrounds

Real-world test applications for `@vacuus/drizzle-validators` — one workspace
per scenario, added as needed (e.g. forms + e2e validation, non-Vite bundlers,
framework integrations).

Each playground is its own bun workspace (`playgrounds/<name>`) linking the
package via `workspace:*`. All playgrounds target **`drizzle-orm@1.0.0-rc.5`**
(the line shipping the `drizzle-orm/<validator>` creator subpaths).

| Playground                                       | Scenario                                                                  | Package surface exercised                                                                                                                                                                                                                                    |
| :----------------------------------------------- | :------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`valibot-edge-worker`](./valibot-edge-worker)   | D1-shaped edge worker                                                     | `dv` CLI + `--tables` filter, valibot serializer, no-regen build, fail-loud paths                                                                                                                                                                            |
| [`typebox-elysia-rpc`](./typebox-elysia-rpc)     | Telemetry RPC microservice (Bun, no Vite)                                 | JSON drizzle config (`-c`), `--no-split` single file, typebox serializer (`Unsafe<Date>`/`Buffer` markers/BigInt bounds), `bufferAs: keep` + throw, TypeCompiler JIT                                                                                         |
| [`polyglot-dual-plugin`](./polyglot-dual-plugin) | Two plugin instances in one project (zod + valibot)                       | Custom `moduleId`s, `emitRootDts`, per-id cache isolation + @types shims, dynamic-import dep tracking (P2-14), stale reconciliation (P2-10), HMR no-op suppression                                                                                           |
| [`hostile-schema`](./hostile-schema)             | Failure ergonomics — deliberately broken schemas                          | Every fail-loud path names its column/cause; last-good-wins atomicity (cached serving + untouched artifacts + fresh-instance failure); no partial writes on first-ever failure                                                                               |
| [`zod-e2e-forms`](./zod-e2e-forms)               | Flagship: isomorphic clinic forms (Vite client + Hono API)                | Zero-config internal mode + drizzle.config auto-detection, hidden @types types, full refineZSchema torture (target-wins dedup, `transferChecks: false`, `.required()`, multi-stage + cross-field refine, strict policy), client bundle purity + tree-shaking |
| [`rhf-zod`](./rhf-zod)                           | **react-hook-form + zodResolver** registration form (React 19 + Hono API) | `refineZSchema` + declarative error map surfaced through `@hookform/resolvers/zod`, virtual-field (`confirmPassword`) + cross-field refine, isomorphic server re-validation, client bundle purity                                                            |
| [`tanstack-form`](./tanstack-form)               | **TanStack Form + Standard Schema** project form (React 19 + Hono API)    | `refineZSchema` + error map validated natively via Zod 4 Standard Schema (`~standard`), enum/format/domain rules, isomorphic server re-validation, client bundle purity                                                                                      |
| [`bun-api`](./bun-api)                           | **Bun-native API** (no Vite, no framework)                                | `dv` CLI generation to disk, `refineZSchema` + error map on generated validators, `Bun.serve` request validation, enum `invalid_value` + `int`/`min` error-map keys                                                                                          |

Run all: `bun run test:playgrounds` (builds the package first).
