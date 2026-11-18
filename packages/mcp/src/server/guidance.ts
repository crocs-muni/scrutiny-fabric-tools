/**
 * Every guidance surface comes from this module (spec §12): tool descriptions, the `instructions`
 * of the initialize result, the `scrutiny://publisher-guide` resource and the `publish` prompt.
 * `draft_plan` results (open questions, `next_step`) are the primary channel; this is the rest.
 *
 * Examples use an invented vendor (Example Corp, EX-100) and no pilot publisher.
 */

import { KNOWN_INDEXER_PREFIXES } from '../preflight/gates.js'

export const GUIDE_URI = 'scrutiny://publisher-guide'

/** The public Lens instance (spec §12). No account; it discovers records by exact `i` value. */
export const LENS_URL = 'https://lens.scrutiny.cloud'

export const TOOL_DESCRIPTIONS = {
  status: [
    'Report this server, the publisher identity (npub) and the approval channel.',
    'Call it first. It never reads the signing key. If signer.state is not "ready", tell the user',
    'to run the `fix` command themselves; never handle a key yourself.',
  ].join(' '),
  draft_plan: [
    'Turn a publication plan (inline `plan`, or `path` to a plan file under `root`) into a preview',
    'of the exact events that would be published, with open questions. Signs and publishes',
    'nothing; safe to call repeatedly. Interview loop: ask the user every open question with',
    'ask_user=true, revise the plan, and call draft_plan again. Never call publish_plan while a',
    `blocking question remains. Read ${GUIDE_URI} before drafting the first plan.`,
  ].join(' '),
  publish_plan: [
    'Publish a drafted plan, IRREVERSIBLY: events are signed with the publisher key and become',
    'permanent and public. Pass the plan_id and plan_hash from draft_plan. The user approves the',
    'plan first: in a dialog the server shows, or, if the result carries an approval_code, by replying with',
    'the approval_code after you show them the summary verbatim. Each call works for about 20',
    's; on outcome "partial" call publish_plan again at once with the same arguments.',
  ].join(' '),
  verify: [
    'Fetch published events back from relays and check they are stored unaltered (id, signature,',
    'and the exact signed bytes when the run journal has them). Read-only.',
  ].join(' '),
} as const

export const INSTRUCTIONS = [
  'SCRUTINY Fabric publishing server. It turns a publisher’s local security files',
  '(specifications, test reports, advisories, SBOMs) into SCRUTINY Fabric events on Nostr.',
  '',
  `Read ${GUIDE_URI} before drafting the first plan.`,
  '',
  'Flow:',
  '1. status: check that signer.state is "ready".',
  '2. Read the files in the user’s folder. Draft a plan of records: one profile, the products,',
  '   and one metadata record per document, bound to its products.',
  '3. draft_plan: show the user the preview. Ask every open question with ask_user=true, revise,',
  '   and draft again until ready is true.',
  '4. publish_plan with plan_id and plan_hash. The user approves; the server signs and publishes.',
  '   On outcome "partial", call publish_plan again with the same arguments until "complete".',
  '5. verify, if the user wants proof that the relay stores the events unaltered.',
  '',
  'Rules: you supply meaning (headlines, bullets, indexers, cards, which files); the server derives',
  'everything mechanical (content layout, tags, hashes, ids, timestamps). Never invent facts: cite',
  'each record’s `sources`. Publishing is permanent: indexers and files cannot be changed later.',
  'Never ask for, read or handle the signing key.',
].join('\n')

export function publishPrompt(folder: string, relay: string): string {
  return `Publish the security data in ${folder} to SCRUTINY Fabric, using ${relay} as the primary relay. Follow the flow in the server instructions and ${GUIDE_URI}.`
}

export const NEXT_STEP = {
  ready:
    'The plan is ready. Show the user the preview, then call publish_plan with plan_id and plan_hash.',
  questions: (n: number) =>
    `Ask the user the ${n} open question(s) with ask_user=true, revise the plan, and call draft_plan again.`,
  invalid: 'Fix the findings in the plan and call draft_plan again.',
  partial:
    'Call publish_plan again now with the same plan_id and plan_hash; do not ask the user again.',
  stopped:
    'Tell the user why the run stopped (refusal), fix the cause, then call publish_plan again with the same arguments.',
  complete: 'Done. Tell the user how many events were published and verified.',
  approval:
    'Show the user the summary verbatim and ask them to reply with the approval code if they approve. Then call publish_plan again with approval_code set to their reply.',
} as const

const PREFIX_TABLE = KNOWN_INDEXER_PREFIXES.map((p) => `\`${p}\``).join(', ')

