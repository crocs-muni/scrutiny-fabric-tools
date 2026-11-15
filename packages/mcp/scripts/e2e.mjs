#!/usr/bin/env node
/**
 * End-to-end harness of the #108 publishing loop (A5), and the 2026-11-23 dress rehearsal.
 *
 * What it proves, in the order it proves it: the server's own stdio-free wire path (`buildServer`
 * over the SDK's in-memory transport) publishes the publisher guide's §8 worked example against a
 * REAL relay binary — built from `relay/`, started on a free loopback port with a throwaway data
 * directory — and every relay-side gate the pilot cares about answers with the wording the guide
 * documents. A fake relay cannot do this job: A3's tests already pin the client against a scripted
 * one, so the remaining risk is the contract between this client and khatru's actual NIP-42/NIP-20
 * behaviour, and only the real binary exercises it.
 *
 * Two modes, one script, because a rehearsal that runs a different path than production rehearses
 * nothing:
 *
 * - LOCAL (default): `go build ./cmd/relay` into a temp dir, start it with
 *   `SCRUTINY_ALLOWED_PUBKEYS` = the fixture keys, publish, then remove the binary and the data
 *   directory in `finally`.
 * - REMOTE (`SCRUTINY_RELAY_URL` set): target that relay instead and require `SCRUTINY_SIGNER_URI`
 *   (a NIP-46 bunker) — the pilot custody path. Nothing is built or deleted.
 *
 * Node runs this file with its TypeScript type stripping (`--experimental-strip-types`, the
 * package's `e2e` script), so the server sources are imported as they are, not from a build.
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = dirname(HERE)
const REPO_ROOT = dirname(dirname(PACKAGE_DIR))
const CORE_PACKAGE = '@scrutiny-fabric/core'
const CORE_SRC_URL = pathToFileURL(`${join(REPO_ROOT, 'packages', 'core', 'src')}/`)

/**
 * Resolve `@scrutiny-fabric/core` to its source.
 *
 * WHY: core's package `exports` point at `dist`, which a fresh checkout has not built — the same
 * landmine `tsconfig.json` `paths` and `vitest.config.ts` aliases already route around for tsc and
 * the test runner. Two rewrites are needed, not one: the bare specifier, and core's own internal
 * `./x.js` specifiers (what tsc emits), which Node does not map back to the `.ts` on disk.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === CORE_PACKAGE || specifier.startsWith(`${CORE_PACKAGE}/`)) {
      const sub = specifier === CORE_PACKAGE ? 'index.js' : specifier.slice(CORE_PACKAGE.length + 1)
      const candidate = new URL(sub.replace(/\.js$/u, '.ts'), CORE_SRC_URL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    if (
      specifier.startsWith('.') &&
      specifier.endsWith('.js') &&
      context.parentURL?.startsWith(CORE_SRC_URL.href)
    ) {
      const candidate = new URL(specifier.replace(/\.js$/u, '.ts'), context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

// Imported after the hook: a static import would be resolved before this file's body runs.
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { loadConfig } = await import('../src/config.ts')
const { createDevKeySigner } = await import('../src/identity/sign.ts')
const { createWebSocketTransport } = await import('../src/identity/wsTransport.ts')
const { RelayClient } = await import('../src/relay/client.ts')
const { buildServer } = await import('../src/tools/register.ts')

/**
 * Fixture keys. Deterministic, and every one is a valid secp256k1 scalar, so the run fails on a
 * contract change rather than on a flaky key. `MAIN` is the publisher, `AUTH` exists only to be a
 * second allowlisted identity for the author-mismatch case, and `STRANGER` is deliberately absent
 * from the allowlist.
 */
const KEY_MAIN = '01'.repeat(32)
const KEY_AUTH = '02'.repeat(32)
const KEY_STRANGER = '04'.repeat(32)

