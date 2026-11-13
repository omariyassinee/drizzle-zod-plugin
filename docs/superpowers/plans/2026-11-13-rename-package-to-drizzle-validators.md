# Rename Package to `drizzle-validators` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the published package, virtual schema adapter imports, monorepo workspace configurations, playgrounds, and tests from `@vacuus/drizzle-validators` to `drizzle-validators`.

**Architecture:** Transition the core package identity to unscoped `drizzle-validators`. Emitted virtual schemas will directly export refine utilities from `drizzle-validators/refine` and `drizzle-validators/refine/valibot`, and monorepo consumers will import from `drizzle-validators`.

**Tech Stack:** TypeScript, Bun, Vite, Drizzle ORM, Zod, Valibot, TypeBox.

**Spec:** `docs/superpowers/specs/2026-11-13-rename-package-to-drizzle-validators-design.md`

## Global Constraints
* Always run Bun with the absolute path `~/.bun/bin/bun`.
* Monorepo workspaces link via `drizzle-validators: workspace:*`.
* All existing tests in `packages/drizzle-validators/tests` must pass.
* Emitted virtual schema imports must never reference `@vacuus/drizzle-validators`.

## Review Focus
1. Emitted virtual module code containing old `@vacuus/drizzle-validators` import paths — verify Zod and Valibot adapter output strings match `drizzle-validators/refine`.
2. Cache key invalidation in `src/cache.ts` — verify `pkg.name === "drizzle-validators"`.
3. Root workspace scripts — verify `bun run test` and `bun run build` filter targets resolve cleanly.
4. Playground workspace resolution — verify all 8 playgrounds resolve `drizzle-validators: workspace:*`.
5. Lingering `@vacuus` references in active codebase — verify via `git grep "@vacuus"`.

---

### Task 1: Core Package & Virtual Adapter Codegen Updates

**Files:**
- Modify: `packages/drizzle-validators/package.json`
- Modify: `packages/drizzle-validators/src/adapters/zod.ts:60-70`
- Modify: `packages/drizzle-validators/src/adapters/valibot.ts:70-80`
- Modify: `packages/drizzle-validators/src/cache.ts:140-160`
- Modify: `packages/drizzle-validators/src/plugin.ts:1-25`
- Modify: `packages/drizzle-validators/src/refine/valibot.ts:1-20`
- Modify: `packages/drizzle-validators/tests/bug-repro/phase-2/p2-12-13-plugin.test.ts:40-60`

**Interfaces:**
- Consumes: Package identity and virtual schema templates.
- Produces: `drizzle-validators` package emitting `drizzle-validators/refine` imports.

- [ ] **Step 1: Update `packages/drizzle-validators/package.json` name**
  Change `"name": "@vacuus/drizzle-validators"` to `"name": "drizzle-validators"`.

- [ ] **Step 2: Update adapter template imports in `src/adapters/zod.ts` and `src/adapters/valibot.ts`**
  In `src/adapters/zod.ts`: replace `@vacuus/drizzle-validators/refine` with `drizzle-validators/refine`.
  In `src/adapters/valibot.ts`: replace `@vacuus/drizzle-validators/refine/valibot` with `drizzle-validators/refine/valibot`.

- [ ] **Step 3: Update `src/cache.ts` and documentation comments**
  Update package name check in `src/cache.ts` from `@vacuus/drizzle-validators` to `drizzle-validators`.
  Update comment imports in `src/plugin.ts` and `src/refine/valibot.ts`.

- [ ] **Step 4: Update test assertions in `tests/bug-repro/phase-2/p2-12-13-plugin.test.ts`**
  Update expectation from `@vacuus/drizzle-validators/refine` to `drizzle-validators/refine`.

- [ ] **Step 5: Run package tests**
  Run: `cd packages/drizzle-validators && ~/.bun/bin/bun test`
  Expected: PASS (all tests pass)

- [ ] **Step 6: Commit**
  ```bash
  git add packages/drizzle-validators
  git commit -m "refactor(core): rename package and adapter imports to drizzle-validators"
  ```

---

### Task 2: Root Monorepo Configuration & Workspace Linking

**Files:**
- Modify: `package.json:1-15`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: Renamed `packages/drizzle-validators`.
- Produces: Root monorepo scripts targeting `drizzle-validators`.

- [ ] **Step 1: Update root `package.json`**
  Change `"name"` to `"drizzle-validators-monorepo"`.
  Update filter scripts:
  - `"test": "bun run --filter='drizzle-validators' test"`
  - `"build": "bun run --filter='drizzle-validators' build"`
  - `"typecheck:pkg": "bun run --filter='drizzle-validators' typecheck"`

