// Session context assembly: the system prompt handed to the chat provider
// at the start of a session. It is the persona for the configured safety
// mode, followed by a snapshot of memory state pulled from
// MemoryEngine.sessionContext(): the constitution, realms, active arcs, the
// latest daily rollup, yesterday's session summaries, and pending
// proposals. A section with nothing to say is left out entirely rather than
// rendered as an empty header, so the model never sees "## Realms" with
// nothing under it.

import type { MemoryEngine, SessionContext } from '@openreverie/memory'
import type { ReverieConfig } from './config.js'
import { buildPersona } from './personas.js'

export async function assembleSystemPrompt(
  engine: MemoryEngine,
  config: ReverieConfig,
): Promise<string> {
  const context = await engine.sessionContext()
  const persona = buildPersona(config.safety.mode, config.safety.resources)

  const sections = [
    persona,
    constitutionSection(context),
    realmsSection(context),
    arcsSection(context),
    latestDailyRollupSection(context),
    yesterdaySection(context),
    pendingProposalsSection(context),
  ].filter((section): section is string => section !== undefined)

  return sections.join('\n\n')
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

function yesterdaySection(context: SessionContext): string | undefined {
  if (context.yesterdaySummaries.length === 0) return undefined
  const parts = context.yesterdaySummaries.map((summary) => summary.body.trim())
  return `## Yesterday\n\n${parts.join('\n\n')}`
}

function pendingProposalsSection(context: SessionContext): string | undefined {
  if (context.pendingProposals.length === 0) return undefined
  const instruction =
    "Weave these into the conversation naturally, near the start, and record the user's " +
    'decision on each with the resolve_proposal tool.'
  const lines = context.pendingProposals.map((proposal) => `- ${proposal.summary}`)
  return `## Pending proposals\n\n${instruction}\n\n${lines.join('\n')}`
}
