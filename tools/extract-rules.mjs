#!/usr/bin/env node
// Extract the SCRUTINY Fabric normative rule registry from the protocol spec
// into machine-readable JSON, cross-validating the per-section rule tables
// against the flat Appendix F index.
//
// Usage:
//   node tools/extract-rules.mjs [--spec <path>] [--out <path>] [--json]
//
// Exit codes: 0 = no discrepancies at severity "error"; 1 = at least one.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULT_SPEC = resolve(HERE, '../../scrutiny-fabric/docs/protocol-spec.md');
const DEFAULT_OUT = resolve(HERE, 'rules.json');

// Header rows that identify the two kinds of rule table. Matched after
// normalising interior whitespace, so column padding changes are tolerated.
const BODY_HEADER = '| # | layer | inherits from | rule |';
const APPENDIX_HEADER = '| id | § | layer | inherits from | summary |';

const ID_PATTERN = /^(?:[A-Z]{2,4}-\d{1,3}|[A-Z]\d{1,3})$/;
const LAYERS = new Set(['V', 'A', 'D']);
const DASH = '—'; // em dash, the spec's "not applicable" marker

function parseArgs(argv) {
  const opts = { spec: DEFAULT_SPEC, out: DEFAULT_OUT, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--spec') opts.spec = resolve(argv[++i]);
    else if (argv[i] === '--out') opts.out = resolve(argv[++i]);
    else if (argv[i] === '--json') opts.json = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return opts;
}

/** Split a markdown table row into trimmed cells. */
function cells(line) {
  const t = line.trim();
  const inner = t.slice(t.startsWith('|') ? 1 : 0, t.endsWith('|') ? -1 : undefined);
  return inner.split('|').map((c) => c.trim());
}

function normaliseHeader(line) {
  return cells(line)
    .map((c) => c.toLowerCase())
    .join(' | ')
    .replace(/^/, '| ')
    .replace(/$/, ' |');
}

const isSeparator = (line) => /^\|[\s:|-]+\|$/.test(line.trim());
const nullIfDash = (v) => (v === DASH || v === '-' || v === '' ? null : v);

/**
 * Walk the spec, tracking the current numbered section heading, and pull out
 * both flavours of rule table plus the raw §6.0 layer-manifest prose.
 */
function parseSpec(text) {
  const lines = text.split(/\r?\n/);
  const body = [];
  const appendix = [];
  let section = null;
  let inAppendix = false;
  const sixZeroLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading) {
      const title = heading[2].trim();
      const numbered = /^(\d+(?:\.\d+)*)\.?(?:\s|$)/.exec(title);
      if (numbered) section = numbered[1];
      else if (/^Appendix\s+[A-Z]\b/.test(title)) section = null;
      // unnumbered subheadings (#### Envelope:, ### Recognized `i` prefixes)
      // inherit the enclosing numbered section — leave `section` untouched.
      inAppendix = /^Appendix\s+F\b/.test(title);
      continue;
    }

    if (section === '6.0') sixZeroLines.push(line);

    if (!line.trim().startsWith('|')) continue;

    const header = normaliseHeader(line);
    const isBody = header === BODY_HEADER;
    const isAppendix = header === APPENDIX_HEADER;
    if (!isBody && !isAppendix) continue;

    let j = i + 1;
    if (j < lines.length && isSeparator(lines[j])) j++;
    for (; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      const row = cells(lines[j]);
      const lineNo = j + 1;
      if (isBody) {
        body.push({
          id: row[0],
          layer: row[1],
          inheritsFrom: row[2],
          text: row[3],
          section,
          line: lineNo,
          cellCount: row.length,
        });
      } else {
        appendix.push({
          id: row[0],
          section: row[1],
          layer: row[2],
          inheritsFrom: row[3],
          summary: row[4],
          line: lineNo,
          cellCount: row.length,
        });
      }
    }
    i = j - 1;
  }

  if (!inAppendix && appendix.length === 0) {
    throw new Error('Appendix F rule table not found — spec structure changed?');
  }
  return { body, appendix, sixZero: sixZeroLines };
}

/**
 * Parse the §6.0 layer manifest ("V rules cover: …") and expand the rule IDs,
 * ranges (`IM-1..IM-4`, `T1–T3`) and wildcards (`E*`, `CHN-*`) it cites.
 * Cross-checking this against the tables catches drift in the layer prose.
 */