- [ ] **Step 2: Update lockfile via bun install**
  Run: `~/.bun/bin/bun install`
  Expected: Success, `drizzle-validators` resolved as local workspace.

- [ ] **Step 3: Verify root scripts run cleanly**
  Run: `~/.bun/bin/bun run build`
  Expected: Build succeeds.
  Run: `~/.bun/bin/bun run test`
  Expected: Tests pass.

- [ ] **Step 4: Commit**
  ```bash
  git add package.json bun.lock
  git commit -m "chore(root): update monorepo filters and workspace link for drizzle-validators"
  ```

---

### Task 3: Playgrounds Workspace Dependencies & Imports

**Files:**
- Modify: `playgrounds/bun-api/package.json`
- Modify: `playgrounds/hostile-schema/package.json`
- Modify: `playgrounds/hostile-schema/tests/hostile.test.ts`
- Modify: `playgrounds/polyglot-dual-plugin/package.json`
- Modify: `playgrounds/polyglot-dual-plugin/vite.config.ts`
- Modify: `playgrounds/polyglot-dual-plugin/tests/dual-lifecycle.test.ts`
- Modify: `playgrounds/polyglot-dual-plugin/tests/stress-matrix.test.ts`
- Modify: `playgrounds/rhf-zod/package.json`
- Modify: `playgrounds/rhf-zod/vite.config.ts`
- Modify: `playgrounds/rhf-zod/src/client/App.tsx`
- Modify: `playgrounds/tanstack-form/package.json`
- Modify: `playgrounds/tanstack-form/vite.config.ts`
- Modify: `playgrounds/tanstack-form/src/client/App.tsx`
- Modify: `playgrounds/typebox-elysia-rpc/package.json`
- Modify: `playgrounds/valibot-edge-worker/package.json`
- Modify: `playgrounds/valibot-edge-worker/vite.config.ts`
- Modify: `playgrounds/valibot-edge-worker/tests/edge-pipeline.test.ts`
- Modify: `playgrounds/zod-e2e-forms/package.json`
- Modify: `playgrounds/zod-e2e-forms/vite.config.ts`

**Interfaces:**
- Consumes: `drizzle-validators` workspace package.
- Produces: Updated playgrounds consuming `drizzle-validators`.

- [ ] **Step 1: Update package names and dependencies across all `playgrounds/*/package.json`**
  Replace `"@vacuus/drizzle-validators": "workspace:*"` with `"drizzle-validators": "workspace:*"`.
  Remove `@vacuus/` prefix from playground `"name"` fields.

- [ ] **Step 2: Update imports in playground source files and configs**
  Replace `from '@vacuus/drizzle-validators'` with `from 'drizzle-validators'`.

- [ ] **Step 3: Update imports/assertions in playground tests**
  Update test files in `hostile-schema`, `polyglot-dual-plugin`, and `valibot-edge-worker`.

- [ ] **Step 4: Re-install workspaces**
  Run: `~/.bun/bin/bun install`
  Expected: Clean install.

- [ ] **Step 5: Verify playground tests**
  Run: `~/.bun/bin/bun run --filter='playground-rhf-zod' test`
  Run: `~/.bun/bin/bun run --filter='playground-tanstack-form' test`
  Run: `~/.bun/bin/bun run --filter='playground-valibot-edge-worker' test`
  Run: `~/.bun/bin/bun run --filter='playground-zod-e2e-forms' test`
  Expected: PASS

- [ ] **Step 6: Commit**
  ```bash
  git add playgrounds bun.lock
  git commit -m "refactor(playgrounds): update dependencies and imports to drizzle-validators"
  ```

---

### Task 4: Documentation & Final Verification

**Files:**
- Modify: `README.md`
- Modify: `packages/drizzle-validators/README.md`
- Modify: `playgrounds/README.md`

**Interfaces:**
- Consumes: Entire renamed codebase.
- Produces: Updated docs, clean workspace verification.

- [ ] **Step 1: Update documentation files**
  Replace `@vacuus/drizzle-validators` with `drizzle-validators` in `README.md`, `packages/drizzle-validators/README.md`, and `playgrounds/README.md`.

- [ ] **Step 2: Check for any remaining occurrences of `@vacuus`**
  Run: `git grep "@vacuus" packages playgrounds README.md package.json`
  Expected: No results.

- [ ] **Step 3: Run full build and test suite**
  Run: `~/.bun/bin/bun run build`
  Run: `~/.bun/bin/bun run test`
  Expected: All builds and tests succeed.

- [ ] **Step 4: Commit**
  ```bash
  git add README.md packages/drizzle-validators/README.md playgrounds/README.md
  git commit -m "docs: update package name references to drizzle-validators"
  ```