/** The relay's NIP-42 `relay` tag is compared byte for byte, so the URL is built once and reused. */
const LOCAL_HOST = '127.0.0.1'

class Mismatch extends Error {}

/** Every session and relay client opened, so `finally` can close what the run left behind. */
const sessions = []
const clients = []

/**
 * Set only while a local relay and its temp dir exist. A rehearsal is a long, watchable run, and
 * Ctrl-C is the normal way it ends early — without these refs an interrupt would orphan a relay
 * process holding a boltdb lock and a temp binary.
 */
let activeRelay
let activeTmpDir

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    activeRelay?.kill()
    if (activeTmpDir !== undefined) {
      try {
        rmSync(activeTmpDir, { recursive: true, force: true })
      } catch {
        // The relay may still hold the store open; the exit below releases it.
      }
    }
    console.error(`e2e: interrupted (${signal})`)
    process.exit(130)
  })
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

const rows = []
let rejectionFailures = 0

function printTable() {
  const header = ['step', 'id', 'accepted', 'verified']
  const body = rows.map((row) => [row.step, row.id, row.accepted, row.verified])
  const widths = header.map((title, column) =>
    Math.max(title.length, ...body.map((line) => line[column].length)),
  )
  const line = (cells) =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column])))
      .join('  ')
  console.log(`\n${line(header)}`)
  console.log(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const cells of body) console.log(line(cells))
  console.log('')
}

function record(step, id, accepted, verified) {
  rows.push({
    step,
    id: id ?? '-',
    accepted: accepted === undefined ? '-' : accepted ? 'yes' : 'no',
    verified: verified === undefined ? '-' : verified ? 'yes' : 'no',
  })
}

/**
 * One gate case. It never aborts the run: the rehearsal's job is to report every gate at once, so
 * a single regression does not hide the other three. `detail` is what the relay or the server
 * actually said, printed verbatim so a failure needs no re-run to diagnose.
 */
function report(name, passed, detail) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}: ${detail}`)
  if (!passed) rejectionFailures += 1
}

function requireThat(condition, message) {
  if (!condition) throw new Mismatch(message)
}

// ---------------------------------------------------------------------------
// the guide's worked example — parsed, not copied, so documentation drift fails here too
// ---------------------------------------------------------------------------

/** The first fenced block after `marker`, without the fences (the parser `guide.test.ts` uses). */
function fencedBlockAfter(marker) {
  const guide = readFileSync(join(PACKAGE_DIR, 'docs', 'publisher-guide.md'), 'utf8')
  const at = guide.indexOf(marker)
  requireThat(at >= 0, `docs/publisher-guide.md: marker not found: ${marker}`)
  const open = guide.indexOf('```', at)
  const infoEnd = guide.indexOf('\n', open)
  const close = guide.indexOf('\n```', infoEnd)
  requireThat(
    open >= 0 && infoEnd >= 0 && close >= 0,
    `publisher guide: no fenced block after ${marker}`,
  )
  return guide.slice(infoEnd + 1, close)
}

const GUIDE_REQUEST = JSON.parse(
  fencedBlockAfter('Map the facts to a Product and one `publish_product` call:'),
)
const GUIDE_COMPOSED = fencedBlockAfter('Composed output — byte-for-byte')
const GUIDE_TAGS = JSON.parse(fencedBlockAfter('The tags the server emits around this'))

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile)

