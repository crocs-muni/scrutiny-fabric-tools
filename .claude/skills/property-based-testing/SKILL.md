---
name: property-based-testing
description: Designing and debugging property-based tests with fast-check in TypeScript. Use when writing or reviewing tests for a round-trip, a parser, a normaliser, a reducer, an incremental cache, or any code where example-based tests would only cover the cases someone thought of. Also use when a generated counterexample needs interpreting, when a property is passing suspiciously easily, or when choosing between a property test and a fixture.
license: MIT
metadata:
  framework: fast-check
---

# Property-based testing with fast-check

A property test asserts a law over *generated* input. Its value is finding the cases nobody thought
of, so a property that only restates the implementation is worse than no test — it costs runtime and
buys confidence it has not earned.

## Pick a property with a known failure mode

Do not start from "what can I assert?" Start from **"what bug am I afraid of?"** and name the
property after it. The strongest patterns, roughly in descending order of strength:

| Pattern | Shape | Catches |
|---|---|---|
| **Round-trip** | `decode(encode(x)) === x` | Parser/serialiser disagreement |
| **Oracle** | `fast(x) === reference(x)` | Incremental paths drifting from a recompute |
| **Invariant** | `P(x)` holds before and after `f` | State corruption in a reducer |
| **Idempotence** | `f(f(x)) === f(x)` | Double-apply bugs in normalisers |
| **Commutativity** | any permutation gives the same result | Order dependence |
| **Inverse** | `undo(do(x)) === x` | Decrement/cleanup asymmetry |
| **No-throw** | `f(x)` does not crash | Weakest. Use only as a floor |

The four properties this project has committed to, each named for the specific bug it targets, are
in `docs/IMPLEMENTATION-PLAN.md` under "Testing strategy". Do not invent new ones without an equally
specific rationale.

## The generator is where the bug hides

A property is only as good as its arbitrary. The default generators produce *boring* input, and
boring input is exactly what hand-written tests already cover.

**Bias generators toward the pathological case the property exists to find.** For a diff matcher,
that means content with repeated lines — the case that breaks a uniqueness rule and that
hand-written tests almost never produce:

```ts
// Small alphabet + short lines => collisions are frequent, not incidental.
const line = fc.constantFrom('a', 'b', 'c', '')
const content = fc.array(line, { minLength: 0, maxLength: 40 }).map((ls) => ls.join('\n'))
```

Checklist for any text-shaped arbitrary in this codebase:

- Empty string, and a single line with no trailing newline
- Repeated and adjacent-duplicate lines
- CRLF and mixed line endings (PB-1 forbids normalising them)
- Leading/trailing blank lines
- Non-ASCII, and astral characters (surrogate pairs)
- Content that itself contains a backtick fence

## Make failures reproducible and permanent

Two habits, both non-negotiable here.

**Seed and report.** When a run fails, fast-check prints a seed and path. Record them.

```ts
fc.assert(fc.property(content, content, (a, b) => { /* ... */ }), {
  numRuns: 10_000,
  verbose: true,
})
```

**Every counterexample becomes a permanent regression case.** Shrinking gives you a minimal input —
that input is more valuable than the property that found it, because it will still be checked when
someone later weakens the generator. Add it as a fixture, and once conformance vectors exist, as a
vector. A counterexample that lives only in a CI log is lost.

## Reading a shrunk counterexample

fast-check shrinks toward "simplest", which is not always "clearest".

- **A shrunk input of `''` or `0`** usually means an unhandled empty/boundary case, not a deep bug.
- **A counterexample that stops reproducing** on re-run means hidden state — a shared mutable
  fixture, a cache, a counter. Fix the test's isolation before chasing the logic.
- **A property that fails on the first run every time** is usually a wrong property, not a wrong
  implementation. Re-read what you asserted.
- **Shrinking that takes very long** signals an over-constrained generator, often from `fc.pre()`
  filtering out most inputs. Construct valid inputs directly instead of filtering to them.

## When a property test is the wrong tool

- **The law is "accept everything in this grammar."** A generator that emits from the grammar is the
  only honest test of a MUST-ACCEPT rule, but it tests *your reading* of the grammar. Pair it with
  fixtures for the shapes most likely to be wrongly rejected.
- **The oracle is the implementation.** If the reference and the subject share code, the property
  proves nothing.
- **The invariant is enforced by the type system.** Prefer making the illegal state unrepresentable;
  a test for something the compiler already rejects is dead weight.

## Budget

Properties are slow. Reserve high `numRuns` (10k+) for the one or two properties guarding genuinely
risky code, and keep the rest at the default. State the count explicitly rather than relying on it.

## Further reading

Trail of Bits publishes a broader, language-agnostic property-based-testing skill with reference
files on generation strategies, refactoring for testability, and failure interpretation:
<https://github.com/trailofbits/skills/tree/main/plugins/property-based-testing>
