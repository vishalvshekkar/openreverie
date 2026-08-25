import { JOURNALING_PROTOCOL_ABSENT, PROSE_VOICE_RULE } from '@openreverie/memory'
import { describe, expect, it } from 'vitest'
import { type CrisisResource, defaultCrisisResources, type StyleConfig } from './config.js'
import { EXPRESSIVE_WRITING_SAFETY_GATE } from './journaling.js'
import { MODE_NAMES, MODES, modeOverrides, modeParagraph } from './modes.js'
import { buildPersona } from './personas.js'

const resources: CrisisResource[] = [
  { label: '988 Suicide and Crisis Lifeline (US)', contact: 'Call or text 988' },
  { label: 'Find A Helpline (international)', contact: 'findahelpline.com' },
]

const defaultStyle: StyleConfig = { engagement: 'balanced', tone: 'warm', orientation: 'listening' }

// The first sentence of CRISIS_DETECTION, which opens both crisis stances
// and appears nowhere else in either persona.
const CRISIS_MARKER = 'Deciding whether a conversation has moved into crisis territory'

function toneParagraphText(tone: StyleConfig['tone']): string {
  return buildPersona('companion', defaultCrisisResources, { ...defaultStyle, tone })
    .split('\n\n')
    .filter((paragraph) => paragraph.startsWith('Your configured tone is'))
    .join('')
}

function sharedPrefix(a: string, b: string): string {
  let length = 0
  const shorter = Math.min(a.length, b.length)
  while (length < shorter && a[length] === b[length]) {
    length += 1
  }
  return a.slice(0, length)
}

