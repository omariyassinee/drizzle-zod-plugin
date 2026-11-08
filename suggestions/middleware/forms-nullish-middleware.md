# Forms & Nullish Fields: Empty-String Middleware

> Status: **proposal — no code changed.** Prompted by a real-world
> react-hook-form + zodResolver bug hit by the user (2026-10-25).

## 0. The bug, precisely

The stack: generated (or refined) Zod schemas + `useForm` +
`zodResolver`. Three true facts collide:

1. **React semantics**: an input rendered with `value={undefined}` becomes
   *uncontrolled*. RHF's guidance (and its dev warning) is that controlled
   fields should carry a defined value — typically `""`.
2. **Zod semantics**: `.optional()` short-circuits on `undefined` —
   validation is *skipped entirely*, so `z.string().min(3).optional()`
   accepts `undefined` and rejects `""` (verified: `""` → fail, `undefined`
   → pass, short string → fail).
3. **Drizzle semantics**: `undefined` in an insert payload means *omit the
   column* (DB default applies); `""` inserts an empty string.

So the only value that satisfies both sides is: **form state holds `""`
(controlled, no RHF warning), validation treats `""` as absent (skip checks,
output `undefined`)**. The Zod idiom for that exists —
`z.preprocess((v) => (v === "" ? undefined : v), fieldSchema)` — but writing
it by hand for every optional field in every form is exactly the
drift-prone toil this package exists to remove.

(The user's mental model of RHF was correct enough: the warning is React's
uncontrolled-input detection, triggered by `undefined` values.)

## 1. Why a *named* coercion, not just "pass a function"

Two very different extension points exist, with different constraints:

| Level | Where it runs | Constraint |
|---|---|---|
| **Generated code** (plugin/CLI output) | Serialized to disk as source | Middleware must be **expressible as code** — arbitrary user functions are impossible here |
| **Runtime** (refineSchema, utilities) | In the consumer app | Arbitrary functions fine |

A general "middleware" therefore cannot live at generation time — only
*named* transforms (`emptyString → nullish`, later `trim`, …) can be
emitted. Arbitrary-function middleware belongs to the runtime layer
(refineSchema / a post-processing utility). The design below uses both,
each for what it can do.

## 2. Proposed API

### Phase 1 (core, low risk): runtime utility `emptyAsNullish`

```ts
import { emptyAsNullish } from "@vacuus/drizzle-validators/forms";
import { insertSchema } from "virtual:drizzle-validators/usersTable";

const formSchema = emptyAsNullish(insertSchema);
// form state: { bio: "" }  →  parse: OK, output bio: undefined
const formSchema = emptyAsNullish(insertSchema, { to: "null" }); // nullable columns
```

- Walks `schema.shape`, finds every field whose wrapper stack makes it
  absent-tolerant (`optional` / `nullable` / `exactOptional` / `default` —
  reuse `zod-compat.ts`), and rewrites it as
  `z.preprocess((v) => (v === "" ? undefined : v), field)`.
- Required fields are **untouched** — `""` must keep failing `.min(3)`
  there (that's a real error the user needs to see).
- Applies to any absent-tolerant field, not just strings: an empty number
  input is also `""` in form state; mapping it to absent is the correct
  form behavior there too.
- Rebuilds the object via the existing quarantined `rebuildZodObject` —
  strict/loose policy preserved.
- **Ordering rule**: apply AFTER `refineSchema` (refine's wrapper engine
  doesn't know a `ZodPipe` outer wrapper; wrapping last avoids the
  interaction entirely). Documented in the JSDoc.

Why first: zero codegen changes, no serialization concerns, no cache-key
changes, and the forms concern stays at the form layer where it belongs.
It fixes the user's bug in one line.

### Phase 2: per-field runtime middleware in `refineSchema`

```ts
refineSchema(insertSchema, (fields) => ({
  // general escape hatch — arbitrary functions, wraps OUTERMOST
  slug: fields.slug.preprocess((v) => (typeof v === "string" ? v.trim() : v)),

  // the named coercion, per-field (overrides any future global option)
  bio: fields.bio.emptyStringTo("undefined"),
}));
```

- `.preprocess(fn)` is the general middleware the user asked for — it
  unlocks trim, case normalization, date formatting, custom coercions:
  anything expressible as `(value) => value`.
- `.emptyStringTo("undefined" | "null")` is the named form of Phase 1,
  overridable per field.
- Both wrap the *finished* field chain (outermost), compose with `.as()`,
  `.setError`, and wrapper controls, and return the proxied field so
  chaining still works.
- Typing note to document: `z.preprocess` widens the field's *input* type
  to `unknown`. With `zodResolver` this is harmless when the RHF form type
  is declared explicitly (`useForm<MyValues>({ resolver: ... })`); it only
  bites `useForm<z.input<typeof schema>>` inference. State it in the docs,
  don't fight it in the types.

### Phase 3 (gated): generation-time option

```ts
drizzleValidators("zod", { coerce: { emptyString: "undefined" } })
```

- Only if Phase 1 proves insufficient in practice. Emits the preprocess
  wrapper into generated code (it *is* serializable — the function body is
  a fixed, known snippet), skips nothing else.
- **Must** fold the option into `computeCacheKey` — `bufferAs` taught us
  that any output-affecting option left out of the key makes differing
  configs collide in the disk cache.
- CLI mirror (`--coerce-empty-string`), README, and the generated-file
  docs all need updating; larger blast radius than Phases 1–2 combined,
  which is why it's gated.

## 3. Multi-target honesty

| Target | Preprocess story |
|---|---|
| Zod | `z.preprocess` — full support, this proposal. |
| Valibot | Possible later: `v.pipe(v.unknown(), v.transform(fn), schema)`-shaped; needs its own probe + tests. Deferred. |
| TypeBox | **No runtime preprocess exists** — it's JSON-Schema-first; `Value.Transform` is a value-module concept, not a schema one. The middleware concept does not port; at best a `Value.Clean`-style helper. Out of scope. |

The "middleware unlocks other stuff" claim is therefore Zod-first (and
plausibly Valibot later) — not a universal feature.

## 4. Explicitly deferred — NOT in this proposal

| Item | Why |
|---|---|
| Generation-time option (Phase 3) | Gated on Phase 1 usage; serialization + cache-key + CLI surface. |
| Arbitrary-function middleware at generation time | Impossible by construction — generated files are code; user functions don't serialize. |
| Valibot / TypeBox variants | Zod-first per the user's stack; Valibot spike later, TypeBox blocked (§3). |
| RHF-specific helpers (zodResolver wrappers, defaultValues generators) | Tempting, but couples the package to a form library; a README recipe covers the pattern. |
| Number/string coercion beyond `""` (e.g. `"null"`, `"NaN"` strings) | No user signal; `""` is the actual HTML empty value. |

## 5. Test plan (Phases 1–2)

1. `""` on an optional field → parses, output `undefined` (and `null` for
   `to: "null"` on nullable cores).
2. `""` on a **required** field → still fails (no silent weakening).
3. Real values still validated (`"ab"` fails `.min(3)`).
4. Composed with `refineSchema` (refine-first ordering) — wrappers,
   `.as()`, strict objects all intact.
5. `.preprocess(fn)` chaining: trims, custom transforms, outermost-wrap
   order asserted.
6. Non-string optional cores (number) get the same `""` → absent mapping.
