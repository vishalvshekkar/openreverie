// Session context assembly: the system prompt handed to the chat provider
// at the start of a session. It is the persona for the configured safety
// mode, followed by today's date, followed by a snapshot of memory state
// pulled from MemoryEngine.sessionContext(): the constitution, realms,
// active arcs, the latest daily rollup, session summaries from the last
// week, and pending proposals. A section with nothing to say is left out
// entirely rather than rendered as an empty header, so the model never sees
// "## Realms" with nothing under it.
//
// The model is never told the current date anywhere else. Recent sessions
// and the latest daily rollup are rendered with absolute dates
// (2026-08-12), and without today's date stated somewhere the model has no
// way to tell whether that was yesterday or last week. Today's date always
// comes from context.today, the same clock MemoryEngine.sessionContext used
// to compute the recent-sessions window, never from a second call to
// Date() here.

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
    return [persona, todaySection(context), firstConversationSection()].join('\n\n')
  }

  const sections = [
    persona,
    todaySection(context),
    constitutionSection(context),
    realmsSection(context),
    arcsSection(context),
    latestDailyRollupSection(context),
    recentSummariesSection(context),
    pendingProposalsSection(context),
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

function todaySection(context: SessionContext): string {
  return `## Today\n\nToday's date is ${context.today}.`
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
  const parts = context.recentSummaries.map((summary) => `${summary.date}: ${summary.body.trim()}`)
  return `## Recent sessions\n\n${parts.join('\n\n')}`
}

function pendingProposalsSection(context: SessionContext): string | undefined {
  if (context.pendingProposals.length === 0) return undefined
  const instruction =
    "Weave these into the conversation naturally, near the start, and record the user's " +
    'decision on each with the resolve_proposal tool, passing the bracketed id shown before ' +
    'each proposal below as proposalId exactly as written.'
  const lines = context.pendingProposals.map((proposal) => `- [${proposal.id}] ${proposal.summary}`)
  return `## Pending proposals\n\n${instruction}\n\n${lines.join('\n')}`
}
