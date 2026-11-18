import { beforeEach, describe, expect, it } from 'vitest'
import { Journal, type RecordLine } from '../src/publish/journal.js'
import { makeRoot } from './_fixtures.js'

const PLAN_HASH = 'a'.repeat(64)
const JOURNAL = `.scrutiny/runs/${PLAN_HASH}.journal`

function record(ref: string, at: string): RecordLine {
  return { type: 'record', ref, state: 'signed', event_id: `ev-${ref}`, at }
}

describe('Journal torn tail', () => {
  let root: string

  beforeEach(() => {
    root = makeRoot()
  })

  it('keeps a record appended after a torn last line', async () => {
    root = makeRoot({ [JOURNAL]: '{"type":"record","ref":"profile:me"' })
    const journal = await Journal.open(root, PLAN_HASH)
    expect(journal.lines).toHaveLength(0)

    await journal.append(record('profile:me', '2026-11-18T10:00:00.000Z'))

    const reopened = await Journal.open(root, PLAN_HASH)
    expect(reopened.lines).toHaveLength(1)
    expect(reopened.lines[0]).toEqual(record('profile:me', '2026-11-18T10:00:00.000Z'))
  })

  it('appends cleanly to an empty root', async () => {
    const journal = await Journal.open(root, PLAN_HASH)
    await journal.append(record('profile:me', '2026-11-18T10:00:00.000Z'))

    const reopened = await Journal.open(root, PLAN_HASH)
    expect(reopened.lines).toHaveLength(1)
    expect(reopened.lines[0]).toMatchObject({ type: 'record', ref: 'profile:me', state: 'signed' })
  })

  it('separates a valid-JSON torn tail that lacks its newline', async () => {
    const torn = record('profile:me', '2026-11-18T09:00:00.000Z')
    root = makeRoot({ [JOURNAL]: JSON.stringify(torn) })

    const journal = await Journal.open(root, PLAN_HASH)
    expect(journal.lines).toHaveLength(1)

    await journal.append(record('profile:other', '2026-11-18T10:00:00.000Z'))

    const reopened = await Journal.open(root, PLAN_HASH)
    expect(reopened.lines).toHaveLength(2)
    expect(reopened.lines[0]).toEqual(torn)
    expect(reopened.lines[1]).toMatchObject({ type: 'record', ref: 'profile:other' })
  })

  it('adds the separator only to the first append after a torn tail', async () => {
    root = makeRoot({ [JOURNAL]: '{"type":"record","ref":"profile:me"' })
    const journal = await Journal.open(root, PLAN_HASH)

    await journal.append(record('profile:one', '2026-11-18T10:00:00.000Z'))
    await journal.append(record('profile:two', '2026-11-18T10:01:00.000Z'))

    const reopened = await Journal.open(root, PLAN_HASH)
    expect(reopened.lines).toHaveLength(2)
    expect(reopened.lines.map((line) => line.type === 'record' && line.ref)).toEqual([
      'profile:one',
      'profile:two',
    ])
  })
})