async function hasGo() {
  try {
    await execFileAsync('go', ['version'], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** A port the OS just handed out; the relay re-binds it, and the test owns the window. */
async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, LOCAL_HOST, () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/**
 * The relay logs to stderr; keep the tail so a startup failure names its cause. The binary is
 * started with `SCRUTINY_ALLOWED_PUBKEYS` limited to the fixture keys, so an accidental publish
 * from anything else is a gate case, not a data incident.
 */
async function startRelay({ binary, dataDir, port, allowedPubkeys }) {
  const relayUrl = `ws://${LOCAL_HOST}:${port}`
  const relay = spawn(binary, [], {
    env: {
      ...process.env,
      SCRUTINY_LISTEN_ADDR: `${LOCAL_HOST}:${port}`,
      // Byte-identical to what the client writes into its AUTH event's `relay` tag.
      SCRUTINY_SERVICE_URL: relayUrl,
      SCRUTINY_ALLOWED_PUBKEYS: allowedPubkeys.join(','),
      SCRUTINY_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const log = []
  const keep = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/u)) {
      if (line !== '') log.push(line)
    }
    // A relay that writes for an hour must not grow this process.
    if (log.length > 200) log.splice(0, log.length - 200)
  }
  relay.stdout.on('data', keep)
  relay.stderr.on('data', keep)
  // A spawn failure (missing binary, no execute permission) is a diagnostic, not a crash: the
  // health poll below reports it with the log tail like any other startup failure.
  relay.on('error', (cause) => log.push(`spawn failed: ${cause.message}`))

  try {
    const deadline = Date.now() + 30_000
    let lastError
    while (Date.now() < deadline) {
      if (relay.exitCode !== null) {
        throw new Mismatch(
          `the relay exited with code ${relay.exitCode} before answering /healthz:\n${log.join('\n')}`,
        )
      }
      try {
        const response = await fetch(`http://${LOCAL_HOST}:${port}/healthz`)
        const body = (await response.text()).trim()
        if (response.ok && body === 'ok') return { relay, relayUrl, log }
        lastError = `/healthz answered ${response.status} ${body}`
      } catch (cause) {
        lastError = cause instanceof Error ? cause.message : String(cause)
      }
      await sleep(100)
    }
    throw new Mismatch(`the relay did not become healthy in 30 s (${lastError})\n${log.join('\n')}`)
  } catch (cause) {
    // The caller only receives a child on success, so a half-started relay (and the file lock it
    // holds) has to be reaped here or it outlives the run.
    await stopRelay(relay)
    throw cause
  }
}

/**
 * Stop the relay and wait for the OS to confirm it.
 *
 * `kill()` alone is not enough on Windows: the file lock on `base.bolt` survives until the process
 * object exits, and deleting the data directory first fails with EPERM/EBUSY. Hence the wait, and
 * the SIGKILL fallback for a wedged process.
 */
async function stopRelay(child) {
  if (child === undefined || child.exitCode !== null) return
  child.kill()
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    sleep(5_000).then(() => false),
  ])
  if (!exited) {
    child.kill('SIGKILL')
    await sleep(500)
  }
}

/** Windows releases handles a moment after exit; retry instead of failing the last step. */
async function removeDir(dir) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      await sleep(100)
    }
  }
  return false
}

/** The relay's operator counters. `/metrics` is loopback-only, which a local run satisfies. */
async function readMetrics(baseUrl) {
  const response = await fetch(`${baseUrl}/metrics`)
  requireThat(response.ok, `/metrics answered ${response.status}`)
  return await response.json()
}

// ---------------------------------------------------------------------------
// MCP session over the SDK's in-memory transport (server minus stdio)
// ---------------------------------------------------------------------------

async function openSession(deps) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const server = buildServer(deps)
  const client = new Client({ name: 'scrutiny-fabric-e2e', version: '0.0.0' }, { capabilities: {} })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])

  const session = {
    async call(name, args) {
      const reply = await client.callTool({ name, arguments: args })
      // Every tool here answers with content; the SDK's other member is a task result, which
      // would mean the transport negotiated something this server never advertises.
      const block = reply.content?.[0]
      requireThat(
        block !== undefined && block.type === 'text',
        `${name}: expected a text content block, got ${JSON.stringify(reply.content)}`,
      )
      const text = block.text
      let value
      try {
        value = JSON.parse(text)
      } catch {
        value = undefined
      }
      return { text, isError: reply.isError === true, value }
    },
    async close() {
      await client.close()
      await server.close()
    },
  }
  sessions.push(session)
  return session
}

