import { describe, expect, it } from 'vitest'
import { SPEC_VERSION, VERSION_TAG } from '../src/index.js'

describe('protocol version constants', () => {
  it('emits a version tag matching TAG-2 (`^scrutiny-v\\d+\\.\\d+\\.\\d+$`, amended v0.7.0 — F14)', () => {
    expect(VERSION_TAG).toMatch(/^scrutiny-v\d+\.\d+\.\d+$/)
  })

  it('encodes SPEC_VERSION in the tag fields per VER-1 (MAJOR.MINOR.PATCH)', () => {
    expect(VERSION_TAG).toBe(`scrutiny-v${SPEC_VERSION}`)
  })
})
