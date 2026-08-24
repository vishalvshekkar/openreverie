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

import type { MemoryEngine, Profile, SessionContext } from '@openreverie/memory'
import { PROFILE_STARTER_BODY } from '@openreverie/memory'
import {
  ARCS_SECTION_CAP,
  CONSTITUTION_CAP,
  capBody,
  capRows,
  DREAM_INSIGHTS_SECTION_CAP,
  ENTITIES_SECTION_CAP,
  LATEST_DAILY_ROLLUP_CAP,
  PEOPLE_SECTION_CAP,
  PROFILE_BODY_CAP,
  REALM_FIRST_LINE_CAP,
  REALMS_SECTION_CAP,
  RECENT_INTENTIONS_SECTION_CAP,
  RECENT_SUMMARY_CAP,
  ROLLUPS_AVAILABLE_CAP,
} from './budget.js'
import type { ReverieConfig } from './config.js'
import type { ModeName } from './modes.js'
import { buildPersona } from './personas.js'

export async function assembleSystemPrompt(
  engine: MemoryEngine,
  config: ReverieConfig,
  activeMode: ModeName = 'general',
): Promise<string> {
  const context = await engine.sessionContext(new Date(), activeMode)
  const profile = engine.profile()
  const persona = buildPersona(
    config.safety.mode,
    config.safety.resources,
    engine.currentStyle(),
    activeMode,
    context.journalingProtocol,
  )

  if (context.isFirstSession) {
    return [persona, timeSection(context), profileSection(profile), firstConversationSection()]
      .filter((section): section is string => section !== undefined)
      .join('\n\n')
  }

  const sections = [
    persona,
    timeSection(context),
    profileSection(profile),
    constitutionSection(context),
    journalingProtocolSection(context),
    realmsSection(context),
    arcsSection(context),
    peopleSection(context),
    entitiesSection(context),
    recentIntentionsSection(context),
    dreamsSection(context),
    latestDailyRollupSection(context),
    rollupsAvailableSection(context),
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
  // capBody cuts from the start and, when it cuts, appends a marker naming
  // the constitution's docId. The docId is what lets the model fetch the
  // full text it is missing; a marker without it would tell the model
  // something exists and give it no way to reach it. This applies to the
  // chat prompt only; reflection's input is deliberately never capped.
  const capped = capBody(text, CONSTITUTION_CAP, context.constitutionDocId)
  return `## Constitution\n\n${capped.text}`
}

function journalingProtocolSection(context: SessionContext): string | undefined {
  if (context.journalingProtocol === undefined) return undefined
  return `## Journaling protocol\n\n${context.journalingProtocol}`
}

function realmsSection(context: SessionContext): string | undefined {
  if (context.realms.length === 0) return undefined
  const lines = context.realms.map((realm) => {
    const firstLine = realm.firstLine.trim()
    const clipped =
      firstLine.length > REALM_FIRST_LINE_CAP ? firstLine.slice(0, REALM_FIRST_LINE_CAP) : firstLine
    return clipped.length > 0 ? `- ${realm.name}: ${clipped}` : `- ${realm.name}`
  })
  const capped = capRows(lines, REALMS_SECTION_CAP)
  if (capped.shown < lines.length) {
    capped.rows.push(
      `(showing ${capped.shown} of ${lines.length} realms. Call list_realms for the rest.)`,
    )
  }
  return `## Realms\n\n${capped.rows.join('\n')}`
}

function arcsSection(context: SessionContext): string | undefined {
  if (context.arcs.length === 0) return undefined
  const lines = context.arcs.map((arc) => {
    const details = [`status: ${arc.status}`]
    if (arc.lastTouched) details.push(`last touched: ${arc.lastTouched}`)
    return `- ${arc.name} (${details.join(', ')})`
  })
  const capped = capRows(lines, ARCS_SECTION_CAP)
  const rows = capped.rows
  if (context.arcsTruncated || capped.shown < lines.length) {
    rows.push(
      `(showing ${capped.shown} of ${context.arcsTotal} active arcs, most recently touched first. Call list_arcs for the rest, including dormant and closed ones.)`,
    )
  }
  return `## Active arcs\n\n${rows.join('\n')}`
}

// Between-session reflections: selected insights from past dreams. Omitted
// entirely when context.dreamInsights is empty, which covers all three
// reasons it could be: no dream has ever run, profile.dreams.promptSection
// is false, or every candidate insight was excluded by feedback
// (MemoryEngine.sessionContext already applied the wrong/do_not_bring_up
// exclusion before this ever runs). Framed to the model as its own tentative
// between-session thinking, not established fact, so it draws on these
// naturally and attributes them honestly rather than reciting them.
function dreamsSection(context: SessionContext): string | undefined {
  if (context.dreamInsights.length === 0) return undefined
  const lines = context.dreamInsights.map(
    (insight) => `- [${insight.insightId}] (${insight.kind}) ${insight.headline}: ${insight.claim}`,
  )
  const capped = capRows(lines, DREAM_INSIGHTS_SECTION_CAP)
  return (
    '## Between-session reflections (dreams)\n\n' +
    "Between conversations you turn over this person's memory and keep what looked worth " +
    'keeping. These are your own tentative observations, not established facts. Draw on them ' +
    'naturally when they fit, attribute them honestly when you use one ("going back over what ' +
    'you told me..."), and if the person says one is wrong, accept that and record it with ' +
    'dream_feedback. Open questions are things worth asking when the moment is natural, never ' +
    'a checklist.\n\n' +
    capped.rows.join('\n')
  )
}

function latestDailyRollupSection(context: SessionContext): string | undefined {
  if (!context.latestDailyRollup) return undefined
  const body = context.latestDailyRollup.body.trim()
  const capped = capBody(body, LATEST_DAILY_ROLLUP_CAP, context.latestDailyRollup.docId)
  return `## Latest daily rollup\n\nDate: ${context.latestDailyRollup.date}\n\n${capped.text}`
}

function rollupsAvailableSection(context: SessionContext): string | undefined {
  if (context.weeklyRollupsTotal === 0) return undefined
  const lines: string[] = []
  lines.push(
    `Weekly rollups, most recent first: ${context.weeklyRollups
      .map((r) => `${r.week} (${r.docId})`)
      .join(', ')}`,
  )
  if (context.weeklyRollupsTotal > context.weeklyRollups.length) {
    lines.push(
      `${context.weeklyRollups.length} shown, ${context.weeklyRollupsTotal} exist` +
        (context.earliestWeek !== undefined ? `, running back to ${context.earliestWeek}.` : '.'),
    )
  }
  if (context.dailyRollups.total > 0) {
    const range =
      context.dailyRollups.earliest !== undefined && context.dailyRollups.latest !== undefined
        ? `, from ${context.dailyRollups.earliest} to ${context.dailyRollups.latest}`
        : ''
    const dayWord = context.dailyRollups.total === 1 ? 'day' : 'days'
    lines.push(
      `Daily rollups: ${context.dailyRollups.total} ${dayWord} covered${range}. The newest is shown above in full.`,
    )
  }
  // The escape hatch is appended after the cap, never inside it. It is not
  // data competing for the budget: it is the sentence that makes the docIds
  // above usable at all. Capping it alongside the rows means a full twelve
  // week index drops the one line that says how to read any of them, which
  // is the defect this release exists to remove.
  const capped = capRows(lines, ROLLUPS_AVAILABLE_CAP)
  const rows = [
    ...capped.rows,
    'Read any of these with read_document, or find one by period with search_memory using kinds and a date range.',
  ]
  return `## Rollups available\n\n${rows.join('\n')}`
}

function recentSummariesSection(context: SessionContext): string | undefined {
  if (context.recentSummaries.length === 0) return undefined
  // The id is rendered alongside the date because read_transcript takes a
  // session id and the prompt is the only place the model could get one.
  // Without it, the model can see that a session happened and can read its
  // summary, but has no way to ask for the verbatim transcript behind it.
  const parts = context.recentSummaries.map((summary) => {
    const capped = capBody(summary.body.trim(), RECENT_SUMMARY_CAP, summary.docId)
    return `${summary.date} (${summary.sessionId}): ${capped.text}`
  })
  return `## Recent sessions\n\n${parts.join('\n\n')}`
}

function peopleSection(context: SessionContext): string | undefined {
  if (context.people.length === 0) return undefined
  const lines = context.people.map(
    (person) => `- ${person.name} (${person.id}, ${person.hasPage ? 'has a page' : 'no page yet'})`,
  )
  const capped = capRows(lines, PEOPLE_SECTION_CAP)
  const rows = capped.rows
  if (context.peopleTruncated || capped.shown < lines.length) {
    // The marker names the tool that closes the gap. A marker that says
    // more exist without saying how to reach them tells the model something
    // exists and gives it no way to fetch it, which is the defect this
    // release exists to remove.
    rows.push(
      `(showing ${capped.shown} of ${context.peopleTotal} people, paged people first then most recently added. Call list_people to page through the rest, or search_memory by name.)`,
    )
  }
  return `## People\n\n${rows.join('\n')}`
}

function entitiesSection(context: SessionContext): string | undefined {
  if (context.entities.length === 0) return undefined
  const lines = context.entities.map((entity) => `- ${entity.name}`)
  const capped = capRows(lines, ENTITIES_SECTION_CAP)
  const rows = capped.rows
  if (context.entitiesTruncated || capped.shown < lines.length) {
    rows.push(
      `(showing ${capped.shown} of ${context.entitiesTotal} entities, most recently added first. Call list_entities to page through the rest, or search_memory by name.)`,
    )
  }
  return `## Entities\n\n${rows.join('\n')}`
}

// Fixed order, one line per set field. An unset field renders nothing at
// all: no line, no placeholder, never "unknown", because a prompt that
// claims a field is unknown when it is only absent is indistinguishable
// from one that failed to load. timezone is deliberately excluded: the
// Time section above already carries it, and a second copy invites the two
// to drift. The style axes render as their own paragraphs in personas.ts,
// not as raw values here. birthdayGreetings renders only once birthday is
// set, since the value is meaningless before that.
//
// The prose body is capped at PROFILE_BODY_CAP (budget.ts) at
// prompt-assembly time; profile.md on disk is never truncated. Unlike the
// constitution or a rollup, profile.md is not indexed (see the comment on
// PROFILE_BODY_CAP in budget.ts), so there is no docId to hand back:
// capBody's marker names a read_document call that would resolve to
// nothing, which is worse than no marker at all. The cut is marked with a
// plain suffix instead.
export const PROFILE_TRUNCATION_MARKER = '… [truncated]'

function profileSection(profile: Profile): string | undefined {
  const meta = profile.meta
  const lines: string[] = []
  if (meta.preferredName !== undefined) lines.push(`Preferred name: ${meta.preferredName}`)
  if (meta.pronouns !== undefined) lines.push(`Pronouns: ${meta.pronouns}`)
  if (meta.location !== undefined) lines.push(`Location: ${meta.location}`)
  if (meta.birthday !== undefined) lines.push(`Birthday: ${meta.birthday}`)
  if (meta.occupation !== undefined) lines.push(`Occupation: ${meta.occupation}`)
  if (meta.birthday !== undefined && meta.birthdayGreetings !== undefined) {
    lines.push(`Birthday greetings: ${meta.birthdayGreetings ? 'yes' : 'no'}`)
  }

  // profile.md ships with fixed maintenance boilerplate (PROFILE_STARTER_BODY),
  // not testimony about the person, so a body that is still exactly that
  // starter text is treated as unset rather than rendered to the model.
  const rawProse = profile.body.trim()
  const prose = rawProse === PROFILE_STARTER_BODY.trim() ? '' : rawProse
  const capped =
    prose.length > PROFILE_BODY_CAP
      ? `${prose.slice(0, PROFILE_BODY_CAP)}${PROFILE_TRUNCATION_MARKER}`
      : prose

  if (lines.length === 0 && capped.length === 0) return undefined
  const parts = [lines.join('\n'), capped].filter((part) => part.length > 0)
  return `## Profile\n\n${parts.join('\n\n')}`
}

function recentIntentionsSection(context: SessionContext): string | undefined {
  if (context.recentIntentions.length === 0) return undefined
  const lines = context.recentIntentions.map(
    (intention) => `- ${intention.date}: ${intention.text}`,
  )
  const capped = capRows(lines, RECENT_INTENTIONS_SECTION_CAP)
  const rows = capped.rows
  if (capped.shown < lines.length) {
    // Intentions have no listing tool and no fetch path of their own, so a
    // marker here can only state the count. The five-row cap keeps this
    // unreachable in practice; the character cap is a budget backstop.
    rows.push(`(showing ${capped.shown} of ${lines.length} recent intentions.)`)
  }
  return `## Recent intentions\n\n${rows.join('\n')}`
}
