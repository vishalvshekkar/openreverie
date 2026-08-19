import { describe, expect, it } from 'vitest'
import {
  AGENT_ACTIVITY_LEVEL_GUIDANCE,
  buildJournalModeParagraph,
  CADENCE_DISCLOSURE_INSTRUCTION,
  EXPRESSIVE_WRITING_SAFETY_GATE,
  FIRST_TIME_SETUP_GUIDANCE,
  JOURNAL_FORMAT_CONTENT,
  JOURNAL_MODE_ENGAGEMENT_CLAUSE,
  JOURNAL_MODE_ORIENTATION_CLAUSE,
  PER_METHOD_SAFETY_NOTES,
} from './journaling.js'

describe('journal format content, evidence stated honestly', () => {
  it('expressive writing states a real, replicated, small average effect, not a cure', () => {
    const content = JOURNAL_FORMAT_CONTENT.expressive_writing
    expect(content.evidence).toContain('200 studies')
    expect(content.evidence).toContain('d = 0.16')
    expect(content.evidence).not.toMatch(/guarantee/i)
    expect(content.evidence).toMatch(/not a cure/i)
  })

  it('gratitude states the wallpaper effect and that the original study was weekly, not daily', () => {
    const content = JOURNAL_FORMAT_CONTENT.gratitude
    expect(content.evidence).toContain('weekly')
    expect(content.evidence).toContain('wallpaper effect')
    expect(content.evidence).toMatch(/3 to 4|three to four/)
  })

  it('the examen is described as thin but suggestive, one small study, not borrowed weight', () => {
    const content = JOURNAL_FORMAT_CONTENT.examen
    expect(content.evidence).toMatch(/thin/i)
    expect(content.evidence).toContain('n = 57')
    expect(content.evidence).not.toMatch(/well.?evidenced|well.?studied/i)
  })

  it('the thought record separates the general CBT evidence base from the worksheet in isolation', () => {
    const content = JOURNAL_FORMAT_CONTENT.thought_record
    expect(content.evidence).toMatch(/enormous evidence base/i)
    expect(content.evidence).toMatch(/thinly studied on its own|not separately validated/i)
  })

  it('morning pages states plainly that there are no clinical studies at all', () => {
    const content = JOURNAL_FORMAT_CONTENT.morning_pages
    expect(content.evidence).toMatch(/no clinical studies|never studied/i)
  })

  it('open format states that no evidence question applies to it', () => {
    const content = JOURNAL_FORMAT_CONTENT.open
    expect(content.evidence).toMatch(/not applicable|no research question/i)
  })

  it('every format label is a plain word, not the internal method key', () => {
    for (const method of Object.keys(
      JOURNAL_FORMAT_CONTENT,
    ) as (keyof typeof JOURNAL_FORMAT_CONTENT)[]) {
      expect(JOURNAL_FORMAT_CONTENT[method].label).not.toBe(method)
      expect(JOURNAL_FORMAT_CONTENT[method].label).not.toContain('_')
    }
  })

  it('gratitude carries exactly the shippable prompt sequence from the spec', () => {
    expect(JOURNAL_FORMAT_CONTENT.gratitude.prompts.length).toBeGreaterThanOrEqual(1)
    expect(JOURNAL_FORMAT_CONTENT.gratitude.prompts[0]).toMatch(/genuinely glad happened/)
  })

  it('the thought record prompt sequence accepts "I cannot find one yet" as a valid, complete answer', () => {
    const prompts = JOURNAL_FORMAT_CONTENT.thought_record.prompts.join(' ')
    expect(prompts).toMatch(/I can't find one yet|I cannot find one yet/)
  })
})

describe('cadence disclosure', () => {
  it('states the wallpaper-effect finding and instructs saying it once, then accepting the choice', () => {
    expect(CADENCE_DISCLOSURE_INSTRUCTION).toMatch(/three to four times a week|3 to 4 times a week/)
    expect(CADENCE_DISCLOSURE_INSTRUCTION).toMatch(/once/i)
    expect(CADENCE_DISCLOSURE_INSTRUCTION).not.toMatch(/every session|each time/i)
    expect(CADENCE_DISCLOSURE_INSTRUCTION).toMatch(/not a recurring nag/i)
  })
})

describe('expressive writing safety gate', () => {
  it('instructs a crisis check before expressive writing is offered or started', () => {
    expect(EXPRESSIVE_WRITING_SAFETY_GATE).toMatch(/crisis|suicidal/i)
    expect(EXPRESSIVE_WRITING_SAFETY_GATE).toMatch(
      /before (it|expressive writing) (is|can be) offered|before offering/i,
    )
  })

  it('instructs against offering it for very recent or acute trauma', () => {
    expect(EXPRESSIVE_WRITING_SAFETY_GATE).toMatch(/acute|very recent/i)
  })

  it('requires the grounding close unconditionally, every session using this method', () => {
    expect(EXPRESSIVE_WRITING_SAFETY_GATE).toMatch(/grounding|small, true thing/i)
  })
})

describe('per-method safety notes', () => {
  it('examen step 3 is skippable, with no pressure to resolve it in-session', () => {
    expect(PER_METHOD_SAFETY_NOTES.examen).toMatch(/skippable/i)
    expect(PER_METHOD_SAFETY_NOTES.examen).toMatch(/no pressure/i)
  })

  it('the thought record note forbids pushing for a positive reframe once the person has said they cannot find one', () => {
    expect(PER_METHOD_SAFETY_NOTES.thought_record).toMatch(/do not push|not push/i)
  })

  it('gratitude states plainly it has no method-specific gate', () => {
    expect(PER_METHOD_SAFETY_NOTES.gratitude).toMatch(/no method-specific gate/i)
  })

  it('morning pages and open format both name the ordinary crisis pathway, with no method-specific gate beyond it', () => {
    expect(PER_METHOD_SAFETY_NOTES.morning_pages).toMatch(/crisis judgment/i)
    expect(PER_METHOD_SAFETY_NOTES.open).toMatch(/crisis judgment/i)
  })
})

describe('agent activity level', () => {
  it('explains the axis is separate from style.engagement', () => {
    expect(AGENT_ACTIVITY_LEVEL_GUIDANCE).toMatch(/style\.engagement|separate from/i)
  })
})

describe('first-time setup guidance', () => {
  it('never presents journaling as a substitute for therapy', () => {
    expect(FIRST_TIME_SETUP_GUIDANCE).toMatch(/n(ot|ever) a substitute for therapy/i)
  })

  it('names the examen as the reasonable default when nothing points elsewhere', () => {
    expect(FIRST_TIME_SETUP_GUIDANCE).toMatch(/examen.*default|default.*examen/is)
  })
})

describe('buildJournalModeParagraph', () => {
  it('always contains the expressive writing safety gate, regardless of journaling.md content', () => {
    const paragraph = buildJournalModeParagraph('Gratitude, three times a week.')
    expect(paragraph).toContain(EXPRESSIVE_WRITING_SAFETY_GATE)
  })

  it('always contains the cadence disclosure instruction', () => {
    const paragraph = buildJournalModeParagraph('Examen, most evenings.')
    expect(paragraph).toContain(CADENCE_DISCLOSURE_INSTRUCTION)
  })

  it('includes the journaling.md content it was given', () => {
    const paragraph = buildJournalModeParagraph('A specific configured protocol, verbatim.')
    expect(paragraph).toContain('A specific configured protocol, verbatim.')
  })

  it("includes every method's per-method safety note, examen's skippability included", () => {
    const paragraph = buildJournalModeParagraph('Examen, most evenings.')
    expect(paragraph).toContain(PER_METHOD_SAFETY_NOTES.examen)
    expect(paragraph).toContain(PER_METHOD_SAFETY_NOTES.thought_record)
  })

  it('covers both axes journal mode suppresses: engagement and orientation', () => {
    expect(JOURNAL_MODE_ENGAGEMENT_CLAUSE.length).toBeGreaterThan(0)
    expect(JOURNAL_MODE_ORIENTATION_CLAUSE.length).toBeGreaterThan(0)
  })
})