describe('buildPersona', () => {
  it('renders every resource label and contact in companion mode', () => {
    const text = buildPersona('companion', resources, defaultStyle)
    for (const resource of resources) {
      expect(text).toContain(resource.label)
      expect(text).toContain(resource.contact)
    }
  })

  it('renders every resource label and contact in firewall mode', () => {
    const text = buildPersona('firewall', resources, defaultStyle)
    for (const resource of resources) {
      expect(text).toContain(resource.label)
      expect(text).toContain(resource.contact)
    }
  })

  it('companion mode stays present and does not instruct refusing or declining to engage', () => {
    const text = buildPersona('companion', resources, defaultStyle)
    expect(text).toMatch(/stay/i)
    // Companion mode refuses nothing: it must never instruct the model to
    // decline or refuse to continue talking with the person.
    expect(text.toLowerCase()).not.toMatch(/\b(refuse|decline)s? to (continue|engage|keep|talk)/)
  })

  it('firewall mode instructs declining to continue the crisis thread', () => {
    const text = buildPersona('firewall', resources, defaultStyle)
    expect(text.toLowerCase()).toMatch(/decline to continue/)
  })

  it('shares an identical, substantial prefix between modes, differing only in the crisis stance', () => {
    const companion = buildPersona('companion', resources, defaultStyle)
    const firewall = buildPersona('firewall', resources, defaultStyle)

    expect(companion).not.toEqual(firewall)

    const prefix = sharedPrefix(companion, firewall)

    // Shared prefix must be substantial: what reverie is, what it is not,
    // retrieve-before-asserting, the never-ask rule, the memory
    // orientation, conversational voice, style axis guidance, and even the
    // crisis detection judgment itself are identical text, built from the
    // same shared parts. Only the stance taken once danger is judged real
    // differs.
    expect(prefix.length).toBeGreaterThan(400)

    const prefixLower = prefix.toLowerCase()
    expect(prefixLower).toContain('not a therapist')
    expect(prefixLower).toMatch(/search|retriev/)
    expect(prefixLower).toContain('never ask permission')
    expect(prefixLower).toContain('crisis territory')
  })

  it('never contains an em dash character', () => {
    for (const mode of ['companion', 'firewall'] as const) {
      for (const tone of ['warm', 'playful', 'snarky', 'direct', 'formal'] as const) {
        const text = buildPersona(mode, resources, { ...defaultStyle, tone })
        expect(text).not.toContain('—')
      }
    }
  })

  // The tone-only loop above never renders a mode paragraph (activeMode
  // defaults to 'general'), so it cannot catch an em dash introduced by a
  // mode's own clause text (the cadence notes added to real, listen, and
  // journal, in particular). Every mode, both safety modes, checked here.
  it('never contains an em dash character, for any mode, in either safety mode', () => {
    for (const safety of ['companion', 'firewall'] as const) {
      for (const name of MODE_NAMES) {
        const text = buildPersona(
          safety,
          resources,
          defaultStyle,
          name,
          'A configured protocol, verbatim.',
        )
        expect(text, `${safety}/${name}`).not.toContain('—')
      }
    }
  })

  describe('prose voice rule', () => {
    it('carries the shared prose-mechanics rule in both companion and firewall prompts', () => {
      const companion = buildPersona('companion', resources, defaultStyle)
      const firewall = buildPersona('firewall', resources, defaultStyle)
      expect(companion).toContain(PROSE_VOICE_RULE)
      expect(firewall).toContain(PROSE_VOICE_RULE)
    })

    it('states plainly that it governs mechanics only and does not soften the mode', () => {
      const persona = buildPersona('companion', resources, defaultStyle)
      expect(persona).toContain('governs sentence mechanics only')
      expect(persona).toContain('does not soften a stance')
      expect(persona).toContain('the mode you are in')
    })

    it('instructs avoiding em dashes concretely, not just "write naturally"', () => {
      const persona = buildPersona('companion', resources, defaultStyle)
      expect(persona).toContain('Do not use an em dash')
      expect(persona).toContain('comma, a period, a colon, or parentheses')
    })

    it('is part of the identical shared prefix between safety modes', () => {
      const companion = buildPersona('companion', resources, defaultStyle)
      const firewall = buildPersona('firewall', resources, defaultStyle)
      const marker = 'How you write: this rule governs sentence mechanics only'
      expect(companion.slice(0, companion.indexOf(marker) + marker.length)).toEqual(
        firewall.slice(0, firewall.indexOf(marker) + marker.length),
      )
    })
  })

  it('explains what reverie is and is not, in both modes', () => {
    for (const mode of ['companion', 'firewall'] as const) {
      const text = buildPersona(mode, resources, defaultStyle)
      expect(text.toLowerCase()).toContain('not a therapist')
    }
  })

  it('states the retrieve-before-asserting rule, in both modes', () => {
    for (const mode of ['companion', 'firewall'] as const) {
      const text = buildPersona(mode, resources, defaultStyle)
      expect(text.toLowerCase()).toMatch(/search|retriev/)
    }
  })

  it('states the never-ask rule plainly, in both modes: never ask permission to remember something', () => {
    for (const mode of ['companion', 'firewall'] as const) {
      const text = buildPersona(mode, resources, defaultStyle)
      expect(text.toLowerCase()).toContain('never ask permission')
      expect(text.toLowerCase()).toContain('use the remember tool silently')
    }
  })

  it('never instructs raising pending proposals or asking to remember something', () => {
    for (const mode of ['companion', 'firewall'] as const) {
      const text = buildPersona(mode, resources, defaultStyle).toLowerCase()
      expect(text).not.toContain('pending proposal')
      expect(text).not.toContain('resolve_proposal')
    }
  })

  it('gives a plain orientation to the memory architecture: transcripts, items, summaries, rollups, arcs, realms, nodes, pages, entities, constitution, and the graph', () => {
    for (const mode of ['companion', 'firewall'] as const) {
      const text = buildPersona(mode, resources, defaultStyle).toLowerCase()
      expect(text).toContain('verbatim transcripts')
      expect(text).toContain('observation, a feeling, an event, or an intention')
      expect(text).toContain('summary written for each session')
      expect(text).toContain('daily and then weekly rollups')
      expect(text).toContain('ongoing storylines')
      expect(text).toContain('life domains')
      expect(text).toContain('living record of who this person is')
      expect(text).toContain('graph.jsonl')
      expect(text).toContain('testimony')
      // A node and a page are different things (the substantive change
      // this orientation must cover): a node is the cheap, generously
      // created graph record; a page is the maintained document granted
      // only once earned. Entities are the non-person node type.
      expect(text).toContain('node in the graph')
      expect(text).toContain('maintained document')
      expect(text).toContain('entity such as a film')
    }
  })

  it('does not tell the model it maintains an arc itself: only reflection writes an arc narrative, after the session ends', () => {
    for (const mode of ['companion', 'firewall'] as const) {
      const text = buildPersona(mode, resources, defaultStyle).toLowerCase()
      expect(text).not.toContain('ongoing storylines you maintain')
      expect(text).toContain('written and rewritten only by reflection after a session ends')
    }
  })

  // The forget feature is parked: reverie must not claim a capability it
  // does not currently offer. No persona text should mention forgetting.
  it('never mentions a forget capability: the feature is parked, not shipped', () => {
    for (const mode of ['companion', 'firewall'] as const) {
      const text = buildPersona(mode, resources, defaultStyle)
      expect(text.toLowerCase()).not.toContain('forget')
    }
  })

  it('renders correctly with an empty resource list', () => {
    expect(() => buildPersona('companion', [], defaultStyle)).not.toThrow()
    expect(() => buildPersona('firewall', [], defaultStyle)).not.toThrow()
  })

  it('renders a resource label with $ replacement sequences literally instead of leaking the template', () => {
    const trickyResources: CrisisResource[] = [
      { label: 'Weird $& and $` line', contact: 'Call 555-0100' },
    ]
    for (const mode of ['companion', 'firewall'] as const) {
      const text = buildPersona(mode, trickyResources, defaultStyle)
      expect(text).toContain('Weird $& and $` line')
      expect(text).not.toContain('{{RESOURCES}}')
    }
  })

  describe('conversational voice', () => {
    it('establishes one topic at a time, drawn out with real follow-up questions', () => {
      const text = buildPersona('companion', resources, defaultStyle).toLowerCase()
      expect(text).toContain('one topic at a time')
      expect(text).toContain('follow-up')
    })

    it('caps questions at one or two per turn', () => {
      const text = buildPersona('companion', resources, defaultStyle).toLowerCase()
      expect(text).toContain('one or two questions')
    })

    it('forbids option menus, numbered plans, and time-blocked schedules unless explicitly asked', () => {
      const text = buildPersona('companion', resources, defaultStyle).toLowerCase()
      expect(text).toContain('bullet-point')
      expect(text).toContain('numbered plan')
      expect(text).toContain('schedule')
      expect(text).toContain('time block')
      expect(text).toContain('explicitly ask')
    })

    it('requires a personal register for family, relationships, grief, and health, not project framing', () => {
      const text = buildPersona('companion', resources, defaultStyle).toLowerCase()
      expect(text).toContain('personal register')
      expect(text).toContain('family')
      expect(text).toContain('relationship')
      expect(text).toContain('grief')
      expect(text).toContain('health')
      expect(text).toContain('action item')
    })

    it('instructs a purposeful segue instead of a new questionnaire when a thread completes', () => {
      const text = buildPersona('companion', resources, defaultStyle).toLowerCase()
      expect(text).toContain('segue')
      expect(text).toContain('questionnaire')
    })

    it('is concise by default and only goes deeper when invited', () => {
      const text = buildPersona('companion', resources, defaultStyle).toLowerCase()
      expect(text).toContain('concise by default')
      expect(text).toContain('invite')
    })
  })

  describe('style axes', () => {
    it('renders distinct text for each engagement value', () => {
      const leading = buildPersona('companion', resources, {
        ...defaultStyle,
        engagement: 'leading',
      })
      const balanced = buildPersona('companion', resources, {
        ...defaultStyle,
        engagement: 'balanced',
      })
      const following = buildPersona('companion', resources, {
        ...defaultStyle,
        engagement: 'following',
      })

      expect(leading.toLowerCase()).toContain('engagement is leading')
      expect(balanced.toLowerCase()).toContain('engagement is balanced')
      expect(following.toLowerCase()).toContain('engagement is following')
      expect(leading).not.toEqual(balanced)
      expect(balanced).not.toEqual(following)
      expect(leading).not.toEqual(following)
    })

    it('renders distinct text for each tone value, with snarky never applying at the user’s expense', () => {
      const tones: StyleConfig['tone'][] = ['warm', 'playful', 'snarky', 'direct', 'formal']
      const texts = tones.map((tone) =>
        buildPersona('companion', resources, { ...defaultStyle, tone }),
      )

      for (const [i, tone] of tones.entries()) {
        expect(texts[i]?.toLowerCase()).toContain(`tone is ${tone}`)
      }
      const unique = new Set(texts)
      expect(unique.size).toBe(tones.length)

      const snarkyText = texts[tones.indexOf('snarky')] ?? ''
      expect(snarkyText.toLowerCase()).toContain("never at the user's expense")
    })

    it('renders distinct text for each orientation value', () => {
      const listening = buildPersona('companion', resources, {
        ...defaultStyle,
        orientation: 'listening',
      })
      const balanced = buildPersona('companion', resources, {
        ...defaultStyle,
        orientation: 'balanced',
      })
      const solutions = buildPersona('companion', resources, {
        ...defaultStyle,
        orientation: 'solutions',
      })

      expect(listening.toLowerCase()).toContain('orientation is listening')
      expect(balanced.toLowerCase()).toContain('orientation is balanced')
      expect(solutions.toLowerCase()).toContain('orientation is solutions')
      expect(listening).not.toEqual(balanced)
      expect(balanced).not.toEqual(solutions)
      expect(listening).not.toEqual(solutions)
    })

    it('states that crisis behavior always outranks the configured tone, in both modes', () => {
      const snarkyStyle: StyleConfig = { ...defaultStyle, tone: 'snarky' }
      for (const mode of ['companion', 'firewall'] as const) {
        const text = buildPersona(mode, resources, snarkyStyle).toLowerCase()
        expect(text).toContain('crisis territory')
        expect(text).toContain('yields')
      }
    })

    it('states that personal-register rule outranks the orientation setting on personal topics when orientation is solutions', () => {
      const solutionsStyle: StyleConfig = { ...defaultStyle, orientation: 'solutions' }
      const text = buildPersona('companion', resources, solutionsStyle).toLowerCase()
      expect(text).toContain('personal-register rule outranks the orientation setting')
    })
  })
})

