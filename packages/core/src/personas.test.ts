import { describe, expect, it } from 'vitest'
import type { CrisisResource } from './config.js'
import { buildPersona } from './personas.js'

const resources: CrisisResource[] = [
  { label: '988 Suicide and Crisis Lifeline (US)', contact: 'Call or text 988' },
  { label: 'Find A Helpline (international)', contact: 'findahelpline.com' },
]

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
    const text = buildPersona('companion', resources)
    for (const resource of resources) {
      expect(text).toContain(resource.label)
      expect(text).toContain(resource.contact)
    }
  })

  it('renders every resource label and contact in firewall mode', () => {
    const text = buildPersona('firewall', resources)
    for (const resource of resources) {
      expect(text).toContain(resource.label)
      expect(text).toContain(resource.contact)
    }
  })

  it('companion mode stays present and does not instruct refusing or declining to engage', () => {
    const text = buildPersona('companion', resources)
    expect(text).toMatch(/stay/i)
    // Companion mode refuses nothing: it must never instruct the model to
    // decline or refuse to continue talking with the person.
    expect(text.toLowerCase()).not.toMatch(/\b(refuse|decline)s? to (continue|engage|keep|talk)/)
  })

  it('firewall mode instructs declining to continue the crisis thread', () => {
    const text = buildPersona('firewall', resources)
    expect(text.toLowerCase()).toMatch(/decline to continue/)
  })

  it('shares an identical, substantial prefix between modes, differing only in the crisis stance', () => {
    const companion = buildPersona('companion', resources)
    const firewall = buildPersona('firewall', resources)

    expect(companion).not.toEqual(firewall)

    const prefix = sharedPrefix(companion, firewall)

    // Shared prefix must be substantial: what reverie is, what it is not,
    // retrieve-before-asserting, raising pending proposals, and even the
    // crisis detection judgment itself are identical text, built from the
    // same shared parts. Only the stance taken once danger is judged real
    // differs.
    expect(prefix.length).toBeGreaterThan(400)

    const prefixLower = prefix.toLowerCase()
    expect(prefixLower).toContain('not a therapist')
    expect(prefixLower).toMatch(/search|retriev/)
    expect(prefixLower).toContain('proposal')
    expect(prefixLower).toContain('crisis territory')
  })

  it('never contains an em dash character', () => {
    const companion = buildPersona('companion', resources)
    const firewall = buildPersona('firewall', resources)
    expect(companion).not.toContain('—')
    expect(firewall).not.toContain('—')
  })

  it('explains what reverie is and is not, in both modes', () => {
    for (const mode of ['companion', 'firewall'] as const) {
      const text = buildPersona(mode, resources)
      expect(text.toLowerCase()).toContain('not a therapist')
    }
  })

  it('states the retrieve-before-asserting rule, in both modes', () => {
    for (const mode of ['companion', 'firewall'] as const) {
      const text = buildPersona(mode, resources)
      expect(text.toLowerCase()).toMatch(/search|retriev/)
    }
  })

  it('mentions raising pending proposals near the start of a session', () => {
    for (const mode of ['companion', 'firewall'] as const) {
      const text = buildPersona(mode, resources)
      expect(text.toLowerCase()).toContain('proposal')
    }
  })

  it('renders correctly with an empty resource list', () => {
    expect(() => buildPersona('companion', [])).not.toThrow()
    expect(() => buildPersona('firewall', [])).not.toThrow()
  })

  it('renders a resource label with $ replacement sequences literally instead of leaking the template', () => {
    const trickyResources: CrisisResource[] = [
      { label: 'Weird $& and $` line', contact: 'Call 555-0100' },
    ]
    for (const mode of ['companion', 'firewall'] as const) {
      const text = buildPersona(mode, trickyResources)
      expect(text).toContain('Weird $& and $` line')
      expect(text).not.toContain('{{RESOURCES}}')
    }
  })
})
