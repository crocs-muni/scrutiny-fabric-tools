/**
 * patch.ts — SCRUTINY patch payload producer & consumer (protocol-spec.md §4.4, §5.1–§5.3).
 *
 * `createPatch` computes an LCS line diff and renders a unified-diff payload: context
 * min(3, available) (P1), headers `--- a/content` / `+++ b/content`, no index/mode/similarity
 * lines (P2), UTF-8 + LF (P3). The payload is round-trip pre-verified against the target
 * content before it is returned (P4) — a payload our own `applyPatch` cannot reproduce the new
 * content from throws instead of being published.
 *
 * `applyPatch` consumes either a full event `content` (E5/E6: the first fenced `diff`/`patch`
 * block is the payload) or a bare payload (producer-local pre-verify). Hunks apply with the
 * strict uniqueness/position semantics of T1/T2/T3; any mismatch or ambiguity throws rather
 * than guessing. `wrapPatchEventPayload` builds the E2/E4 envelope: one fenced block, info
 * string `diff`, fence length `max(3, N + 1)` for N the longest backtick run in the payload.
 *
 * Line model: content is split on `\n`; the trailing element after a final newline is the
 * empty "phantom" line, and it participates in the diff like any other line — so a patch can
 * never invent or drop a trailing newline (PB-1 consumes bytes verbatim).
 */

const CONTEXT_LINES = 3

/** LCS cell budget (~16 MB of Int32); past it the diff degrades to one whole-middle hunk. */
const DP_CELL_CAP = 4_000_000

interface DiffOp {
  type: 'equal' | 'del' | 'ins'
  line: string
}

/** Longest-common-subsequence edit script over two line arrays (del preferred on ties). */
function lcsOps(a: readonly string[], b: readonly string[]): DiffOp[] {
  const m = a.length
  const n = b.length
  const width = n + 1
  const dp = new Int32Array((m + 1) * width)
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j]
          ? (dp[(i + 1) * width + (j + 1)] ?? 0) + 1
          : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + (j + 1)] ?? 0)
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', line: a[i] ?? '' })
      i += 1
      j += 1
    } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + (j + 1)] ?? 0)) {
      ops.push({ type: 'del', line: a[i] ?? '' })
      i += 1
    } else {
      ops.push({ type: 'ins', line: b[j] ?? '' })
      j += 1
    }
  }
  while (i < m) {
    ops.push({ type: 'del', line: a[i] ?? '' })
    i += 1
  }
  while (j < n) {
    ops.push({ type: 'ins', line: b[j] ?? '' })
    j += 1
  }
  return ops
}

function diffLines(before: readonly string[], after: readonly string[]): DiffOp[] {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1
  }
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1
    endAfter -= 1
  }
  const ops: DiffOp[] = []
  for (let i = 0; i < start; i += 1) ops.push({ type: 'equal', line: before[i] ?? '' })
  const midBefore = before.slice(start, endBefore)
  const midAfter = after.slice(start, endAfter)
  if (midBefore.length * midAfter.length > DP_CELL_CAP) {
    for (const line of midBefore) ops.push({ type: 'del', line })
    for (const line of midAfter) ops.push({ type: 'ins', line })
  } else {
    ops.push(...lcsOps(midBefore, midAfter))
  }
  for (let i = endBefore; i < before.length; i += 1) {
    ops.push({ type: 'equal', line: before[i] ?? '' })
  }
  return ops
}

/** Change groups (merged while separated by ≤ 2·context equal lines) padded to `context`. */
function hunkRanges(ops: readonly DiffOp[]): Array<[number, number]> {
  const changes: number[] = []
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i]?.type !== 'equal') changes.push(i)
  }
  if (changes.length === 0) return []
  const merged: Array<[number, number]> = []
  let groupStart = changes[0] ?? 0
  let groupEnd = groupStart + 1
  for (const index of changes.slice(1)) {
    if (index - groupEnd <= 2 * CONTEXT_LINES) {
      groupEnd = index + 1
      continue
    }
    merged.push([groupStart, groupEnd])
    groupStart = index
    groupEnd = index + 1
  }
  merged.push([groupStart, groupEnd])
  return merged.map(([start, end]) => [
    Math.max(0, start - CONTEXT_LINES),
    Math.min(ops.length, end + CONTEXT_LINES),
  ])
}