describe('stance doctrine', () => {
  it('tells the model to use they/them until told otherwise', () => {
    const persona = buildPersona('companion', defaultCrisisResources, defaultStyle)
    expect(persona).toContain('they/them until')
    expect(persona).toContain('Never assume gender, age, or pronouns')
  })

  it("extends the rule to third parties in the user's life", () => {
    const persona = buildPersona('companion', defaultCrisisResources, defaultStyle)
    expect(persona).toContain('not only to the user')
  })

  it("forbids a default shape for someone's life", () => {
    const persona = buildPersona('companion', defaultCrisisResources, defaultStyle)
    expect(persona).toContain('living situation')
    expect(persona).toContain('life stage')
  })

  it('is in the shared prefix, identical in both safety modes', () => {
    const companion = buildPersona('companion', defaultCrisisResources, defaultStyle)
    const firewall = buildPersona('firewall', defaultCrisisResources, defaultStyle)
    const marker = 'Never assume gender, age, or pronouns'
    expect(companion.slice(0, companion.indexOf(marker) + marker.length)).toEqual(
      firewall.slice(0, firewall.indexOf(marker) + marker.length),
    )
  })
})

describe('birthday greetings consent', () => {
  it('names the one exception to the no-narration rule', () => {
    const persona = buildPersona('companion', defaultCrisisResources, defaultStyle)
    expect(persona).toContain('birthday')
    expect(persona).toContain('one sentence')
    expect(persona).toContain('never ask again')
  })

  it('still forbids narrating anything else that was remembered', () => {
    const persona = buildPersona('companion', defaultCrisisResources, defaultStyle)
    expect(persona).toContain('Never ask permission to remember something')
  })

  it('tells the model never to ask for a birthday', () => {
    const persona = buildPersona('companion', defaultCrisisResources, defaultStyle)
    expect(persona).toContain('Never ask someone for their birthday')
  })

  it('keeps the exception in the shared prefix, identical in both safety modes', () => {
    const companion = buildPersona('companion', defaultCrisisResources, defaultStyle)
    const firewall = buildPersona('firewall', defaultCrisisResources, defaultStyle)
    const marker = 'Never ask someone for their birthday'
    expect(companion.slice(0, companion.indexOf(marker) + marker.length)).toEqual(
      firewall.slice(0, firewall.indexOf(marker) + marker.length),
    )
  })
})

