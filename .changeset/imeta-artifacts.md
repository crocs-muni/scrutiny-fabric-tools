---
"@scrutiny-fabric/core": minor
---

Add `imetaArtifacts(event)`, the §3.1/§4.6 NIP-92 imeta read tier (#79): one `ArtifactRef` per
`imeta` tag carrying the declared `url` (first valid http(s) entry, verbatim), `mime`, `sha256`
(lowercased 64-hex `x`), `size` (decimal text, never `Number`ed), and `alt` (verbatim, no length
guard). Tolerant like the rest of `events.ts` — a tag with no usable `url` contributes nothing,
unknown NIP-94 keys are ignored, and dedupe/normalization stays the consumer's job (BD-11). Fetch,
verification, and display are out of scope: IM-1..IM-4 remain the consumer/artifacts-package
obligation (`IMETA_TAG` is the single named source for the tag itself). Absorbs the parser
scrutiny-lens kept app-side (#77/#78); the producer side is tracked as #81.
