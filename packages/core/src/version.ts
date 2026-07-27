/**
 * The specification version this implementation targets.
 *
 * Kept in its own module so `validate.ts` can read it without importing the root barrel, which
 * would make the module graph cyclic.
 */
export const SPEC_VERSION = '0.6.0'

/**
 * The version `t` tag this implementation emits (TAG-2, VER-1).
 *
 * The three digits encode MAJOR/MINOR/PATCH, so lexicographic comparison of the suffix coincides
 * with semantic ordering.
 *
 * This is the version we **write**. It is never used to filter events on read, and MUST NOT appear
 * in a relay filter: doing so silently drops every higher-version event, which violates VER-4
 * invisibly. The previous implementation did exactly this, and nothing ever reported it.
 */
export const VERSION_TAG = 'scrutiny-v060'
