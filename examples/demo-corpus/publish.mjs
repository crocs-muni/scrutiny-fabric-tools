#!/usr/bin/env node
/**
 * Publish the #192 demo corpus through the MCP server (issue #192, report §4.4).
 *
 * What this proves: the corpus in `corpus.mjs` is expressible through the shipped tool surface,
 * and a single command takes a relay from empty to a graph Lens renders — profile, products,
 * bound records, a patched advisory and a retracted test record. Every event is composed,
 * preflighted and signed by `packages/mcp`, not by this script; this script only supplies tool
 * arguments and resolves the event-id refs between them.
 *
 * Three modes:
 *
 * - LOCAL (default): `go build ./cmd/relay`, start it on a free loopback port with a throwaway
 *   data directory and an allowlist holding only this run's pubkey, publish, then remove both.
 *   The harness is `packages/mcp/scripts/e2e.mjs`'s, deliberately: a corpus that needs a
 *   different boot path than the rehearsal rehearses nothing.
 * - REMOTE (`--relay ws://…|wss://…`): publish to that relay. It must allowlist the key.
 * - DRY RUN (`--dry-run`): publish into an in-memory relay. Composition, preflight, chain
 *   resolution for the patch and the rule-2a check all run; no byte leaves the process. The
 *   printed content is what a real run signs.
 *
 * Determinism: `--now` fixes the `created_at` base; the server stamps `now, now+1, …` in publish
 * order (identity/sign.ts `nextCreatedAt`). Event ids hash the signed fields, so the same `--now`
 * and the same arguments produce the same ids and a re-run against a relay that already holds
 * them adds nothing. Signatures are not stable: the dev signer draws a random BIP-340 auxiliary
 * nonce, so the relay keeps its first copy and a re-run reports "already stored".
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { countsByRole, labelOf, steps, toolArgs, vendor } from './corpus.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(dirname(HERE))
const MCP_DIR = join(REPO_ROOT, 'packages', 'mcp')
const CORE_PACKAGE = '@scrutiny-fabric/core'
const CORE_SRC_URL = pathToFileURL(`${join(REPO_ROOT, 'packages', 'core', 'src')}/`)

/**
 * The demo key. It is published in this file on purpose: the demo npub is a throwaway identity,
 * and a corpus that needs a secret cannot be committed or replayed. Never publish anything with
 * it that you would not publish under your own name.
 */
const DEMO_DEV_KEY = '5f'.repeat(32)

/**
 * Resolve `@scrutiny-fabric/core` to its source, exactly as `scripts/e2e.mjs` does.
 *
 * WHY: core's package `exports` point at `dist`, which a fresh checkout has not built. Two
 * rewrites are needed, not one: the bare specifier, and core's own internal `./x.js` specifiers
 * (what tsc emits), which Node does not map back to the `.ts` on disk.
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

/**
 * The MCP SDK lives in `packages/mcp/node_modules` (pnpm), not next to this example: resolve it
 * from the package that declares it instead of adding a second install to the repo.
 */
const requireFromMcp = createRequire(join(MCP_DIR, 'package.json'))
const sdkUrl = (sub) =>
  pathToFileURL(requireFromMcp.resolve(`@modelcontextprotocol/sdk/${sub}`)).href

const { InMemoryTransport } = await import(sdkUrl('inMemory.js'))
const { Client } = await import(sdkUrl('client/index.js'))
const { loadConfig } = await import(pathToFileURL(join(MCP_DIR, 'src', 'config.ts')).href)
const { createWebSocketTransport } = await import(
  pathToFileURL(join(MCP_DIR, 'src', 'identity', 'wsTransport.ts')).href
)
const { loadSigner } = await import(pathToFileURL(join(MCP_DIR, 'src', 'identity.ts')).href)
const { RelayClient } = await import(pathToFileURL(join(MCP_DIR, 'src', 'relay', 'client.ts')).href)
const { buildServer } = await import(
  pathToFileURL(join(MCP_DIR, 'src', 'tools', 'register.ts')).href
)

const LOCAL_HOST = '127.0.0.1'
const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

