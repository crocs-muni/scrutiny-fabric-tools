/**
 * The composition surface the #108 handlers call (#108 A4).
 *
 * `content.ts` is the byte-faithful mirror port (rule 8 + rule 2a checker); `event.ts` is the
 * server's restate-and-verify layer on top of it. Handlers import from here, never from the port
 * directly, so the "compose then check" order cannot be skipped by accident.
 */

export {
  CompositionError,
  RECORD_CARD_LABEL,
  assertNoLostFacts,
  composeContent,
  lostFacts,
  normalizeProse,
  oneLine,
} from './content.ts'
export {
  composeBindingContent,
  composeIndexed,
  imetaTags,
  type ComposeImeta,
} from './event.ts'