describe('mode overlay', () => {
  const ENGAGEMENT_MARKER = 'Your configured engagement is'
  const TONE_MARKER = 'Your configured tone is'
  const ORIENTATION_MARKER = 'Your configured orientation is'

  it('suppresses exactly the axes each mode overrides, and keeps the rest verbatim', () => {
    for (const name of MODE_NAMES) {
      const persona = buildPersona('companion', defaultCrisisResources, defaultStyle, name)
      const overridden = modeOverrides(name)
      expect(persona.includes(ENGAGEMENT_MARKER), `${name} engagement`).toBe(
        !overridden.includes('engagement'),
      )
      expect(persona.includes(ORIENTATION_MARKER), `${name} orientation`).toBe(
        !overridden.includes('orientation'),
      )
      const paragraph = modeParagraph(name)
      if (paragraph === undefined) continue
      for (const clause of Object.values(MODES[name].clauses)) {
        expect(persona.includes(clause), `${name} clause`).toBe(true)
      }
    }
  })

  it('never suppresses tone, for any mode and any tone value', () => {
    const tones: StyleConfig['tone'][] = ['warm', 'playful', 'snarky', 'direct', 'formal']
    for (const name of MODE_NAMES) {
      for (const tone of tones) {
        const persona = buildPersona(
          'companion',
          defaultCrisisResources,
          { ...defaultStyle, tone },
          name,
        )
        expect(persona.includes(TONE_MARKER), `${name}/${tone}`).toBe(true)
        expect(persona.includes(toneParagraphText(tone)), `${name}/${tone}`).toBe(true)
      }
    }
  })

  it('states the precedence order once a mode is active', () => {
    const persona = buildPersona('companion', defaultCrisisResources, defaultStyle, 'solve')
    expect(persona).toContain('this order decides, highest first')
  })

  it('says nothing about precedence in general mode', () => {
    const persona = buildPersona('companion', defaultCrisisResources, defaultStyle, 'general')
    expect(persona).not.toContain('this order decides, highest first')
  })

  // Guard, not a falsification: this passes with the mode feature entirely
  // absent. It guards against general quietly growing a paragraph of its own.
  it('Guard: general is byte-identical to no mode at all', () => {
    expect(buildPersona('companion', defaultCrisisResources, defaultStyle, 'general')).toEqual(
      buildPersona('companion', defaultCrisisResources, defaultStyle),
    )
  })
})

