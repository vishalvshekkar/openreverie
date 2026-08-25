// The system prompt's character budget.
//
// Measured in characters, not tokens. There is no tokenizer anywhere in this
// repository, so a budget in tokens would be a number nothing could check.
// The working assumption behind the numbers below is roughly four characters
// per token for English prose, and that assumption is stated rather than
// asserted: everything here counts characters.
//
// Every cap is hard and applied independently. There is no cross-section
// arbitration, so the assembled body can never exceed the sum below and no
// runtime priority ordering is ever needed. A global squeeze, where sections
// yield to each other against a total, would make each section's content
// depend on the size of unrelated sections: the same constitution would
// render differently depending on how many people exist, which is
// unpleasant to reason about and worse to test.
//
// The persona is excluded from the budget: it is authored, fixed in size,
// and cannot grow with use.

// profile.md's prose body. Owned and enforced by the modes spec
// (2026-08-16-modes-profile-settings-design.md, section 3.2), which caps it
// at prompt-assembly time with its own truncation marker. It is carried here
// only so the running total accounts for it. capBody is deliberately not
// applied to it: profile.md is unindexed by design, so it has no docId to
// hand back, and a marker without a fetch key is correct only where no read
// path through any tool exists.
export const PROFILE_BODY_CAP = 2000

export const CONSTITUTION_CAP = 6000
export const REALMS_SECTION_CAP = 4000
export const REALM_FIRST_LINE_CAP = 160
export const ARCS_SECTION_CAP = 2000
export const PEOPLE_SECTION_CAP = 2500
export const ENTITIES_SECTION_CAP = 1200
export const RECENT_INTENTIONS_SECTION_CAP = 800
// The "## Commitments" section (context.ts): per commitment, its label, the
// person's own timing words, the date they said it, and the gloss when
// reflection wrote one. Sized the same as RECENT_INTENTIONS_SECTION_CAP
// above, since both render a short, capped listing of a handful of one or
// two line entries, not a prose body. Never the bracket that decided
// eligibility: spec Section 3, "the bracket selects, the gloss speaks."
export const COMMITMENTS_SECTION_CAP = 800
export const LATEST_DAILY_ROLLUP_CAP = 2500
export const ROLLUPS_AVAILABLE_CAP = 800
export const RECENT_SUMMARIES_SECTION_CAP = 6000
// Three summaries at 2,000 characters each is the section cap above.
export const RECENT_SUMMARY_CAP = 2000

// The target for the whole assembled body. Not runtime behavior: nothing
// measures the finished prompt against it. It is an invariant asserted by a
// test over the constants, which fails if anyone raises a cap past the
// total. Raised from 28000 to 28800 when COMMITMENTS_SECTION_CAP was added:
// a deliberate increase to the budget, not an incidental one, made in the
// same change that added the section it makes room for.
export const PROMPT_BUDGET_TOTAL = 28800

// Every character cap that contributes to the assembled body, in prompt
// order. Row caps (ARCS_CAP, PEOPLE_CAP, ENTITIES_CAP) are deliberately
// absent: they bound row counts, not characters.
export const SECTION_CAPS: number[] = [
  PROFILE_BODY_CAP,
  CONSTITUTION_CAP,
  REALMS_SECTION_CAP,
  ARCS_SECTION_CAP,
  PEOPLE_SECTION_CAP,
  ENTITIES_SECTION_CAP,
  RECENT_INTENTIONS_SECTION_CAP,
  COMMITMENTS_SECTION_CAP,
  LATEST_DAILY_ROLLUP_CAP,
  ROLLUPS_AVAILABLE_CAP,
  RECENT_SUMMARIES_SECTION_CAP,
]

// Cuts a prose body to `limit` characters and, when it cuts, appends a
// marker naming the docId that fetches the whole thing. The docId is
// required, not decorative: a truncation marker without one tells the model
// something exists and gives it no way to reach it.
//
// The cut is from the start of the body forward, at the last paragraph
// boundary at or before the limit, or at the limit itself when there is no
// boundary before it. Keeping the head rather than the tail is deliberate
// for the constitution, whose opening carries the most stable identity
// material, and neutral for rollups and summaries, which are narrative.
//
// This applies to assembleSystemPrompt only. It must never be applied to the
// constitution in the reflection path: reflection emits its constitution
// update as a complete replacement body, so a model shown a truncated
// constitution and asked to produce the updated one deletes the tail it
// never saw from disk.
export function capBody(
  body: string,
  limit: number,
  docId: string,
): { text: string; truncated: boolean } {
  if (body.length <= limit) {
    return { text: body, truncated: false }
  }
  const head = body.slice(0, limit)
  const lastBoundary = head.lastIndexOf('\n\n')
  const kept = lastBoundary > 0 ? body.slice(0, lastBoundary) : head
  const marker =
    `(truncated: showing the first ${kept.length.toLocaleString('en-US')} of ` +
    `${body.length.toLocaleString('en-US')} characters. Call read_document with docId ${docId} ` +
    'for the full text.)'
  return { text: `${kept}\n\n${marker}`, truncated: true }
}

// Keeps as many leading rows as fit in `limit` characters, counting the
// newline that joins each row to the one before it. Callers compare `shown`
// against the true total to decide whether to render a truncation marker,
// so this function never renders one itself: the marker wording differs per
// section and always names the tool that reaches the rest.
export function capRows(rows: string[], limit: number): { rows: string[]; shown: number } {
  const kept: string[] = []
  let used = 0
  for (const row of rows) {
    const cost = kept.length === 0 ? row.length : row.length + 1
    if (used + cost > limit) break
    kept.push(row)
    used += cost
  }
  return { rows: kept, shown: kept.length }
}