function renderPatch(
  ops: readonly DiffOp[],
  ranges: ReadonlyArray<readonly [number, number]>,
): string {
  const oldNo = new Array<number>(ops.length + 1).fill(1)
  const newNo = new Array<number>(ops.length + 1).fill(1)
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]
    if (op === undefined) break
    oldNo[i + 1] = (oldNo[i] ?? 1) + (op.type === 'ins' ? 0 : 1)
    newNo[i + 1] = (newNo[i] ?? 1) + (op.type === 'del' ? 0 : 1)
  }
  const lines = ['--- a/content', '+++ b/content']
  for (const [start, end] of ranges) {
    const oldCount = (oldNo[end] ?? 1) - (oldNo[start] ?? 1)
    const newCount = (newNo[end] ?? 1) - (newNo[start] ?? 1)
    // Zero-count sides use the unified-diff "line number before the insertion" convention
    // (0 at beginning-of-file); see T2's carried-forward position interpretation.
    const oldStart = oldCount === 0 ? (oldNo[start] ?? 1) - 1 : (oldNo[start] ?? 1)
    const newStart = newCount === 0 ? (newNo[start] ?? 1) - 1 : (newNo[start] ?? 1)
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (let i = start; i < end; i += 1) {
      const op = ops[i]
      if (op === undefined) continue
      const marker = op.type === 'equal' ? ' ' : op.type === 'del' ? '-' : '+'
      lines.push(`${marker}${op.line}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function tryApply(content: string, patch: string): string | null {
  try {
    return applyPatch(content, patch)
  } catch {
    return null
  }
}

/**
 * Unified-diff payload from `oldContent` to `newContent`; empty string when they are equal.
 * P4: the payload must reproduce `newContent` when applied to `oldContent` under T1/T2/T3 —
 * checked here, and a whole-file hunk (unique by construction) is retried before throwing.
 */
export function createPatch(oldContent: string, newContent: string): string {
  if (oldContent === newContent) return ''
  const ops = diffLines(oldContent.split('\n'), newContent.split('\n'))
  const patch = renderPatch(ops, hunkRanges(ops))
  if (tryApply(oldContent, patch) === newContent) return patch
  const widened = renderPatch(ops, [[0, ops.length]])
  if (tryApply(oldContent, widened) === newContent) return widened
  throw new Error(
    'createPatch: payload does not reproduce the new content under T1/T2/T3 (P4 pre-verify failed)',
  )
}

/** E5/E6: first fenced `diff`/`patch` block wins; `null` when the text carries none. */
function findFirstFencedBlock(text: string): string | null {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^( {0,3})(`{3,})([^`]*)$/u.exec(lines[i] ?? '')
    if (open === null) continue
    const info = ((open[3] ?? '').trim().split(/\s+/u)[0] ?? '').toLowerCase()
    if (info !== 'diff' && info !== 'patch') continue
    const fenceLength = (open[2] ?? '').length
    for (let j = i + 1; j < lines.length; j += 1) {
      const close = /^( {0,3})(`{3,})[ \t]*$/u.exec(lines[j] ?? '')
      if (close !== null && (close[2] ?? '').length >= fenceLength) {
        return lines
          .slice(i + 1, j)
          .map((line) => `${line}\n`)
          .join('')
      }
    }
    // E5 unclosed block: every line after the opening fence to the end of content.
    const rest = lines.slice(i + 1)
    if (rest.length > 0 && rest[rest.length - 1] === '') rest.pop()
    return rest.map((line) => `${line}\n`).join('')
  }
  return null
}

function extractPatchPayload(text: string): string {
  const hasHeaders = (candidate: string): boolean =>
    /^(?:--- |diff --git |Index: )/mu.test(candidate)
  // E5/E6: an event content's payload is the first fenced diff/patch block — but only when
  // that block is a real unified-diff payload (it carries the mandatory header block). A bare
  // payload (producer-local P4 pre-verify) carries the headers itself; a fenced candidate
  // without them is quoted content (e.g. a diff hunk over backtick fences), so fall back.
  const fenced = findFirstFencedBlock(text)
  if (fenced !== null && hasHeaders(fenced)) return fenced
  // Prose-only no-op patch events (N1/E7) carry neither a payload block nor headers.
  return hasHeaders(text) ? text : ''
}

interface ParsedHunkLine {
  kind: 'ctx' | 'del' | 'ins'
  text: string
}

interface ParsedHunk {
  oldStart: number
  oldCount: number
  lines: ParsedHunkLine[]
}