describe('journal mode threading', () => {
  // The generic mode-overlay loops above only check that the two static
  // clauses land somewhere in the persona, which was also true of the old
  // placeholder text they replaced. This checks the actual dynamic content
  // modeSection substitutes for journal (the safety gate, and the session's
  // own journaling protocol threaded through buildPersona's 5th argument)
  // really reaches the rendered persona, not just the two clause strings
  // that also happen to be duplicated inside it.
  it('renders the expressive writing safety gate and the passed journaling protocol', () => {
    const persona = buildPersona(
      'companion',
      defaultCrisisResources,
      defaultStyle,
      'journal',
      'A configured protocol, verbatim.',
    )
    expect(persona).toContain(EXPRESSIVE_WRITING_SAFETY_GATE)
    expect(persona).toContain('A configured protocol, verbatim.')
  })
})

describe('safety invariant', () => {
  // Position plus bytes, not presence. A naive "the crisis text is still in
  // there" assertion passes even when the mode paragraph is appended after
  // the crisis stance, which reads to the model as amending it.
  it('keeps the crisis section last and byte-identical, for all ten modes and both safety modes', () => {
    for (const safety of ['companion', 'firewall'] as const) {
      const baseline = buildPersona(safety, defaultCrisisResources, defaultStyle)
      const baselineCrisis = baseline.slice(baseline.indexOf(CRISIS_MARKER))
      expect(baselineCrisis.length).toBeGreaterThan(200)
      for (const name of MODE_NAMES) {
        const persona = buildPersona(safety, defaultCrisisResources, defaultStyle, name)
        expect(persona.endsWith(baselineCrisis), `${safety}/${name} position`).toBe(true)
        expect(persona.slice(-baselineCrisis.length), `${safety}/${name} bytes`).toEqual(
          baselineCrisis,
        )
      }
    }
  })

  it('names mode in the sentence that says style is not a permission slip', () => {
    const persona = buildPersona('companion', defaultCrisisResources, defaultStyle, 'real')
    expect(persona).toContain('Tone, engagement, orientation, and mode are configured')
    expect(persona).toContain('mode yields entirely')
  })

  it('keeps the shared prefix identical across safety modes with a mode active', () => {
    const companion = buildPersona('companion', defaultCrisisResources, defaultStyle, 'deep')
    const firewall = buildPersona('firewall', defaultCrisisResources, defaultStyle, 'deep')
    const cut = (text: string) => text.slice(0, text.indexOf(CRISIS_MARKER))
    expect(cut(companion)).toEqual(cut(firewall))
  })
})

