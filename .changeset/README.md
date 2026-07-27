# Changesets

This directory holds [changesets](https://github.com/changesets/changesets) — one markdown file per
user-visible change, consumed at release time to compute version bumps and changelogs.

Packages in the `@scrutiny-fabric/*` scope are **linked** (`config.json`): a major or minor bump to
one moves them all to the same version, while patches bump independently. This is applesauce's
scheme, and D8 in [`DECISIONS-2026-07-27.md`](../docs/DECISIONS-2026-07-27.md) records why — it is
the only versioning scheme among the four surveyed Nostr libraries that has not caused a version
incident.

Add one with:

```bash
pnpm changeset
```
