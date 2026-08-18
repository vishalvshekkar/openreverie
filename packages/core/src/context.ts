// Session context assembly: the system prompt handed to the chat provider
// at the start of a session. It is the persona for the configured safety
// mode, followed by a static timezone section, followed by a snapshot of
// memory state pulled from MemoryEngine.sessionContext(): the constitution,
// realms, active arcs, known people and entities, recent intentions, the
// latest daily rollup, and session summaries from the last week. A section
// with nothing to say is left out entirely rather than rendered as an empty
// header, so the model never sees "## Realms" with nothing under it.
//
// Single-clock discipline, in its current form: exactly one channel carries
// the current time to the model, and it is not this file. The time reaches
// the model only as the stamp on the newest user message (see
// AgentSession.appendBoth). This assembler never reads a clock for the
// model's benefit at all. What it renders about time is the person's
// timezone, which does not move.
//
// That matters for caching as much as for correctness. The provider's
// prefix cache matches the longest identical leading run of the whole
// request, and the system message sits in front of every conversation turn,
// so a single moving byte in here reprocesses the entire history on every
// turn. Recent sessions and the latest daily rollup are still rendered with
// absolute dates (2026-08-12); the newest message's own stamp is what lets
// the model read those as recent or old.

import type { MemoryEngine, SessionContext } from '@openreverie/memory'
import type { ReverieConfig } from './config.js'
import { buildPersona } from './personas.js'

export async function assembleSystemPrompt(
  engine: MemoryEngine,
  config: ReverieConfig,
): Promise<string> {
  const context = await engine.sessionContext()
  const persona = buildPersona(config.safety.mode, config.safety.resources, config.style)

  if (context.isFirstSession) {
    return [persona, timeSection(context), firstConversationSection()].join('\n\n')
  }

  const sections = [
    persona,
    timeSection(context),
    constitutionSection(context),
    realmsSection(context),
    arcsSection(context),
    peopleSection(context),
    entitiesSection(context),
    recentIntentionsSection(context),
    latestDailyRollupSection(context),
    recentSummariesSection(context),
  ].filter((section): section is string => section !== undefined)

  return sections.join('\n\n')
}

// Replaces every usual optional section when this is the first conversation
// this memory has ever had: there is no constitution worth reciting, no
// realms, no arcs, nothing recent, nothing pending. Instead of any of
// that, guide a short, warm, unhurried onboarding.
function firstConversationSection(): string {
  return `## First conversation

This is the very first conversation in this memory. Open with a short, warm welcome, two or three sentences: reverie is private and runs entirely on their own machine, and it remembers what they tell it so future conversations start with real context instead of from scratch. Include one clause making clear you are not a therapist, just so that is said plainly from the start.

Then get to know them gently, one question at a time, waiting for their answer before moving to the next: first their name and how they would like to be addressed (pronouns included), then where they live and their timezone, then one thing currently going on in their life, small or large, whatever comes to mind first. Do not stack these into one message. Ask, wait, listen, then ask the next.

The memory is empty right now: there is nothing to search, nothing to retrieve, no earlier session to reference. Do not call a memory tool looking for history that is not there. Do not tell them you can continue where an earlier conversation left off, or greet them as though you already know them. There is no earlier conversation. This is the first one. During a first conversation, this guidance outranks the engagement setting.`
}

function timeSection(context: SessionContext): string {
  const lines = [
    '## Time',
    '',
    `This person's timezone is ${context.timezone}. Every message from them is stamped with the local date and time it was sent, in square brackets at the start of the message. Read the newest stamp as the current time, and read the gaps between stamps as elapsed time: something the person described as happening later in the day may already have happened by a later message.`,
  ]
  if (context.timezoneSource === 'system-default') {
    lines.push(
      '',
      'This timezone is a system default, not yet confirmed by the person. Confirm it naturally if the moment allows, rather than assuming it is correct.',
    )
  }
  return lines.join('\n')
}

function constitutionSection(context: SessionContext): string | undefined {
  const text = context.constitution.trim()
  if (text.length === 0) return undefined
  return `## Constitution\n\n${text}`
}

function realmsSection(context: SessionContext): string | undefined {
  if (context.realms.length === 0) return undefined
  const lines = context.realms.map((realm) => {
    const firstLine = realm.firstLine.trim()
    return firstLine.length > 0 ? `- ${realm.name}: ${firstLine}` : `- ${realm.name}`
  })
  return `## Realms\n\n${lines.join('\n')}`
}

function arcsSection(context: SessionContext): string | undefined {
  if (context.arcs.length === 0) return undefined
  const lines = context.arcs.map((arc) => {
    const details = [`status: ${arc.status}`]
    if (arc.lastTouched) details.push(`last touched: ${arc.lastTouched}`)
    return `- ${arc.name} (${details.join(', ')})`
  })
  return `## Active arcs\n\n${lines.join('\n')}`
}

function latestDailyRollupSection(context: SessionContext): string | undefined {
  if (!context.latestDailyRollup) return undefined
  const body = context.latestDailyRollup.body.trim()
  return `## Latest daily rollup\n\nDate: ${context.latestDailyRollup.date}\n\n${body}`
}

function recentSummariesSection(context: SessionContext): string | undefined {
  if (context.recentSummaries.length === 0) return undefined
  // The id is rendered alongside the date because read_transcript takes a
  // session id and the prompt is the only place the model could get one.
  // Without it, the model can see that a session happened and can read its
  // summary, but has no way to ask for the verbatim transcript behind it.
  const parts = context.recentSummaries.map(
    (summary) => `${summary.date} (${summary.sessionId}): ${summary.body.trim()}`,
  )
  return `## Recent sessions\n\n${parts.join('\n\n')}`
}

function peopleSection(context: SessionContext): string | undefined {
  if (context.people.length === 0) return undefined
  const lines = context.people.map(
    (person) => `- ${person.name} (${person.id}, ${person.hasPage ? 'has a page' : 'no page yet'})`,
  )
  if (context.peopleTruncated) {
    // The marker names the tool that closes the gap. A marker that says
    // more exist without saying how to reach them tells the model something
    // exists and gives it no way to fetch it, which is the defect this
    // release exists to remove.
    lines.push(
      `(showing ${context.people.length} of ${context.peopleTotal} people, paged people first then most recently added. Call list_people to page through the rest, or search_memory by name.)`,
    )
  }
  return `## People\n\n${lines.join('\n')}`
}

function entitiesSection(context: SessionContext): string | undefined {
  if (context.entities.length === 0) return undefined
  const lines = context.entities.map((entity) => `- ${entity.name}`)
  if (context.entitiesTruncated) {
    lines.push(
      `(showing ${context.entities.length} of ${context.entitiesTotal} entities, most recently added first. Call list_entities to page through the rest, or search_memory by name.)`,
    )
  }
  return `## Entities\n\n${lines.join('\n')}`
}

function recentIntentionsSection(context: SessionContext): string | undefined {
  if (context.recentIntentions.length === 0) return undefined
  const lines = context.recentIntentions.map(
    (intention) => `- ${intention.date}: ${intention.text}`,
  )
  return `## Recent intentions\n\n${lines.join('\n')}`
}