describe('journal mode never weakens the crisis stance', () => {
  // Position plus bytes, against a journal-mode arm with real, non-trivial
  // content, across every combination of {companion, firewall} safety mode
  // and {no mode, journal mode with a real journaling.md fixture, journal
  // mode with journaling.md absent}. A presence-only assertion ("the crisis
  // text appears somewhere") is anti-falsifiable here: it gets stronger, not
  // weaker, if journal mode's own prompt construction is deleted entirely,
  // because there is then nothing left that could plausibly displace the
  // crisis text.
  const journalingFixture =
    'Gratitude, three times a week, prompted, roughly ten minutes, active nudging.'

  function crisisSectionOf(persona: string): string {
    return persona.slice(persona.indexOf(CRISIS_MARKER))
  }

  for (const safetyMode of ['companion', 'firewall'] as const) {
    it(`${safetyMode}: crisis section is byte-identical and last, across no-mode, journal-with-fixture, and journal-absent`, () => {
      const baseline = buildPersona(safetyMode, resources, defaultStyle)
      const journalWithFixture = buildPersona(
        safetyMode,
        resources,
        defaultStyle,
        'journal',
        journalingFixture,
      )
      const journalAbsent = buildPersona(
        safetyMode,
        resources,
        defaultStyle,
        'journal',
        JOURNALING_PROTOCOL_ABSENT,
      )

      // The journal-mode arms must genuinely differ from the baseline
      // outside the crisis section, or this test would pass just as
      // easily with journal mode's own prompt construction deleted.
      expect(journalWithFixture).toContain(journalingFixture)
      expect(journalWithFixture).not.toBe(baseline)
      expect(journalAbsent).toContain('has never set up journal mode before')
      expect(journalAbsent).not.toBe(baseline)

      const baselineCrisis = crisisSectionOf(baseline)
      const fixtureCrisis = crisisSectionOf(journalWithFixture)
      const absentCrisis = crisisSectionOf(journalAbsent)

      expect(fixtureCrisis).toBe(baselineCrisis)
      expect(absentCrisis).toBe(baselineCrisis)

      // Anchor: baseline's own crisis section really is the tail of
      // buildPersona's output, ending on the last rendered resource line,
      // not merely a slice that trivially ends with itself.
      expect(baseline.endsWith('- Find A Helpline (international): findahelpline.com')).toBe(true)

      // Position, checked against the fixed baseline comparator (not each
      // arm's own slice-to-end of itself, which would be tautologically
      // true regardless of where the section actually sits): the crisis
      // section is the last section of buildPersona's own output in all
      // three arms, not merely present somewhere.
      expect(baseline.endsWith(baselineCrisis)).toBe(true)
      expect(journalWithFixture.endsWith(baselineCrisis)).toBe(true)
      expect(journalAbsent.endsWith(baselineCrisis)).toBe(true)
    })
  }
})
