/**
 * The specification version this implementation targets.
 *
 * Kept in its own module so `validate.ts` can read it without importing the root barrel, which
 * would make the module graph cyclic.
 */
export const SPEC_VERSION = '0.8.0'

/**
 * The version `t` tag this implementation emits (TAG-2, VER-1, amended in spec v0.7.0 — F14).
 *
 * Unpadded decimal MAJOR.MINOR.PATCH fields, with no fixed width and no digit-count ceiling in any
 * field. Ordering is a per-field numeric tuple comparison (`compareVersionTags`), never
 * lexicographic — the retired three-digit form's "zero-padded, so lexicographic coincides with
 * numeric" claim does not survive an unpadded field.
 *
 * This is the version we **write**. It is never used to filter events on read, and MUST NOT appear
 * in a relay filter: doing so silently drops every higher-version event, which violates VER-4
 * invisibly. The previous implementation did exactly this, and nothing ever reported it.
 */
export const VERSION_TAG = `scrutiny-v${SPEC_VERSION}`