/** The JSON body a publishing tool returns; anything else is a contract break, not a verdict. */
function verdictOf(step, result) {
  requireThat(
    result.value !== undefined,
    `${step}: the tool did not answer with JSON: ${result.text.slice(0, 200)}`,
  )
  return result.value
}

function sameTagRows(actual, expected) {
  if (actual.length !== expected.length) return false
  return actual.every(
    (row, index) =>
      row.length === expected[index].length &&
      row.every((value, part) => value === expected[index][part]),
  )
}

// ---------------------------------------------------------------------------
// the publish loop
// ---------------------------------------------------------------------------

const RETRACT_REASON =
  'e2e harness: Acme Secure SE-1 is fabricated test data, so the record is retracted after the run'

async function runLoop({ relayUrl, mode, transport }) {
  const env = mode === 'remote' ? process.env : { SCRUTINY_RELAY_URL: relayUrl, NSEC: KEY_MAIN }
  const config = loadConfig(env)
  const session = await openSession({
    config,
    ...(transport === undefined ? {} : { transport }),
  })

  // 1. status — the first call a host makes: which relay, which signer, is a socket up.
  const status = await session.call('status', {})
  requireThat(!status.isError, `status: ${status.text}`)
  requireThat(status.text.includes(`relay: ${config.relayUrl}`), `status: ${status.text}`)
  requireThat(/signer: (dev-key|nip46)/u.test(status.text), `status: ${status.text}`)
  requireThat(status.text.includes('connected: no'), `status: ${status.text}`)
  record('status', '-', undefined, undefined)
  console.log(`status: ${status.text.replace(/\n/gu, ' | ')}`)

  // 2. set_profile — kind 0, the publisher chip Lens renders next to every event.
  const profile = verdictOf(
    'set_profile',
    await session.call('set_profile', {
      name: 'acme-secure-e2e',
      display_name: 'Acme Secure (e2e fixture)',
      about: 'Fictional vendor used by the #108 end-to-end harness; safe to ignore.',
    }),
  )
  requireThat(profile.accepted === true, `set_profile: ${JSON.stringify(profile)}`)
  requireThat(profile.verified === true, `set_profile: ${JSON.stringify(profile)}`)
  record('set_profile', profile.id, profile.accepted, profile.verified)

  // 3. publish_product — the guide §8 inputs, verbatim.
  const product = verdictOf('publish_product', await session.call('publish_product', GUIDE_REQUEST))
  requireThat(product.accepted === true, `publish_product: ${JSON.stringify(product)}`)
  requireThat(product.verified === true, `publish_product: ${JSON.stringify(product)}`)
  record('publish_product', product.id, product.accepted, product.verified)

  // 4. publish_metadata — the datasheet as its own citable record under the product.
  const metadata = verdictOf(
    'publish_metadata',
    await session.call('publish_metadata', {
      headline: 'Acme Secure SE-1 datasheet v1.2 — document ODD_AS-SE1_datasheet_vA_12',
      bullets: [
        'Part number AS-SE1-C2P-T301; the datasheet covers the CC certificate and the shipped firmware.',
      ],
      links: [{ url: 'https://www.acme-secure.example/datasheets/AS-SE1-datasheet-v1.2.pdf' }],
      indexers: ['part:AS-SE1-C2P-T301', 'doc:ODD_AS-SE1_datasheet_vA_12'],
      meta_subtype: 'report',
    }),
  )
  requireThat(metadata.accepted === true, `publish_metadata: ${JSON.stringify(metadata)}`)
  requireThat(metadata.verified === true, `publish_metadata: ${JSON.stringify(metadata)}`)
  record('publish_metadata', metadata.id, metadata.accepted, metadata.verified)

  // 5. publish_binding — the graph edge; a record with no binding is an orphan in Lens (§9).
  const binding = verdictOf(
    'publish_binding',
    await session.call('publish_binding', {
      root_ref: { id: product.id },
      link_ref: { id: metadata.id },
      label: 'documents',
    }),
  )
  requireThat(binding.accepted === true, `publish_binding: ${JSON.stringify(binding)}`)
  requireThat(binding.verified === true, `publish_binding: ${JSON.stringify(binding)}`)
  record('publish_binding', binding.id, binding.accepted, binding.verified)

  // 6. publish_patch — a prose correction to the product's resolved tip. `before` must be the
  //    content the target resolves to, which for a fresh Product is the §8 composed block.
  const corrected = GUIDE_COMPOSED.replace('4 mm × 4 mm QFN32', '5 mm × 5 mm QFN32')
  requireThat(
    corrected !== GUIDE_COMPOSED,
    'publish_patch: the §8 composed block no longer contains the package-size sentence',
  )
  const patch = verdictOf(
    'publish_patch',
    await session.call('publish_patch', {
      target_id: product.id,
      before: GUIDE_COMPOSED,
      after: corrected,
    }),
  )
  requireThat(patch.accepted === true, `publish_patch: ${JSON.stringify(patch)}`)
  requireThat(patch.verified === true, `publish_patch: ${JSON.stringify(patch)}`)
  record('publish_patch', patch.id, patch.accepted, patch.verified)

  // 7. verify_event — the stored event is the proof, and it must be the documented bytes.
  const verified = verdictOf(
    'verify_event',
    await session.call('verify_event', { event_id: product.id }),
  )
  requireThat(verified.found === true, `verify_event: ${JSON.stringify(verified).slice(0, 300)}`)
  requireThat(
    verified.id_matches === true,
    'verify_event: the stored event does not hash to its id',
  )
  requireThat(
    verified.signature_valid === true,
    'verify_event: the stored signature does not verify',
  )
  requireThat(
    verified.event.content === GUIDE_COMPOSED,
    'verify_event: the stored content differs from the publisher guide §8 composed block',
  )
  requireThat(
    sameTagRows(verified.event.tags, GUIDE_TAGS),
    `verify_event: the stored tags differ from the guide §8 tag block\nstored:   ${JSON.stringify(verified.event.tags)}\ndocumented: ${JSON.stringify(GUIDE_TAGS)}`,
  )
  record('verify_event(product)', verified.event.id, undefined, true)

  // 8. retract — kind 5 over the product. The relay stores it and never acts on it (DEL-11), which
  //    is exactly what the talk demo needs: a record that stays fetchable and renders retracted.
  const retraction = verdictOf(
    'retract',
    await session.call('retract', { target_id: product.id, reason: RETRACT_REASON }),
  )
  requireThat(retraction.accepted === true, `retract: ${JSON.stringify(retraction)}`)
  requireThat(retraction.verified === true, `retract: ${JSON.stringify(retraction)}`)
  record('retract', retraction.id, retraction.accepted, retraction.verified)

  // The retraction must be readable back too: a kind 5 the relay stored is what cures a fork.
  const retractionStored = verdictOf(
    'verify_event(retraction)',
    await session.call('verify_event', { event_id: retraction.id }),
  )
  requireThat(
    retractionStored.found === true &&
      retractionStored.id_matches === true &&
      retractionStored.signature_valid === true,
    `verify_event(retraction): ${JSON.stringify(retractionStored).slice(0, 300)}`,
  )
  record('verify_event(retraction)', retraction.id, undefined, true)

  // The retracted product must still be fetchable: DEL-11 is "correction of record, not erasure".
  const afterRetraction = verdictOf(
    'verify_event(retracted)',
    await session.call('verify_event', { event_id: product.id }),
  )
  requireThat(
    afterRetraction.found === true,
    'the product disappeared from the relay after its retraction; DEL-11 requires it to stay fetchable',
  )

  return { session, product }
}

