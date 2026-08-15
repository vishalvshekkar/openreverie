import { describe, expect, it } from 'vitest'
import type { CrisisResource, StyleConfig } from './config.js'
import { buildPersona } from './personas.js'

const resources: CrisisResource[] = [
  { label: '988 Suicide and Crisis Lifeline (US)', contact: 'Call or text 988' },
  { label: 'Find A Helpline (international)', contact: 'findahelpline.com' },
]

const defaultStyle: StyleConfig = { engagement: 'balanced', tone: 'warm', orientation: 'listening' }

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
