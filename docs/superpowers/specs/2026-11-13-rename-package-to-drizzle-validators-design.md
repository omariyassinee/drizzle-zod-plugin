# Design: Rename Package to `drizzle-validators`

## Intent and Why
The project author wishes to remove the `@vacuus` scope and transition to a clean, unscoped public package name: `drizzle-validators`. The name `drizzle-validators` has already been claimed on npm under the author's account (`omariyassine`), making it ready for full adoption across the monorepo.

## Goals, Non-Goals, and Anti-Goals
* **Goals:**
  * Rename the core library from `@vacuus/drizzle-validators` to `drizzle-validators`.
  * Update virtual schema runtime adapter imports (`export { refineZSchema } from 'drizzle-validators/refine'`, `export { refineVSchema } from 'drizzle-validators/refine/valibot'`).
  * Update cache identification (`src/cache.ts`).
  * Update monorepo root scripts, workspace dependencies across all playgrounds (`playgrounds/*`), and test suites.
  * Ensure full build, test suite (`bun test`), typechecking, and playground builds pass.
* **Non-Goals:**
  * Changing any runtime logic, APIs, or schema generation behavior.
  * Changing playground folder names or architecture.
* **Anti-Goals:**
  * Leaving lingering `@vacuus/drizzle-validators` imports or references in emitted code or runtime adapters that could cause resolution failures for consumers.

## Constraints
* Host runtime is Bun (use `~/.bun/bin/bun`).
* Monorepo workspace linking must resolve `drizzle-validators: workspace:*`.
* All existing tests in `packages/drizzle-validators/tests` must pass.

## Approaches
1. **Approach 1: Direct full rename across the codebase**
   * *Trade-off:* Fast, but would have been risky before verifying npm availability.
2. **Approach 2: Verify and claim name on npm first, then full codebase rename (Selected)**
   * *Why:* Approach 2 was chosen and executed; `drizzle-validators` was successfully published and claimed under `omariyassine` on npm. Now the codebase is ready for the complete rename.
3. **Approach 3: Switch to an alternative unscoped name**
   * *Trade-off:* Unnecessary since `drizzle-validators` is already secured.

## Detailed Changes Decided
* `packages/drizzle-validators/package.json`: `"name": "drizzle-validators"`.
* `packages/drizzle-validators/src/adapters/valibot.ts`: Export path updated from `@vacuus/drizzle-validators/refine/valibot` to `drizzle-validators/refine/valibot`.
* `packages/drizzle-validators/src/adapters/zod.ts`: Export path updated from `@vacuus/drizzle-validators/refine` to `drizzle-validators/refine`.
* `packages/drizzle-validators/src/cache.ts`: Package name check updated to `"drizzle-validators"`.
* Root `package.json`: Rename monorepo name if appropriate, update filter flags from `--filter='@vacuus/drizzle-validators'` to `--filter='drizzle-validators'`.
* Playgrounds (`playgrounds/*/package.json` and imports): Update dependencies and imports from `@vacuus/drizzle-validators` to `drizzle-validators`.
* Tests & Docs: Update test expectations and documentation references.