// ---------------------------------------------------------------------------
// gate rejections — each prints PASS/FAIL and never aborts the run
// ---------------------------------------------------------------------------

/** The preflight refusal text, asserted field by field so a reworded finding fails here. */
const OVERSIZE_PATTERN =
  /^publish_product refused — nothing was signed\.\n\ncontent: the signed event would be about \d+ bytes; RL-1's recommended maximum is 65536 \(§5\.4; 285 bytes of it are the signer's id\/pubkey\/sig envelope\)\n {2}fix: /u

/**
 * The signer's relay-window guard, which is preflight gate 4 (`assertCreatedAtWithinRelayWindow`)
 * invoked again on the template that reaches the signer — the last barrier before a socket. The
 * offset is measured against the real clock, so the digit group is the only part that may drift
 * between the stamp and the check.
 */
const FUTURE_CLOCK_PATTERN =
  /^publish_product \(signing\) failed — created_at is (\d+) s ahead of this machine's clock; the relay accepts at most 900 s into the future \(maxFutureAge, relay\/internal\/relay\/relay\.go\) — check this machine’s clock$/u

async function runRejections({ relayUrl, mode, transport, baseUrl, metricsAvailable }) {
  const localEnv = { SCRUTINY_RELAY_URL: relayUrl }

  // (a) a key that authenticates but is not on the allowlist: NIP-42 proves who you are, the
  //     allowlist decides whether you may write. A throwaway dev key makes this runnable against
  //     production too — it publishes nothing, because the relay refuses the write.
  {
    const session = await openSession({
      config: loadConfig({ ...localEnv, NSEC: KEY_STRANGER }),
      ...(transport === undefined ? {} : { transport }),
    })
    const before = metricsAvailable ? await readMetrics(baseUrl) : undefined
    const result = verdictOf(
      'not-allowlisted',
      await session.call('publish_product', {
        headline: 'e2e gate probe — this key is not on the relay allowlist',
        indexers: ['vendor:acme-secure'],
      }),
    )
    const passed =
      result.accepted === false &&
      result.relay_message === 'blocked: not an allowed publisher' &&
      result.verified === false
    report(
      'not-an-allowed-publisher',
      passed,
      `relay_message=${JSON.stringify(result.relay_message)} verified=${result.verified}`,
    )
    if (metricsAvailable) {
      const after = await readMetrics(baseUrl)
      const rejected = after.events_rejected - before.events_rejected
      const stored = after.events_stored - before.events_stored
      // At least one: the blocked write itself. A second is the documented auth dance — a first
      // EVENT can race the eager challenge and earn "auth-required", which is not a gate verdict.
      report(
        'not-an-allowed-publisher/reached-relay',
        rejected >= 1 && stored === 0,
        `events_rejected +${rejected} (want >= 1), events_stored +${stored} (want 0)`,
      )
    } else {
      console.log(
        'SKIP  not-an-allowed-publisher/reached-relay: the remote relay has no operator endpoint',
      )
    }
  }

  // (b) preflight refuses an oversized payload BEFORE signing. Asserting the wording is half the
  //     check; the other half is that no EVENT frame reached the relay at all — a refusal that
  //     still signed and sent would burn a bunker approval (and here, a wasted write).
  {
    const session = await openSession({
      config: loadConfig({ ...localEnv, NSEC: KEY_MAIN }),
      ...(transport === undefined ? {} : { transport }),
    })
    const before = metricsAvailable ? await readMetrics(baseUrl) : undefined
    const result = await session.call('publish_product', {
      // RL-1's ceiling is 64 KiB of signed event; 70 KiB of headline cannot fit, and the schema
      // sets no maximum of its own — the gate is what must catch it.
      headline: 'x'.repeat(70 * 1024),
      indexers: ['vendor:acme-secure'],
    })
    const passed = result.isError === true && OVERSIZE_PATTERN.test(result.text)
    report(
      'oversized-payload-refused',
      passed,
      passed ? 'refused before signing, content named' : JSON.stringify(result.text.slice(0, 320)),
    )
    if (metricsAvailable) {
      const after = await readMetrics(baseUrl)
      const stored = after.events_stored - before.events_stored
      const rejected = after.events_rejected - before.events_rejected
      report(
        'oversized-payload/no-event-frame',
        stored === 0 && rejected === 0,
        `events_stored +${stored}, events_rejected +${rejected} (want +0/+0)`,
      )
    } else {
      console.log(
        'SKIP  oversized-payload/no-event-frame: the remote relay has no operator endpoint',
      )
    }
  }

  // (c) a publishing machine whose clock is 20 minutes fast. The stamp and the preflight share one
  //     clock seam, so the skew is expressed where it bites: the template stamped from the skewed
  //     clock, checked against the real one inside the signer, before any signature exists.
  {
    const session = await openSession({
      config: loadConfig({ ...localEnv, NSEC: KEY_MAIN }),
      now: () => Math.floor(Date.now() / 1000) + 20 * 60,
      ...(transport === undefined ? {} : { transport }),
    })
    const before = metricsAvailable ? await readMetrics(baseUrl) : undefined
    const result = await session.call('publish_product', {
      headline: 'e2e gate probe — the clock of this machine is 20 minutes fast',
      indexers: ['vendor:acme-secure'],
    })
    const match = FUTURE_CLOCK_PATTERN.exec(result.text)
    const offset = match === null ? Number.NaN : Number(match[1])
    const passed = result.isError === true && match !== null && offset >= 1_199 && offset <= 1_200
    report(
      'future-clock-refused',
      passed,
      passed
        ? `refused before signing, measured offset ${offset} s`
        : JSON.stringify(result.text.slice(0, 320)),
    )
    if (metricsAvailable) {
      const after = await readMetrics(baseUrl)
      const delta =
        after.events_stored +
        after.events_rejected -
        (before.events_stored + before.events_rejected)
      report('future-clock/no-event-frame', delta === 0, `relay write counters moved by ${delta}`)
    } else {
      console.log('SKIP  future-clock/no-event-frame: the remote relay has no operator endpoint')
    }
  }

  // (d) an event authored by key A but published on a connection authenticated as key B. The
  //     server's own signer cannot produce this (it authenticates as the key it signs with), so the
  //     case drives A3's raw client with a pre-signed event and a different AUTH signer.
  if (mode === 'remote') {
    console.log(
      'SKIP  author-mismatch: needs two allowlisted keys, which only a relay you control can offer',
    )
  } else {
    const author = createDevKeySigner(Buffer.from(KEY_MAIN, 'hex'))
    const authenticator = createDevKeySigner(Buffer.from(KEY_AUTH, 'hex'))
    const event = author.sign({
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify({ name: 'e2e author-mismatch probe' }),
    })
    const client = new RelayClient({
      relayUrl,
      signer: { sign: async (template) => authenticator.sign(template) },
      reconnectAttempts: 0,
    })
    clients.push(client)
    const before = metricsAvailable ? await readMetrics(baseUrl) : undefined
    let message
    try {
      const verdict = await client.publish(event)
      message = verdict.message
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause)
    }
    report(
      'author-mismatch',
      message === 'blocked: event author must be the authenticated pubkey',
      JSON.stringify(message),
    )
    if (metricsAvailable) {
      const after = await readMetrics(baseUrl)
      const rejected = after.events_rejected - before.events_rejected
      const stored = after.events_stored - before.events_stored
      // Same shape as the allowlist case: the blocked write plus, possibly, one auth-required
      // round trip when the first EVENT races the eager NIP-42 challenge.
      report(
        'author-mismatch/reached-relay',
        rejected >= 1 && stored === 0,
        `events_rejected +${rejected} (want >= 1), events_stored +${stored} (want 0)`,
      )
    } else {
      console.log('SKIP  author-mismatch/reached-relay: the remote relay has no operator endpoint')
    }
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

async function main() {
  const remoteUrl = process.env.SCRUTINY_RELAY_URL?.trim()
  const mode = remoteUrl === undefined || remoteUrl === '' ? 'local' : 'remote'

  if (mode === 'remote' && (process.env.SCRUTINY_SIGNER_URI?.trim() ?? '') === '') {
    console.error(
      'e2e: SCRUTINY_RELAY_URL is set, so this is a rehearsal against that relay — it requires ' +
        'SCRUTINY_SIGNER_URI (bunker://…). A dev NSEC must never be pointed at production.',
    )
    return 2
  }

  if (mode === 'local' && !(await hasGo())) {
    console.log(
      'SKIPPED: go not found — the end-to-end harness needs the relay binary (install Go, or set SCRUTINY_RELAY_URL for a remote run)',
    )
    return 0
  }

  let tmpDir
  let relay
  let relayUrl
  let baseUrl
  let metricsAvailable = false

  try {
    if (mode === 'local') {
      tmpDir = join(tmpdir(), `scrutiny-mcp-e2e-${process.pid}-${Date.now()}`)
      activeTmpDir = tmpDir
      mkdirSync(join(tmpDir, 'data'), { recursive: true })
      const binary = join(tmpDir, process.platform === 'win32' ? 'relay.exe' : 'relay')
      console.log(`e2e: building the relay binary into ${tmpDir}`)
      await execFileAsync('go', ['build', '-o', binary, './cmd/relay'], {
        cwd: join(REPO_ROOT, 'relay'),
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      })

      const port = await freePort()
      relayUrl = `ws://${LOCAL_HOST}:${port}`
      baseUrl = `http://${LOCAL_HOST}:${port}`
      const allowedPubkeys = [KEY_MAIN, KEY_AUTH].map(
        (key) => createDevKeySigner(Buffer.from(key, 'hex')).publicKey,
      )
      console.log(`e2e: starting the relay on ${relayUrl}`)
      ;({ relay } = await startRelay({
        binary,
        dataDir: join(tmpDir, 'data'),
        port,
        allowedPubkeys,
      }))
      activeRelay = relay
      metricsAvailable = true
    } else {
      relayUrl = remoteUrl
      console.log(`e2e: targeting the remote relay ${relayUrl} (dress-rehearsal mode)`)
    }

    const transport = mode === 'remote' ? createWebSocketTransport() : undefined
    await runLoop({ relayUrl, mode, transport })
    printTable()
    await runRejections({ relayUrl, mode, transport, baseUrl, metricsAvailable })

    if (rejectionFailures > 0) {
      console.log(`\ne2e: FAIL — ${rejectionFailures} gate case(s) did not match`)
      return 1
    }
    console.log('\ne2e: PASS — every publish verified, every gate answered as documented')
    return 0
  } catch (error) {
    // A partial table is the useful artifact when the loop stops midway.
    if (rows.length > 0) printTable()
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`\ne2e: FAIL — ${detail}`)
    // A Mismatch is an assertion with a readable message; anything else wants its stack.
    if (!(error instanceof Mismatch) && error instanceof Error && error.stack !== undefined) {
      console.error(error.stack)
    }
    return 1
  } finally {
    for (const client of clients.splice(0)) {
      try {
        client.close()
      } catch {
        // Closing is best-effort: the relay is about to be killed anyway.
      }
    }
    for (const session of sessions.splice(0)) {
      try {
        await session.close()
      } catch {
        // Same.
      }
    }
    await stopRelay(relay)
    activeRelay = undefined
    if (tmpDir !== undefined) {
      const removed = await removeDir(tmpDir)
      if (!removed) console.error(`e2e: WARNING could not remove ${tmpDir}; delete it by hand`)
      activeTmpDir = undefined
    }
  }
}

process.exitCode = await main()