/** The worked example; `test/guidance.test.ts` drafts it and checks the documented content. */
export const GUIDE_EXAMPLE_PLAN = {
  planVersion: 1,
  relays: ['wss://relay.scrutiny.cloud'],
  records: [
    {
      ref: 'profile:examplecorp',
      type: 'profile',
      name: 'examplecorp',
      display_name: 'Example Corp',
      about: 'Secure-element vendor.',
    },
    {
      ref: 'product:ex-100',
      type: 'product',
      headline: 'Example Corp EX-100 secure element',
      bullets: ['RISC-V core with a hardware crypto accelerator'],
      indexers: ['vendor:example-corp', 'part:EX-100'],
      card: { vendor: 'Example Corp', part: 'EX-100' },
      sources: ['datasheets/ex-100-datasheet.pdf'],
    },
    {
      ref: 'metadata:fi-test',
      type: 'metadata',
      subtype: 'test',
      headline: 'EX-100 fault-injection evaluation EX-FI-2026-01',
      bullets: ['Laser fault injection on the boot ROM', 'No exploitable faults found'],
      indexers: ['part:EX-100', 'test:EX-FI-2026-01'],
      identifier: 'EX-FI-2026-01',
      artifacts: [{ path: 'reports/fi-eval-v1.1.pdf', alt: 'FI evaluation v1.1 (PDF)' }],
      bind_to: [{ ref: 'product:ex-100', label: 'Fault-injection test' }],
      sources: ['reports/fi-eval-v1.1.pdf'],
    },
  ],
} as const

/** The product content the example composes to, byte for byte. */
export const GUIDE_EXAMPLE_PRODUCT_CONTENT = [
  'Example Corp EX-100 secure element',
  '',
  '- RISC-V core with a hardware crypto accelerator',
  '',
  'Record card (JSON): {"vendor":"Example Corp","part":"EX-100"}',
].join('\n')

export const PUBLISHER_GUIDE = `# Publishing to SCRUTINY Fabric

This guide is for the agent. Read it before drafting the first plan.

## The event model

- **Profile** (one per publisher): name, display name, about, picture. Lens shows it as the
  publisher.
- **Product**: a thing a user searches for: a chip, a module, a firmware line, a library. Lens
  result cards are products.
- **Metadata**: one document or fact about products: a specification, test, report, advisory,
  SBOM, maintenance note or evaluation target (\`subtype\`). It carries the files (\`artifacts\`).
- **Binding**: an edge from a metadata record to a product, with a short label (at most 28
  characters; Lens shows it on the files rail). You write \`bind_to\` on the metadata record; the
  server makes one binding event per entry. Several entries make a shared record, shown as a bridge
  between products.

## Choosing products

Ask the user which things people would search for. A product family and its parts can each be a
product if users search for both; otherwise prefer the part. Every metadata record must bind to at
least one product, or Lens never shows it.

## Indexers

Indexers are the exact spellings users and tools search on, \`prefix:value\`, with the value as the
issuing authority writes it (\`cve:CVE-2017-15361\`, \`part:EX-100\`). Known prefixes: ${PREFIX_TABLE}.
Other prefixes are allowed but rarely found. List only what the record is *about*. Indexers are
permanent (IX-3): they cannot be changed after publishing.

## Prose and the record card

Write a one-line headline and short one-line bullets: plain facts from the sources, nothing
invented. The optional \`card\` holds flat machine-readable facts; every card value and every
indexer value must also appear in the headline, bullets or links (rule 2a). The server checks
this and asks; it never rewrites your prose.

## Files and versions

Artifacts are uploaded to the primary relay, or cited at the publisher's own HTTPS URL, which the
server checks against the local file. A file cannot be added to a record later. Ask the user how to
handle drafts and superseded versions: one record holding several versions, or one record per
version.

## The interview loop

1. Draft a plan from the files, citing \`sources\` for every record.
2. Call \`draft_plan\`. Show the preview. Ask every open question with \`ask_user: true\`.
3. Revise and draft again until \`ready\` is true. Then call \`publish_plan\`.

Questions the server cannot detect, which you ask yourself: what users search for, family versus
part, each document's subtype, how to treat drafts and old versions, and the edge labels.

## Lens checklist

- One profile with a display name.
- Every metadata record bound to a product, with a label of at most 28 characters.
- Every file has an \`alt\` text of at most 60 characters.
- Headlines read well when truncated: the most specific words first.
- A published record is found in Lens (\`${LENS_URL}\`) by searching one of its indexer values — the
  event's \`i\` tag, written \`prefix:value\` — which Lens looks up exactly: searching
  \`part:EX-100\` returns the records carrying \`["i","part:EX-100"]\`. So an indexer nobody would
  type is a record nobody finds.

## Worked example (invented vendor)

\`\`\`json
${JSON.stringify(GUIDE_EXAMPLE_PLAN, null, 2)}
\`\`\`

The product above is published with exactly this content:

\`\`\`text
${GUIDE_EXAMPLE_PRODUCT_CONTENT}
\`\`\`
`
