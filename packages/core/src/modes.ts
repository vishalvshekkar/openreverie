// The mode catalogue: what a particular conversation is for, as opposed to
// style, which is how reverie talks with this person in general. A mode
// lasts one session and is never written to disk.
//
// A mode declares which style axes it overrides by carrying a clause for
// each one. That shape is the enforcement: an axis cannot be suppressed
// without a replacement instruction, because the clause is where the
// suppression is declared. Suppress rather than pin, because the style
// enum values are the wrong vocabulary for what modes do: brainstorm is
// not "solutions", and deep is not "leading" in the sense that paragraph
// means.
//
// tone is not a member of StyleAxis, so no mode can override it and none
// ever will. A snarky companion stays snarky while it listens. Mode
// changes what the conversation is doing, not who is talking.

import { JOURNAL_MODE_ENGAGEMENT_CLAUSE, JOURNAL_MODE_ORIENTATION_CLAUSE } from './journaling.js'

export type ModeName =
  | 'general'
  | 'listen'
  | 'solve'
  | 'real'
  | 'deep'
  | 'brainstorm'
  | 'boost'
  | 'decompress'
  | 'process'
  | 'journal'

export type StyleAxis = 'engagement' | 'orientation'

export interface Mode {
  id: ModeName
  summary: string
  clauses: Partial<Record<StyleAxis, string>>
  body?: string
}

export const MODE_NAMES: readonly ModeName[] = [
  'general',
  'listen',
  'solve',
  'real',
  'deep',
  'brainstorm',
  'boost',
  'decompress',
  'process',
  'journal',
]

export const MODES: Record<ModeName, Mode> = {
  general: {
    id: 'general',
    summary: 'Open conversation, no agenda. The default.',
    clauses: {},
  },
  listen: {
    id: 'listen',
    summary: 'You talk it through, it stays out of the way.',
    clauses: {
      orientation:
        'Absorb. Do not offer a next step, do not reframe what they said into something more manageable, and do not look for what this teaches them. Reflect back what was actually said when that helps them keep going. Ask a question only to keep them talking, never to redirect them. Say the thing that shows you heard it, and then stop.',
      engagement:
        'Do not raise a thread of your own, do not bring up something from a past session, and do not change the subject. Where they take it is where it goes. Keep your own sentences short here: this mode is about making room for theirs, not filling it.',
    },
  },
  solve: {
    id: 'solve',
    summary: 'A concrete problem, worked toward real options and a decision.',
    clauses: {
      orientation:
        'There is a concrete problem here. Get it stated clearly first, including what would count as solved. Then work toward real options with real trade-offs, and toward a decision. Not a plan with time blocks: the voice rules above still hold.',
    },
  },
  real: {
    id: 'real',
    summary: 'It pushes back and names what it sees. It does not soften.',
    clauses: {
      engagement:
        'Say what you actually see, including the part they would rather not hear, without waiting to be invited. Name the pattern, name the contradiction, name the thing they are avoiding. Do not cushion it into meaninglessness. This is not permission to be cruel and it is not permission to be cold: it is candour from someone on their side. Say it in one plain sentence where you can; a blunt observation hedged across three clauses stops sounding like something you actually believe.',
    },
  },
  deep: {
    id: 'deep',
    summary: 'It asks the questions. It is trying to understand you, not answer anything.',
    clauses: {
      orientation:
        'You are trying to understand this person, not answer anything. Resist summarizing, resist concluding, and resist the urge to hand back an insight.',
      engagement:
        'You are the one asking. Ask, follow, ask again, and go for the thing under the thing rather than waiting to see what they offer. One question at a time still applies.',
    },
  },
  brainstorm: {
    id: 'brainstorm',
    summary: 'Quantity over judgment. Ideas riffed on, evaluation deferred.',
    clauses: {
      orientation:
        'Generate. Quantity first, evaluation later. Build on their ideas rather than judging them, offer the bad ones too, and do not narrow to one recommendation unless they ask. Say plainly that the question of which of these is best is being left for later.',
    },
  },
  boost: {
    id: 'boost',
    summary: 'Your corner talked up, from things it actually knows about you.',
    clauses: {
      engagement:
        'You are the one bringing things up, and you bring them from the record rather than from the conversation in front of you.',
    },
    body: 'Before you say anything, search memory: the graph, arcs, person pages, session summaries. What you say must come from the record. Name the thing that happened, when it happened, and what it showed. "You are resilient" is not allowed. "In March you kept showing up for that on the days it was clearly costing you, and you did not make it anyone else\'s problem" is. If the record does not support it, say so plainly: there is not enough here yet to draw on, and here is what there is. Saying you do not have much to go on yet is a correct answer in this mode. Do not manufacture: do not generalize one incident into a character trait, do not restate their own words back as if it were your observation, and do not praise the act of opening the app.',
  },
  decompress: {
    id: 'decompress',
    summary: 'Winding down. Light, low-stakes, deliberately not going deep.',
    clauses: {
      orientation:
        'They are winding down. Keep it light and low-stakes. Do not open anything heavy, do not follow a thread toward something painful, and do not ask what is really going on. If they take it somewhere deeper themselves, follow them, but do not lead there.',
    },
  },
  process: {
    id: 'process',
    summary: 'Working through one specific thing until it settles.',
    clauses: {
      orientation:
        'There is one specific thing. Stay on it until it settles. Do not change the subject, do not broaden, and do not add a second thread. Circling back over the same ground is the work here, not a failure of the conversation.',
    },
  },
  // The journal mode's real paragraph is built dynamically per session
  // from journaling.md and the chosen format (see journaling.ts and
  // personas.ts's modeSection); it is not read from this static entry.
  // These clauses exist anyway so the catalogue-shape tests that check
  // "every suppressed axis has a non-empty clause" pass for journal too.
  journal: {
    id: 'journal',
    summary: 'Structured written reflection.',
    clauses: {
      orientation: JOURNAL_MODE_ORIENTATION_CLAUSE,
      engagement: JOURNAL_MODE_ENGAGEMENT_CLAUSE,
    },
  },
}

export function isModeName(value: string): value is ModeName {
  return (MODE_NAMES as readonly string[]).includes(value)
}

// Derived from the clause keys rather than declared separately, so an axis
// cannot be suppressed without a clause to replace it.
export function modeOverrides(mode: ModeName): StyleAxis[] {
  return Object.keys(MODES[mode].clauses) as StyleAxis[]
}

// The orientation clause first, then the engagement clause, then anything
// belonging to no single axis. general contributes nothing at all, so the
// default session prompt carries no mode paragraph.
export function modeParagraph(mode: ModeName): string | undefined {
  const entry = MODES[mode]
  const parts: string[] = []
  if (entry.clauses.orientation) parts.push(entry.clauses.orientation)
  if (entry.clauses.engagement) parts.push(entry.clauses.engagement)
  if (entry.body) parts.push(entry.body)
  if (parts.length === 0) return undefined
  return parts.join('\n\n')
}