/** Tolerated-preamble + header + hunk parser (C1–C4, C8); throws on anything else. */
function parsePatch(payload: string): ParsedHunk[] {
  const trimmed = payload.endsWith('\n') ? payload.slice(0, -1) : payload
  const lines = trimmed.split('\n')
  const hunks: ParsedHunk[] = []
  let sawHeader = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('Index: ') ||
      /^=+\s*$/u.test(line) ||
      line.trim().length === 0
    ) {
      i += 1
      continue
    }
    if (line.startsWith('--- ')) {
      const oldPath = line.slice(4).trim().split(/\s+/u)[0] ?? ''
      if (oldPath !== 'a/content') {
        throw new Error(`applyPatch: C1 violation — '---' path token is ${JSON.stringify(oldPath)}`)
      }
      const plus = lines[i + 1] ?? ''
      if (!plus.startsWith('+++ ')) {
        throw new Error("applyPatch: missing '+++ b/content' header after '--- a/content'")
      }
      const newPath = plus.slice(4).trim().split(/\s+/u)[0] ?? ''
      if (newPath !== 'b/content') {
        throw new Error(`applyPatch: C1 violation — '+++' path token is ${JSON.stringify(newPath)}`)
      }
      sawHeader = true
      i += 2
      continue
    }
    if (line.startsWith('@@')) {
      if (!sawHeader) throw new Error('applyPatch: hunk header before any file header')
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line)
      if (header === null)
        throw new Error(`applyPatch: malformed hunk header ${JSON.stringify(line)}`)
      const hunk: ParsedHunk = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        lines: [],
      }
      i += 1
      while (i < lines.length) {
        const hunkLine = lines[i] ?? ''
        // C8: a `---` line where a hunk line could appear begins a new file section.
        if (
          hunkLine.startsWith('@@') ||
          hunkLine.startsWith('--- ') ||
          hunkLine.startsWith('diff --git ')
        ) {
          break
        }
        i += 1
        if (hunkLine.length === 0) {
          hunk.lines.push({ kind: 'ctx', text: '' }) // bare-LF context line (§5.2 grammar)
          continue
        }
        const marker = hunkLine.charAt(0)
        if (marker === '\\') continue // C5 no-newline marker; informational only here
        if (marker === ' ') {
          hunk.lines.push({ kind: 'ctx', text: hunkLine.slice(1) })
          continue
        }
        if (marker === '-') {
          hunk.lines.push({ kind: 'del', text: hunkLine.slice(1) })
          continue
        }
        if (marker === '+') {
          hunk.lines.push({ kind: 'ins', text: hunkLine.slice(1) })
          continue
        }
        throw new Error(`applyPatch: unexpected hunk line ${JSON.stringify(hunkLine.slice(0, 40))}`)
      }
      hunks.push(hunk)
      continue
    }
    throw new Error(`applyPatch: unexpected payload line ${JSON.stringify(line.slice(0, 40))}`)
  }
  return hunks
}

/**
 * Apply a patch (event `content` or bare payload) to `content`. Strict T1/T2/T3 semantics:
 * a hunk's context+removed pattern must occur exactly once (T1); pure insertions position from
 * the header's old line number carried forward by prior-hunk net deltas and clamp into range
 * (T2); hunks sequence in document order across sections (T3). Throws on any mismatch.
 */
export function applyPatch(content: string, patchText: string): string {
  const payload = extractPatchPayload(patchText)
  if (payload.trim().length === 0) return content // N1/E7: prose-only / empty patch is a no-op
  const hunks = parsePatch(payload)
  if (hunks.length === 0) return content // N2: header-only block is a valid no-op
  let lines = content.split('\n')
  let carry = 0
  for (const hunk of hunks) {
    const pattern: string[] = []
    const replacement: string[] = []
    for (const hunkLine of hunk.lines) {
      if (hunkLine.kind === 'ctx') {
        pattern.push(hunkLine.text)
        replacement.push(hunkLine.text)
      } else if (hunkLine.kind === 'del') {
        pattern.push(hunkLine.text)
      } else {
        replacement.push(hunkLine.text)
      }
    }
    if (pattern.length === 0) {
      // T2 insertion carve-out: header position in pre-patch real-line coordinates, carried
      // forward by prior-hunk net deltas, clamped into the current content's line range — a
      // final newline terminates the last line and does not add one (§5.3 T2).
      const realLines = lines.length - (lines[lines.length - 1] === '' ? 1 : 0)
      const at = Math.max(0, Math.min(realLines, hunk.oldStart + carry))
      lines = [...lines.slice(0, at), ...replacement, ...lines.slice(at)]
      carry += replacement.length
      continue
    }
    let found = -1
    for (let i = 0; i + pattern.length <= lines.length; i += 1) {
      let matches = true
      for (let j = 0; j < pattern.length; j += 1) {
        if (lines[i + j] !== pattern[j]) {
          matches = false
          break
        }
      }
      if (!matches) continue
      if (found !== -1) {
        throw new Error(
          `applyPatch: T1 ambiguity — hunk context occurs more than once (@@ -${hunk.oldStart},${hunk.oldCount})`,
        )
      }
      found = i
    }
    if (found === -1) {
      throw new Error(
        `applyPatch: T1 mismatch — hunk context not found (@@ -${hunk.oldStart},${hunk.oldCount})`,
      )
    }
    lines = [...lines.slice(0, found), ...replacement, ...lines.slice(found + pattern.length)]
    carry += replacement.length - pattern.length
  }
  return lines.join('\n')
}

/** E2/E4 envelope: one fenced block (info string `diff`) safe against the payload's backticks. */
export function wrapPatchEventPayload(diff: string): string {
  const payload = diff === '' || diff.endsWith('\n') ? diff : `${diff}\n`
  let longestRun = 0
  for (const run of payload.matchAll(/`+/gu)) {
    longestRun = Math.max(longestRun, (run[0] ?? '').length)
  }
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}diff\n${payload}${fence}\n`
}