const USAGE = `usage: node examples/demo-corpus/publish.mjs [options]

  --relay <url>       publish to this relay; default: build and start a local one
  --dev-key <key>     a 64-hex or nsec1… dev key (alias: --nsec); default: the demo key
  --bunker <uri>      sign through a NIP-46 bunker:// URI instead of a dev key
  --dry-run           compose and preflight into an in-memory relay, print every event
  --out <path>        write the signed events as NDJSON (one event per line)
  --now <iso|epoch>   fix the created_at base (seconds); default: this machine's clock
  --help              print this text

The corpus is ${steps.length} events for the fictional vendor ${vendor.name} (${vendor.family}).`

function parseArgs(argv) {
  const options = {
    relay: undefined,
    devKey: undefined,
    bunker: undefined,
    dryRun: false,
    out: undefined,
    now: undefined,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`)
      index += 1
      return next
    }
    if (flag === '--relay') options.relay = value()
    else if (flag === '--dev-key' || flag === '--nsec') options.devKey = value()
    else if (flag === '--bunker') options.bunker = value()
    else if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--out') options.out = value()
    else if (flag === '--now') options.now = parseNow(value())
    else if (flag === '--help' || flag === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else throw new Error(`unknown flag ${flag}\n\n${USAGE}`)
  }
  if (options.bunker !== undefined && options.devKey !== undefined) {
    throw new Error('pass one signer: --bunker or --dev-key, never both')
  }
  return options
}

/** `--now` takes an ISO timestamp or unix seconds; anything else is a typo, not a clock. */
function parseNow(raw) {
  if (/^\d+$/u.test(raw)) return Number(raw)
  const millis = Date.parse(raw)
  if (Number.isNaN(millis)) throw new Error(`--now ${raw}: not unix seconds and not an ISO date`)
  return Math.floor(millis / 1000)
}

// ---------------------------------------------------------------------------
// local relay — the e2e harness's boot path, minus the gate cases
// ---------------------------------------------------------------------------

async function hasGo() {
  try {
    await execFileAsync('go', ['version'], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** A port the OS just handed out; the relay re-binds it and this run owns the window. */
async function freePort() {
  return await new Promise((done, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, LOCAL_HOST, () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })
}

/**
 * Start the relay with an allowlist holding only this run's pubkey, so a stray publish from any
 * other identity is refused rather than stored. The log tail is kept because a startup failure
 * must name its cause without a re-run.
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
    for (const line of String(chunk).split(/\r?\n/u)) if (line !== '') log.push(line)
    if (log.length > 200) log.splice(0, log.length - 200)
  }
  relay.stdout.on('data', keep)
  relay.stderr.on('data', keep)
  relay.on('error', (cause) => log.push(`spawn failed: ${cause.message}`))

  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline) {
    if (relay.exitCode !== null) {
      throw new Error(
        `the relay exited with code ${relay.exitCode} before answering /healthz:\n${log.join('\n')}`,
      )
    }
    try {
      const response = await fetch(`http://${LOCAL_HOST}:${port}/healthz`)
      const body = (await response.text()).trim()
      if (response.ok && body === 'ok') return relay
      lastError = `/healthz answered ${response.status} ${body}`
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause)
    }
    await sleep(100)
  }
  await stopRelay(relay)
  throw new Error(`the relay did not become healthy in 30 s (${lastError})\n${log.join('\n')}`)
}

/**
 * Stop the relay and wait for the OS to confirm it. `kill()` alone is not enough on Windows: the
 * file lock on `base.bolt` survives until the process object exits, so deleting the data
 * directory first fails with EPERM/EBUSY.
 */