function parseLayerManifest(sixZeroLines, validIds) {
  const byPrefix = new Map();
  const split = (id) => {
    const m = /^([A-Z]{1,4})-?(\d{1,3})$/.exec(id);
    return m ? { prefix: m[1], num: Number(m[2]) } : null;
  };
  for (const id of validIds) {
    const p = split(id);
    if (!p) continue;
    if (!byPrefix.has(p.prefix)) byPrefix.set(p.prefix, []);
    byPrefix.get(p.prefix).push(id);
  }

  const manifest = new Map(); // id -> Set(layers claimed)
  const unknown = new Set();
  let layer = null;

  const claim = (id) => {
    if (!validIds.has(id)) return unknown.add(id);
    if (!manifest.has(id)) manifest.set(id, new Set());
    manifest.get(id).add(layer);
  };

  for (const raw of sixZeroLines) {
    const marker = /^\*\*([VAD])\s*[—-]/.exec(raw.trim());
    if (marker) {
      layer = marker[1];
      continue;
    }
    if (!layer) continue;
    // Strip section references so "§6.2–§6.4" and "§5.2" cannot be read as IDs.
    const line = raw.replace(/§\s*\d+(?:\.\d+)*/g, ' ');

    // ranges: only .. / en dash / em dash separate a range (a bare hyphen is
    // part of the ID itself, e.g. DEL-1)
    const rangeRe = /\b([A-Z]{1,4}-?\d{1,3})\s*(?:\.\.|–|—)\s*([A-Z]{1,4}-?\d{1,3})\b/g;
    const consumed = [];
    for (const m of line.matchAll(rangeRe)) {
      const a = split(m[1]);
      const b = split(m[2]);
      consumed.push(m[0]);
      if (!a || !b || a.prefix !== b.prefix) continue;
      for (let n = a.num; n <= b.num; n++) {
        const dashed = `${a.prefix}-${n}`;
        claim(validIds.has(dashed) ? dashed : `${a.prefix}${n}`);
      }
    }
    let rest = line;
    for (const c of consumed) rest = rest.split(c).join(' ');

    for (const m of rest.matchAll(/\b([A-Z]{1,4})-?\*/g)) {
      for (const id of byPrefix.get(m[1]) ?? []) claim(id);
    }
    for (const m of rest.matchAll(/\b([A-Z]{1,4}-\d{1,3}|[A-Z]\d{1,3})\b/g)) {
      if (/^NIP-/.test(m[0])) continue;
      claim(m[0]);
    }
  }
  return { manifest, unknown };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const text = readFileSync(opts.spec, 'utf8');
  const { body, appendix, sixZero } = parseSpec(text);

  const discrepancies = [];
  const add = (severity, kind, id, message) =>
    discrepancies.push({ severity, kind, id, message });

  const index = (rows, label) => {
    const map = new Map();
    for (const r of rows) {
      if (map.has(r.id)) {
        add('error', 'duplicate-id', r.id,
          `${label}: duplicate row (lines ${map.get(r.id).line} and ${r.line})`);
        continue;
      }
      map.set(r.id, r);
      if (!ID_PATTERN.test(r.id)) {
        add('error', 'malformed-id', r.id,
          `${label} line ${r.line}: id "${r.id}" does not match ${ID_PATTERN}`);
      }
      const expected = label === 'Appendix F' ? 5 : 4;
      if (r.cellCount !== expected) {
        add('error', 'malformed-row', r.id,
          `${label} line ${r.line}: ${r.cellCount} cells, expected ${expected}`);
      }
      // Layer values are not hard-coded as a closed set: a future spec version
      // may add a layer or re-tag existing rules. Anything shaped like a layer
      // tag is accepted (and reported if unfamiliar); only junk is an error.
      if (r.layer !== DASH && !LAYERS.has(r.layer)) {
        if (/^[A-Z]$/.test(r.layer)) {
          add('info', 'unknown-layer', r.id,
            `${label} line ${r.line}: layer "${r.layer}" is not one of ${[...LAYERS].join('/')} — new layer introduced?`);
        } else {
          add('error', 'bad-layer', r.id,
            `${label} line ${r.line}: layer "${r.layer}" is not a layer tag or "${DASH}"`);
        }
      }
    }
    return map;
  };

  const bodyById = index(body, 'body table');
  const apxById = index(appendix, 'Appendix F');

  for (const id of bodyById.keys()) {
    if (!apxById.has(id)) {
      add('error', 'missing-from-appendix', id,
        `defined in §${bodyById.get(id).section} body table (line ${bodyById.get(id).line}) but absent from Appendix F`);
    }
  }
  for (const id of apxById.keys()) {
    if (!bodyById.has(id)) {
      add('error', 'missing-from-body', id,
        `listed in Appendix F (line ${apxById.get(id).line}, §${apxById.get(id).section}) but no body rule table defines it`);
    }
  }

  const generalises = (apxSec, bodySec) =>
    apxSec !== null && bodySec !== null &&
    (bodySec === apxSec || bodySec.startsWith(apxSec + '.'));

  for (const [id, b] of bodyById) {
    const a = apxById.get(id);
    if (!a) continue;
    if (a.layer !== b.layer) {
      add('error', 'layer-mismatch', id,
        `body §${b.section} says layer "${b.layer}", Appendix F says "${a.layer}"`);
    }
    if (a.inheritsFrom !== b.inheritsFrom) {
      add('error', 'inherits-mismatch', id,
        `body §${b.section} says inherits-from "${b.inheritsFrom}", Appendix F says "${a.inheritsFrom}"`);
    }
    if (a.section !== b.section) {
      if (generalises(a.section, b.section)) {
        add('info', 'section-generalised', id,
          `Appendix F cites §${a.section}; body rule table lives under §${b.section}`);
      } else {
        add('error', 'section-mismatch', id,
          `Appendix F cites §${a.section}, body rule table lives under §${b.section}`);
      }
    }
  }

  // §6.0 layer manifest cross-check (informational: the manifest is prose,
  // the tables are the registry, but a conflict is a spec defect).
  const { manifest, unknown } = parseLayerManifest(sixZero, new Set(bodyById.keys()));
  for (const id of unknown) {
    add('error', 'unknown-id-in-6.0', id, `§6.0 layer manifest cites "${id}", which no rule table defines`);
  }
  for (const [id, claimed] of manifest) {
    const actual = bodyById.get(id).layer;
    if (claimed.size > 1) {
      add('info', 'manifest-double-claim', id,
        `§6.0 assigns ${id} to layers ${[...claimed].sort().join(' and ')}; rule tables say "${actual}"`);
    } else if (!claimed.has(actual)) {
      add('info', 'manifest-layer-conflict', id,
        `§6.0 lists ${id} under layer ${[...claimed][0]}; rule tables say "${actual}"`);
    }
  }

  // Merge. Appendix F defines registry order; body-only rules are appended.
  const RESERVED = /^\s*\*?\*?Reserved\b/i;
  const merged = [];
  const seen = new Set();
  const emit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const a = apxById.get(id);
    const b = bodyById.get(id);
    const summary = a?.summary ?? null;
    const bodyText = b?.text ?? null;
    merged.push({
      id,
      section: a?.section ?? b?.section ?? null,
      layer: nullIfDash(a?.layer ?? b?.layer ?? null),
      inheritsFrom: nullIfDash(a?.inheritsFrom ?? b?.inheritsFrom ?? null),
      summary,
      text: bodyText,
      reserved:
        (a?.layer === DASH && b?.layer === DASH) ||
        RESERVED.test(summary ?? '') ||
        RESERVED.test(bodyText ?? ''),
    });
  };
  for (const r of appendix) emit(r.id);
  for (const r of body) emit(r.id);

  // Layer tallies are derived from the data, so a new layer letter shows up
  // in the report instead of being silently folded into "unlayered".
  const counts = { total: merged.length, byLayer: {}, reserved: 0, unlayered: 0 };
  for (const r of merged) {
    if (r.reserved) counts.reserved++;
    if (r.layer === null) counts.unlayered++;
    else counts.byLayer[r.layer] = (counts.byLayer[r.layer] ?? 0) + 1;
  }

  const prefixes = new Map();
  for (const r of merged) {
    const p = /^([A-Z]{1,4})-?\d/.exec(r.id)?.[1] ?? '?';
    prefixes.set(p, (prefixes.get(p) ?? 0) + 1);
  }

  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify(merged, null, 2) + '\n', 'utf8');

  const errors = discrepancies.filter((d) => d.severity === 'error');
  const infos = discrepancies.filter((d) => d.severity === 'info');

  if (opts.json) {
    console.log(JSON.stringify({ counts, prefixes: [...prefixes], discrepancies }, null, 2));
  } else {
    console.log(`spec:      ${opts.spec}`);
    console.log(`out:       ${opts.out}`);
    console.log(`body rows: ${body.length}   Appendix F rows: ${appendix.length}   merged: ${merged.length}`);
    const layerStr = Object.entries(counts.byLayer)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([l, n]) => `${l}=${n}`)
      .join(' ');
    console.log(`layers:    ${layerStr} reserved=${counts.reserved} unlayered=${counts.unlayered}`);
    console.log(`prefixes:  ${[...prefixes].map(([p, n]) => `${p}(${n})`).join(' ')}`);
    console.log('');
    console.log(`errors: ${errors.length}   info: ${infos.length}`);
    for (const d of [...errors, ...infos]) {
      console.log(`  [${d.severity}] ${d.kind} ${d.id}: ${d.message}`);
    }
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

main();
