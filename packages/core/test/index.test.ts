import { describe, expect, it } from 'vitest'
import { SPEC_VERSION, VERSION_TAG } from '../src/index.js'

describe('protocol version constants', () => {
  it('emits a version tag matching TAG-2 (`^scrutiny-v\\d{3}$`)', () => {
    expect(VERSION_TAG).toMatch(/^scrutiny-v\d{3}$/)
  })

  it('encodes SPEC_VERSION in the tag digits per VER-1 (MAJOR/MINOR/PATCH)', () => {
    const [major, minor, patch] = SPEC_VERSION.split('.')
    expect(VERSION_TAG).toBe(`scrutiny-v${major}${minor}${patch}`)
  })
})