async function stopRelay(child) {
  if (child === undefined || child.exitCode !== null) return
  child.kill()
  const exited = await Promise.race([
    new Promise((done) => child.once('exit', () => done(true))),
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

// ---------------------------------------------------------------------------
// MCP session
// ---------------------------------------------------------------------------

/** The server over the SDK's in-memory transport: the same wire path a host takes, minus stdio. */
async function openSession(deps) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const server = buildServer(deps)
  const client = new Client({ name: 'scrutiny-fabric-demo-corpus', version: '0.0.0' }, {})
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  return {
    async call(name, args) {
      const reply = await client.callTool({ name, arguments: args })
      const block = reply.content?.[0]
      if (block === undefined || block.type !== 'text') {
        throw new Error(
          `${name}: expected a text content block, got ${JSON.stringify(reply.content)}`,
        )
      }
      let value
      try {
        value = JSON.parse(block.text)
      } catch {
        value = undefined
      }
      return { text: block.text, isError: reply.isError === true, value }
    },
    async close() {
      await client.close()
      await server.close()
    },
  }
}

/**
 * An in-memory relay for `--dry-run`: it stores what the handler publishes and serves it back to
 * `verify_event`, so the patch resolves its baseline and the printed ids are the real ids. It is
 * a duck-typed `RelayClient` (publish/fetchById/connected) — the handlers use nothing else.
 */
function inMemoryRelay() {
  const store = new Map()
  return {
    get connected() {
      return false
    },
    async publish(event) {
      const duplicate = store.has(event.id)
      store.set(event.id, event)
      return {
        accepted: true,
        message: duplicate ? 'duplicate: already have this event' : '',
      }
    },
    async fetchById(id) {
      return store.get(id) ?? null
    },
    close() {},
  }
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

/** A publishing tool's JSON body; anything else is a contract break, not a verdict. */
function verdictOf(step, result) {
  if (result.isError) throw new Error(`${step.tool} refused for ${step.key}:\n${result.text}`)
  if (result.value === undefined) {
    throw new Error(`${step.tool} for ${step.key} did not answer with JSON:\n${result.text}`)
  }
  return result.value
}

/**
 * Tool arguments for a step, with the symbolic refs resolved to event ids.
 *
 * WHY the Binding refs carry `author` and no `relay`: the author is the one hint that is stable
 * across a local run, the dress rehearsal and production, and Lens uses it to bind the edge to
 * an identity (BD-8). A relay hint would be the ephemeral loopback URL of a local run, so the
 * reader's own relay stays authoritative.
 */
function argsFor(step, ids, pubkey) {
  const idOf = (name) => {
    const id = ids[name]
    if (id === undefined) throw new Error(`${step.key}: ${name} has not been published yet`)
    return id
  }
  if (step.tool === 'publish_binding') {
    return {
      root_ref: { id: idOf(step.args.root), author: pubkey },
      link_ref: { id: idOf(step.args.link), author: pubkey },
      label: step.args.label,
    }
  }
  if (step.tool === 'retract') {
    return { target_id: idOf(step.args.target), reason: step.args.reason }
  }
  return toolArgs(step)
}

/**
 * The patch payload. `before` is read back from the relay, never reconstructed here: the handler
 * requires it to equal the content the target resolves to, and a hand-copied baseline would rot
 * the moment a root sentence changes.
 */
async function patchArgs(session, step, ids) {
  const targetId = ids[step.patch.target]
  if (targetId === undefined) throw new Error(`${step.key}: ${step.patch.target} is not published`)
  const stored = await session.call('verify_event', { event_id: targetId })
  const event = stored.value?.event
  if (event === null || event === undefined) {
    throw new Error(`${step.key}: the relay has no event for ${targetId}`)
  }
  const { from, to } = step.patch.replace
  if (!event.content.includes(from)) {
    throw new Error(
      `${step.key}: the patch baseline sentence is gone from ${step.patch.target}:\n  ${from}`,
    )
  }
  return { target_id: targetId, before: event.content, after: event.content.replace(from, to) }
}

/** NIP-01 field order, so the NDJSON is byte-comparable across runs. */
function canonical(event) {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  }
}

function printEvent(index, step, event) {
  const head = `[${String(index).padStart(2, '0')}/${steps.length}] ${step.role} ${event.id.slice(0, 12)}`
  console.log(`\n${head}  ${labelOf(step)}`)
  console.log(`  kind ${event.kind}  created_at ${event.created_at}`)
  console.log(`  tags ${JSON.stringify(event.tags)}`)
  console.log(event.content.replace(/^/gmu, '  | '))
}

/** Publish the corpus in order and return the signed events, in publish order. */
async function publishCorpus(session, { dryRun, out, pubkey }) {
  const ids = {}
  const signed = []
  let duplicates = 0
  for (const [index, step] of steps.entries()) {
    const args =
      step.tool === 'publish_patch'
        ? await patchArgs(session, step, ids)
        : argsFor(step, ids, pubkey)
    const verdict = verdictOf(step, await session.call(step.tool, args))
    if (verdict.accepted !== true) {
      throw new Error(
        `${step.key}: the relay refused the event (${verdict.relay_message}); nothing else was published after it`,
      )
    }
    ids[step.key] = verdict.id

    /**
     * The stored event is the proof (guide §9), and it is also how a re-run settles the one
     * case the inline check cannot: this relay keeps the FIRST copy of a known id, so a second
     * publish of the same corpus returns a valid event whose `sig` differs from the fresh one
     * the server just made (the dev signer draws a random BIP-340 auxiliary nonce). The id
     * hashes `pubkey|created_at|kind|tags|content`, so an id that matches its own hash and
     * verifies can only be the event this step composed — a second preimage would be a break.
     */
    const stored = verdictOf(step, await session.call('verify_event', { event_id: verdict.id }))
    if (stored.found !== true || stored.id_matches !== true || stored.signature_valid !== true) {
      throw new Error(
        `${step.key}: ${verdict.id} is not proven — ${stored.note ?? verdict.note ?? 'no read-back note'}`,
      )
    }
    const event = canonical(stored.event)
    signed.push(event)
    const alreadyStored = verdict.verified !== true
    if (dryRun) printEvent(index + 1, step, event)
    else {
      const note = alreadyStored ? '  (already stored; first signature kept)' : ''
      console.log(
        `[${String(index + 1).padStart(2, '0')}/${steps.length}] ${step.role.padEnd(22)} ${event.id}${note}`,
      )
    }
    if (alreadyStored && !dryRun) duplicates += 1
  }
  if (duplicates > 0) {
    console.log(
      `\n${duplicates} of ${steps.length} events were already on the relay; the ids match, so nothing was added`,
    )
  }
  if (out !== undefined) {
    writeFileSync(out, `${signed.map((event) => JSON.stringify(event)).join('\n')}\n`)
    console.log(`\nwrote ${signed.length} signed events to ${out}`)
  }
  return { ids, signed }
}

function printSummary(signed) {
  console.log(`\n${vendor.name} ${vendor.family} — ${signed.length} events`)
  for (const [role, count] of countsByRole()) console.log(`  ${role.padEnd(24)} ${count}`)
  const kinds = new Map()
  for (const event of signed) kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1)
  console.log(`  kinds ${[...kinds].map(([kind, count]) => `${kind}:${count}`).join(' ')}`)
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/** Only set while a local relay and its temp dir exist, so an interrupt can reap both. */
let activeRelay
let activeTmpDir

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.error(
      `\npublish: ${signal} — stopping the relay and removing ${activeTmpDir ?? 'nothing'}`,
    )
    await stopRelay(activeRelay)
    if (activeTmpDir !== undefined) rmSync(activeTmpDir, { recursive: true, force: true })
    process.exit(130)
  })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const localRelay = options.relay === undefined && !options.dryRun
  const now = options.now ?? Math.floor(Date.now() / 1000)
  let tmpDir
  let relay
  let session
  let relayClient
  let relayUrl = options.relay

  // A fixed --now outside the signer's window cannot publish at all: the signer refuses a
  // timestamp more than 15 minutes ahead, and the relay refuses one more than 2 hours old. Warn
  // before the first event so a mistyped date reads as one line, not as 28 refusals.
  const skew = now - Math.floor(Date.now() / 1000)
  if (skew > 15 * 60 || skew < -2 * 60 * 60) {
    console.error(
      `publish: --now ${now} is ${skew > 0 ? `${skew} s ahead of` : `${-skew} s behind`} this machine; the accepted window is 2 h past to 15 min future, so signing or the relay will refuse`,
    )
  }

  try {
    /**
     * One signer for the whole run, resolved before the relay is started: a local relay's
     * allowlist needs the pubkey, the Binding author hints need it too, and a NIP-46 pubkey is
     * only known after the handshake. Resolving it here also makes a bad `--dev-key` fail before
     * a relay process exists.
     */
    const baseEnv =
      options.bunker === undefined
        ? { NSEC: options.devKey ?? DEMO_DEV_KEY }
        : { SCRUTINY_SIGNER_URI: options.bunker }
    const transport = options.bunker === undefined ? undefined : createWebSocketTransport()
    const signer = await loadSigner(
      loadConfig({ ...baseEnv, SCRUTINY_RELAY_URL: relayUrl ?? `ws://${LOCAL_HOST}:1` }),
      transport,
    )

    if (options.dryRun) {
      console.log(`publish: dry run — ${steps.length} events, in-memory relay, nothing sent`)
    } else if (localRelay) {
      if (!(await hasGo())) {
        throw new Error(
          'go not found — a local relay needs the Go toolchain; pass --relay to use one',
        )
      }
      tmpDir = join(tmpdir(), `scrutiny-demo-corpus-${process.pid}-${Date.now()}`)
      activeTmpDir = tmpDir
      mkdirSync(join(tmpDir, 'data'), { recursive: true })
      const binary = join(tmpDir, process.platform === 'win32' ? 'relay.exe' : 'relay')
      console.log(`publish: building the relay binary into ${tmpDir}`)
      await execFileAsync('go', ['build', '-o', binary, './cmd/relay'], {
        cwd: join(REPO_ROOT, 'relay'),
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      })
      const port = await freePort()
      console.log(
        `publish: starting the relay on ws://${LOCAL_HOST}:${port} for ${signer.publicKey}`,
      )
      relay = await startRelay({
        binary,
        dataDir: join(tmpDir, 'data'),
        port,
        allowedPubkeys: [signer.publicKey],
      })
      activeRelay = relay
      relayUrl = `ws://${LOCAL_HOST}:${port}`
    }

    // The final config names the relay this run actually talks to; `status` reads it back.
    const config = loadConfig({
      ...baseEnv,
      SCRUTINY_RELAY_URL: relayUrl ?? `ws://${LOCAL_HOST}:1`,
    })

    /**
     * The relay client is owned here, not by the handler context, so this run can close it:
     * an open WebSocket to a live relay keeps Node's event loop alive after the corpus is
     * published, and a CLI that never exits is indistinguishable from a hang.
     */
    relayClient = options.dryRun
      ? inMemoryRelay()
      : new RelayClient({
          relayUrl: config.relayUrl,
          signer: { sign: (event) => signer.sign(event) },
        })

    session = await openSession({
      config,
      signer,
      client: relayClient,
      now: () => now,
      ...(transport === undefined ? {} : { transport }),
    })

    const status = await session.call('status', {})
    if (status.isError) throw new Error(`status: ${status.text}`)
    console.log(`publish: ${status.text.replace(/\n/gu, ' | ')}`)
    console.log(
      `publish: created_at base ${now} (${new Date(now * 1000).toISOString()}), ${options.dryRun ? 'not connected' : `relay ${relayUrl}`}`,
    )

    const { ids, signed } = await publishCorpus(session, {
      dryRun: options.dryRun,
      out: options.out === undefined ? undefined : resolve(options.out),
      pubkey: signer.publicKey,
    })
    printSummary(signed)
    // The ids are the corpus's contract with every later run; print them so a log is comparable.
    if (options.dryRun) {
      console.log('\nids')
      for (const [key, id] of Object.entries(ids)) console.log(`  ${key.padEnd(28)} ${id}`)
    }
    console.log('\npublish: PASS — every event accepted and proven on read-back')
    return 0
  } finally {
    relayClient?.close()
    await session?.close()
    await stopRelay(relay)
    activeRelay = undefined
    if (tmpDir !== undefined) {
      if (!(await removeDir(tmpDir))) {
        console.error(`publish: WARNING could not remove ${tmpDir}; delete it by hand`)
      }
      activeTmpDir = undefined
    }
  }
}

try {
  process.exitCode = await main()
} catch (cause) {
  // The refusal text is the useful output: it names the field and the fix, so print it plainly.
  console.error(`\npublish: FAIL — ${cause instanceof Error ? cause.message : String(cause)}`)
  process.exitCode = 1
}
