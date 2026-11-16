---
name: typescript-strict
description: Strict, type-safe TypeScript for a published ESM library. Use when authoring or refactoring .ts files, designing a public API surface or exported type, modelling state with unions, adding a generic, or resolving a type error. Emphasises making illegal states unrepresentable, deriving types from data rather than hand-typing them, and keeping the emitted package tree-shakeable and ATTW-clean.
license: MIT
metadata:
  typescript: ">=5.7"
---

# Strict TypeScript for a published library

The compiler settings in `tsconfig.base.json` are already strict, including
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and
`noPropertyAccessFromIndexSignature`. Assume they are on, and write code that benefits from them
rather than working around them.

## The governing principle: make illegal states unrepresentable

Prefer a type that cannot express the bad state over a runtime check that forbids it. This is
already load-bearing in this codebase, and it is the single highest-value habit here:

- `ChainState`'s `forked` variant has **no `tipId` field**, so the SF-4 violation cannot be written
  down (D43). It is not "forbidden" — it is unrepresentable.
- `RuleId` is a generated literal union, so citing a rule absent from the spec is a **compile error**
  rather than a CI check.
- `Validity`'s `not-scrutiny` variant carries no `issues`, because an out-of-scope event has none.

When you find yourself writing a comment like "callers must not read `x` when `y` is set", that is a
discriminated union trying to exist.

```ts
// Bad: two fields that must not disagree, and a comment asking nicely.
interface Result { ok: boolean; value?: T; error?: string }

// Good: the compiler enforces it.
type Result = { ok: true; value: T } | { ok: false; error: string }
```

## Discriminated unions over boolean flags

A boolean parameter that changes what a function *returns* or which fields are meaningful should be
a union. Related, from this project's decisions: prefer orthogonal booleans to an ordered enum when
the axes are genuinely independent (D27), and prefer a separate implementation to a "bypass" flag
when the two behaviours differ structurally (D22) — a bypass flag invites the bug where one code
path forgets to check it.

Exhaustiveness: `switch` on the discriminant and let the compiler prove you covered it.

```ts
function render(s: Shape): string {
  switch (s.kind) {
    case 'circle': return circle(s)
    case 'square': return square(s)
    default: {
      const _exhaustive: never = s
      return _exhaustive
    }
  }
}
```

## Derive types from data; never hand-type a list

134 hand-typed rule IDs would drift — that is the failure this repo's generator exists to prevent.
The same applies at smaller scale:

```ts
const EVENT_TYPE_TAGS = { product: 'scrutiny-product', /* … */ } as const
type ScrutinyEventType = keyof typeof EVENT_TYPE_TAGS
```

Use `as const` for literal inference, and `satisfies` to check a value against a type **without
widening it**:

```ts
const config = { retries: 3, mode: 'strict' } satisfies Config
// config.mode is 'strict', not string
```

## `unknown`, never `any`

`any` disables checking silently and infectiously. Parse untrusted input into `unknown` and narrow
with a type guard:

```ts
function isNostrEvent(v: unknown): v is NostrEvent {
  return typeof v === 'object' && v !== null && 'sig' in v
}
```

The one legitimate `any` is a deliberate escape in a test asserting runtime behaviour the types
forbid — write it as `as unknown as T` so the intent is visible in review.

## Working with `noUncheckedIndexedAccess`

Indexing an array yields `T | undefined`. This is correct — `tags[3]` on a two-element tag really is
`undefined`. Do not silence it with `!`; handle it, because malformed input from a relay is the
normal case, not the exception.

```ts
const marker = tag[3]
if (marker !== undefined && marker !== '') { /* … */ }
```

With `exactOptionalPropertyTypes`, `{ marker: undefined }` is not assignable to `{ marker?: string }`.
Spread conditionally instead of assigning `undefined`:

```ts
return { id, relay, ...(marker !== undefined ? { marker } : {}) }
```

## Library-shaped concerns

- **`import type` for type-only imports.** `verbatimModuleSyntax` makes this mandatory, and it keeps
  type imports out of the emitted JavaScript.
- **Extension-ful relative specifiers** (`./events.js`, not `./events`) — required by
  `moduleResolution: node16`, and part of D9's tree-shaking story.
- **No dynamic `import()`** anywhere in this package (D9).
- **No circular imports through the barrel.** A module that needs a shared constant imports it from
  its own small module, not from `index.ts`.
- **Every exported symbol is API.** Adding one is a commitment; removing one is a breaking change.
  Export the minimum, and keep internal modules out of the `exports` map.
- **`readonly` on exported interface fields and array parameters** (`readonly T[]`), so callers
  cannot mutate a structure you handed them.

## Verify

`pnpm typecheck` covers `src` and `test`. `pnpm build` compiles only `src`, with `"types": []` so a
stray Node global fails the build rather than shipping. `pnpm attw` checks the exports map resolves
correctly for consumers.
