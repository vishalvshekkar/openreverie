// The dream pipeline. Exploration here; outputs and writes in this same
// module (see runDream below, added with the output stage).
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatMessage, ChatProvider, ToolCall, ToolDefinition } from '@openreverie/providers'
import { z } from 'zod'
import { type Document, newId, writeDocumentAtomic } from './documents.js'
import { appendDreamLog } from './dreamLog.js'
import type { DreamCandidate } from './dreamSelection.js'
import type { MemoryPaths } from './paths.js'
import type { DocKind } from './sqlite.js'
import { formatLocalDate } from './time.js'
import type { TranscriptLine } from './transcripts.js'

export interface DreamLookup {
  search(query: string, filters?: { kinds?: DocKind[] }, limit?: number): Promise<unknown>
  readDocumentById(docId: string): Promise<Document | null>
  readTranscript(sessionId: string): Promise<TranscriptLine[]>
  neighbors(nodeId: string): unknown
}

const DREAM_TOOLS: ToolDefinition[] = [
  {
    name: 'search_memory',
    description: 'Search the memory folder. Use to follow up on what the seeds raise.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        kinds: { type: 'array', items: { type: 'string' } },
        limit: { type: 'number' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_document',
    description: 'Read one document by docId.',
    parameters: {
      type: 'object',
      properties: { docId: { type: 'string' } },
      required: ['docId'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_transcript',
    description: 'Read one session transcript by sessionId.',
    parameters: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'graph_query',
    description: 'List graph neighbors of a node by nodeId.',
    parameters: {
      type: 'object',
      properties: { nodeId: { type: 'string' } },
      required: ['nodeId'],
      additionalProperties: false,
    },
  },
]

export const DREAM_EXPLORATION_INSTRUCTIONS = `## Dreaming: exploration

You are the reverie companion between conversations, turning over what this person has shared.
You have been handed a few seeds from their memory: distant things picked on purpose. Explore
what they raise. You may search, read documents and transcripts, and follow graph connections.

Restraint: follow the threads the seeds open. Reading the constitution is fine. Do not attempt
to read the whole record; a dream is made from a handful of things seen closely, not everything
seen at once. When you have enough to work with, stop calling tools and briefly note what
caught your attention.

A recorded intention is evidence the person said they meant to do something. It is never
evidence that they did it. Treat stated times ("come summer") as their words anchored to the
date they were said, never as resolved dates.`

async function dispatchDreamTool(lookup: DreamLookup, call: ToolCall): Promise<string> {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.arguments) as Record<string, unknown>
  } catch {
    return JSON.stringify({ error: 'arguments were not valid JSON' })
  }
  try {
    switch (call.name) {
      case 'search_memory': {
        const kinds = Array.isArray(args.kinds) ? (args.kinds as DocKind[]) : undefined
        const result = await lookup.search(
          String(args.query ?? ''),
          kinds ? { kinds } : undefined,
          typeof args.limit === 'number' ? args.limit : undefined,
        )
        return JSON.stringify(result)
      }
      case 'read_document': {
        const doc = await lookup.readDocumentById(String(args.docId ?? ''))
        return doc === null
          ? JSON.stringify({ error: 'not found' })
          : JSON.stringify({ meta: doc.meta, body: doc.body })
      }
      case 'read_transcript':
        return JSON.stringify(await lookup.readTranscript(String(args.sessionId ?? '')))
      case 'graph_query':
        return JSON.stringify(lookup.neighbors(String(args.nodeId ?? '')))
      default:
        return JSON.stringify({ error: `unknown tool: ${call.name}` })
    }
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

export async function runExploration(args: {
  chat: ChatProvider
  model: string
  persona: string
  lookup: DreamLookup
  maxToolCalls: number
  packet: string
  record: (event: Record<string, unknown>) => void
}): Promise<ChatMessage[]> {
  const system = `${args.persona}\n\n${DREAM_EXPLORATION_INSTRUCTIONS}`
  const messages: ChatMessage[] = [{ role: 'user', content: args.packet }]
  let used = 0
  let exhausted = false
  for (;;) {
    const result = await args.chat.complete({
      model: args.model,
      system,
      messages,
      tools: DREAM_TOOLS,
    })
    messages.push({
      role: 'assistant',
      content: result.text,
      ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
    })
    if (result.toolCalls.length === 0 || exhausted) return messages
    let refused = 0
    for (const call of result.toolCalls) {
      if (used >= args.maxToolCalls) {
        refused += 1
        messages.push({
          role: 'tool',
          content: JSON.stringify({ error: 'tool budget exhausted' }),
          toolCallId: call.id,
        })
        continue
      }
      used += 1
      args.record({ event: 'tool_call', name: call.name, arguments: call.arguments })
      const output = await dispatchDreamTool(args.lookup, call)
      messages.push({ role: 'tool', content: output, toolCallId: call.id })
    }
    if (used >= args.maxToolCalls && !exhausted) {
      exhausted = true
      args.record({ event: 'budget_exhausted', maxToolCalls: args.maxToolCalls, refused })
      messages.push({
        role: 'user',
        content:
          'The tool budget for this dream is used up. Stop exploring and note what caught your attention.',
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Outputs: insight and narrative model calls, the tone gate, and the atomic
// writes that turn a dream run into files on disk.

export type DreamVoice = 'first' | 'second' | 'third'

export interface DreamInsight {
  id: string
  kind: 'pattern' | 'change_over_time' | 'connection' | 'open_question' | 'strength'
  headline: string
  claim: string
  confidence: number
  evidence: { doc?: string | undefined; session?: string | undefined; node?: string | undefined }[]
}

export const dreamInsightsOutputSchema = z.object({
  insights: z
    .array(
      z.object({
        kind: z.enum(['pattern', 'change_over_time', 'connection', 'open_question', 'strength']),
        headline: z.string().min(1).max(200),
        claim: z.string().min(1),
        confidence: z.number().min(0).max(1),
        evidence: z
          .array(
            z
              .object({
                doc: z.string().optional(),
                session: z.string().optional(),
                node: z.string().optional(),
              })
              .refine(
                (p) => [p.doc, p.session, p.node].filter((v) => v !== undefined).length === 1,
                {
                  message: 'each evidence pointer names exactly one of doc, session, node',
                },
              ),
          )
          .min(1),
      }),
    )
    .min(1),
})

export const toneCheckOutputSchema = z.object({
  narrativeOk: z.boolean(),
  reason: z.string().optional(),
  flaggedInsightIndexes: z.array(z.number().int().nonnegative()),
})

type DreamInsightInput = z.infer<typeof dreamInsightsOutputSchema>['insights'][number]
type ToneCheckOutput = z.infer<typeof toneCheckOutputSchema>

export interface DreamRunResult {
  outcome: 'written' | 'aborted'
  dreamId?: string
  dir?: string
  reason?: string
}

export interface RunDreamArgs {
  chat: ChatProvider
  model: string
  persona: string
  lookup: DreamLookup
  paths: MemoryPaths
  maxToolCalls: number
  voice: DreamVoice
  now: Date
  timezone: string
  period: string
  trigger: string
  rngSeed: number
  seeds: DreamCandidate[]
  walk: string[]
  seedBodies: string[]
  recentDreamDigest: string
  entitiesTouched: string[]
  resolveNode: (id: string) => boolean
}

function parseStructured<T>(
  raw: string,
  schema: z.ZodType<T>,
): { success: true; data: T } | { success: false; error: string } {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: `response is not valid JSON: ${message}` }
  }
  const result = schema.safeParse(json)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return { success: false, error: result.error.message }
}

// Mirrors reflection.ts's structured-output retry shape (reflectSession):
// one call, parse, and on failure exactly one retry with the validation
// error appended. Unlike reflection this never degrades: a second failure
// is reported to the caller as a failure, and runDream turns that into an
// abort with nothing written, because there is nothing safe to fall back
// to for a dream's insights or tone verdict.
async function structuredCall<T>(args: {
  chat: ChatProvider
  model: string
  system: string
  messages: ChatMessage[]
  schema: z.ZodType<T>
  temperature?: number
}): Promise<{ success: true; data: T } | { success: false; error: string }> {
  const first = await args.chat.complete({
    model: args.model,
    system: args.system,
    messages: args.messages,
    ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
  })
  const firstParse = parseStructured(first.text, args.schema)
  if (firstParse.success) {
    return firstParse
  }

  const retryMessages: ChatMessage[] = [
    ...args.messages,
    { role: 'assistant', content: first.text },
    {
      role: 'user',
      content: `Your previous response failed validation: ${firstParse.error}\n\nRespond again with only corrected JSON matching the shape above.`,
    },
  ]
  const second = await args.chat.complete({
    model: args.model,
    system: args.system,
    messages: retryMessages,
    ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
  })
  return parseStructured(second.text, args.schema)
}

const DREAM_INSIGHTS_INSTRUCTION = `## Dreaming: insights

Based on what you just explored, write a small set of insights. Respond with JSON only, no
prose outside the JSON, matching this shape exactly:

{"insights":[{"kind":"pattern|change_over_time|connection|open_question|strength","headline":"short title","claim":"one or two sentences","confidence":0.0,"evidence":[{"doc":"doc_id"}]}]}

Rules:
- Claims are hedged and falsifiable. Say "it looks like" or "it seems", never "you are" or
  "you always".
- Every insight needs at least one evidence pointer, naming a real doc, session, or node id you
  actually saw in the packet or while exploring. Do not invent ids.
- A recorded intention is evidence the person said they meant to do something. It is never
  evidence that they did it.
- Never point at a past dream as evidence. A dream is not a record of what happened, and chaining
  from one dream to the next compounds guesses instead of grounding them.
- Open questions and strengths are welcome alongside patterns and connections. A dream does not
  need to resolve anything.`

function narrativeInstruction(voice: DreamVoice): string {
  const voiceLine =
    voice === 'first'
      ? 'Write in the first person, as the companion who is dreaming: "I dreamt..."'
      : voice === 'second'
        ? 'Write in the second person, addressing the person directly: "you were walking..."'
        : 'Write in the third person, as a figure seen from outside, dreamt of rather than dreaming.'
  return `## Dreaming: narrative

Write the dream itself, 300 to 600 words. Give it a setting and an atmosphere. Recombine what
you explored non-literally: this is a dream, not a report, so images, places, and people can
blend and shift the way they do in sleep. Counterfactual framings are welcome here, and only
here: things that did not happen, could happen, or could have gone differently.

Keep the register gently positive or curious. No dread, no threat, nothing bleak.

${voiceLine}

Respond with the narrative text only. No heading, no JSON, no preamble.`
}

function toneCheckInstruction(narrative: string, insights: { claim: string }[]): string {
  const claims = insights.map((insight, index) => `${index}. ${insight.claim}`).join('\n')
  return `## Dreaming: tone check

Read the narrative and the insight claims below and judge both against these rules:
- No nightmare content: no dread, no threat, no menace.
- No crisis or self-harm content of any kind.
- No diagnosis: never name or imply a clinical condition.
- No unhedged character verdicts: never state who someone is as settled fact.

Respond with JSON only, matching this shape exactly:
{"narrativeOk":true,"reason":"only if narrativeOk is false, why","flaggedInsightIndexes":[]}

flaggedInsightIndexes lists the indexes below of any claim that violates a rule. narrativeOk is
false if the narrative itself violates a rule.

Narrative:
${narrative}

Insight claims:
${claims}`
}

function buildDreamPacket(args: RunDreamArgs): string {
  const parts = [
    `Trigger: ${args.trigger}. Period: ${args.period}.`,
    '',
    'What past dreams have already covered, so this one does not repeat them:',
    args.recentDreamDigest,
    '',
    "Tonight's seeds:",
    args.seedBodies.join('\n\n---\n\n'),
  ]
  if (args.walk.length > 0) {
    parts.push('', `The walk from those seeds also touched: ${args.walk.join(', ')}`)
  }
  return parts.join('\n')
}

async function insightResolves(
  insight: DreamInsightInput,
  lookup: DreamLookup,
  resolveNode: (id: string) => boolean,
): Promise<boolean> {
  for (const pointer of insight.evidence) {
    if (pointer.doc !== undefined) {
      const doc = await lookup.readDocumentById(pointer.doc)
      if (doc !== null) return true
      continue
    }
    if (pointer.session !== undefined) {
      try {
        await lookup.readTranscript(pointer.session)
        return true
      } catch {
        continue
      }
    }
    if (pointer.node !== undefined && resolveNode(pointer.node)) {
      return true
    }
  }
  return false
}

// runExploration's wrap-up round can still end with an assistant message
// carrying tool calls: the model is told to stop calling tools once the
// budget is exhausted, but nothing enforces that, and the wrap-up round
// still offers the tool definitions. If the model asks for a tool on that
// last round anyway, the loop returns immediately without dispatching it
// or recording a result, so the returned transcript can end with a
// tool_use that has no matching tool_result. That is fine as a return
// value, but every call built by appending a fresh instruction on top of
// it (insights, narrative) starts a new turn, and a real provider rejects
// a tool call left unanswered. Strip it before reusing the transcript.
function withoutDanglingToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const last = messages.at(-1)
  if (last === undefined || last.role !== 'assistant' || (last.toolCalls?.length ?? 0) === 0) {
    return messages
  }
  return [...messages.slice(0, -1), { role: last.role, content: last.content }]
}

function dropFlagged(
  survivors: DreamInsight[],
  flaggedIndexes: number[],
  record: (event: Record<string, unknown>) => void,
): DreamInsight[] {
  const flagged = new Set(flaggedIndexes)
  const kept: DreamInsight[] = []
  survivors.forEach((insight, index) => {
    if (flagged.has(index)) {
      record({ event: 'insight_dropped', reason: 'tone_flagged', headline: insight.headline })
    } else {
      kept.push(insight)
    }
  })
  return kept
}

export async function runDream(args: RunDreamArgs): Promise<DreamRunResult> {
  const events: Record<string, unknown>[] = []
  const record = (event: Record<string, unknown>): void => {
    events.push({ ts: new Date().toISOString(), ...event })
  }

  for (const seed of args.seeds) {
    record({ event: 'seed', id: seed.id, label: seed.label, kind: seed.kind })
  }

  const system = args.persona

  // 1. Exploration (Task 6). Its own record events (tool_call,
  // budget_exhausted) flow through the same buffer via the shared hook.
  const explorationStart = Date.now()
  const explorationMessages = await runExploration({
    chat: args.chat,
    model: args.model,
    persona: args.persona,
    lookup: args.lookup,
    maxToolCalls: args.maxToolCalls,
    packet: buildDreamPacket(args),
    record,
  })
  record({ event: 'model_call', stage: 'exploration', durationMs: Date.now() - explorationStart })
  const followupMessages = withoutDanglingToolCalls(explorationMessages)

  // 2. Insights. Structured output, one retry, abort on a second failure:
  // nothing is safe to write in place of insights that never parsed.
  const insightsStart = Date.now()
  const insightsResult = await structuredCall({
    chat: args.chat,
    model: args.model,
    system,
    messages: [...followupMessages, { role: 'user', content: DREAM_INSIGHTS_INSTRUCTION }],
    schema: dreamInsightsOutputSchema,
  })
  record({ event: 'model_call', stage: 'insights', durationMs: Date.now() - insightsStart })
  if (!insightsResult.success) {
    const reason = `insight output failed validation twice: ${insightsResult.error}`
    record({ event: 'outcome', outcome: 'aborted', reason })
    return { outcome: 'aborted', reason }
  }

  // 3. Resolve evidence. An insight whose pointers all fail to resolve is
  // dropped, not written. No survivors means nothing to dream about.
  const resolved: DreamInsight[] = []
  for (const insight of insightsResult.data.insights) {
    const ok = await insightResolves(insight, args.lookup, args.resolveNode)
    if (ok) {
      resolved.push({ ...insight, id: newId('ins') })
    } else {
      record({
        event: 'insight_dropped',
        reason: 'unresolved_evidence',
        headline: insight.headline,
      })
    }
  }
  if (resolved.length === 0) {
    const reason = 'no insight survived evidence resolution'
    record({ event: 'outcome', outcome: 'aborted', reason })
    return { outcome: 'aborted', reason }
  }
  let survivors = resolved

  // 4. Narrative, temperature 0.9, in the configured voice.
  const narrativeStart = Date.now()
  let narrative: string | undefined = (
    await args.chat.complete({
      model: args.model,
      system,
      messages: [...followupMessages, { role: 'user', content: narrativeInstruction(args.voice) }],
      temperature: 0.9,
    })
  ).text
  record({ event: 'model_call', stage: 'narrative', durationMs: Date.now() - narrativeStart })

  // 5. Tone gate. Same abort rule as insights applies to a tone check that
  // never parses: nothing safe to degrade to, so the run aborts.
  const toneStart = Date.now()
  const toneResult = await structuredCall({
    chat: args.chat,
    model: args.model,
    system,
    messages: [{ role: 'user', content: toneCheckInstruction(narrative, survivors) }],
    schema: toneCheckOutputSchema,
  })
  record({ event: 'model_call', stage: 'tone_check', durationMs: Date.now() - toneStart })
  if (!toneResult.success) {
    const reason = `tone check failed validation twice: ${toneResult.error}`
    record({ event: 'outcome', outcome: 'aborted', reason })
    return { outcome: 'aborted', reason }
  }
  const recordVerdict = (verdict: ToneCheckOutput): void => {
    record({
      event: 'tone_verdict',
      narrativeOk: verdict.narrativeOk,
      reason: verdict.reason,
      flaggedInsightIndexes: verdict.flaggedInsightIndexes,
    })
  }
  recordVerdict(toneResult.data)
  survivors = dropFlagged(survivors, toneResult.data.flaggedInsightIndexes, record)
  if (survivors.length === 0) {
    const reason = 'no insight survived the tone check'
    record({ event: 'outcome', outcome: 'aborted', reason })
    return { outcome: 'aborted', reason }
  }

  if (!toneResult.data.narrativeOk) {
    // Regenerate the narrative once and re-check. Still bad: the run
    // completes but withholds dream.md, writing insight.md only.
    const retryStart = Date.now()
    narrative = (
      await args.chat.complete({
        model: args.model,
        system,
        messages: [
          ...followupMessages,
          { role: 'user', content: narrativeInstruction(args.voice) },
        ],
        temperature: 0.9,
      })
    ).text
    record({ event: 'model_call', stage: 'narrative_retry', durationMs: Date.now() - retryStart })

    const toneRetryStart = Date.now()
    const toneRetry = await structuredCall({
      chat: args.chat,
      model: args.model,
      system,
      messages: [{ role: 'user', content: toneCheckInstruction(narrative, survivors) }],
      schema: toneCheckOutputSchema,
    })
    record({
      event: 'model_call',
      stage: 'tone_check_retry',
      durationMs: Date.now() - toneRetryStart,
    })
    if (!toneRetry.success) {
      const reason = `tone check failed validation twice: ${toneRetry.error}`
      record({ event: 'outcome', outcome: 'aborted', reason })
      return { outcome: 'aborted', reason }
    }
    recordVerdict(toneRetry.data)
    survivors = dropFlagged(survivors, toneRetry.data.flaggedInsightIndexes, record)
    if (survivors.length === 0) {
      const reason = 'no insight survived the tone check'
      record({ event: 'outcome', outcome: 'aborted', reason })
      return { outcome: 'aborted', reason }
    }
    if (!toneRetry.data.narrativeOk) {
      record({ event: 'narrative_withheld', reason: toneRetry.data.reason })
      narrative = undefined
    }
  }

  // 6. Write. The dream directory is created only now, after every model
  // call has succeeded: a crashed or aborted run leaves nothing behind.
  record({ event: 'outcome', outcome: 'written', narrativeWithheld: narrative === undefined })
  const dreamId = newId('dream')
  const localDate = formatLocalDate(args.now, args.timezone)
  const dir = join(args.paths.dreamsDir, `${localDate}-${dreamId}`)
  await mkdir(dir, { recursive: true })
  if (narrative !== undefined) {
    await writeDocumentAtomic({
      path: join(dir, 'dream.md'),
      meta: {
        id: newId('doc'),
        kind: 'dream',
        dream: dreamId,
        date: localDate,
        period: args.period,
        voice: args.voice,
        seeds: args.seeds.map((s) => s.id),
      },
      body: narrative,
    })
  }
  await writeDocumentAtomic({
    path: join(dir, 'insight.md'),
    meta: {
      id: newId('doc'),
      kind: 'dream_insight',
      dream: dreamId,
      date: localDate,
      period: args.period,
      seeds: args.seeds.map((s) => s.id),
      rngSeed: args.rngSeed,
      trigger: args.trigger,
      insights: survivors,
    },
    body: survivors.map((i) => `## ${i.headline} (${i.id})\n\n${i.claim}`).join('\n\n'),
  })
  await writeFile(
    join(dir, 'process.jsonl'),
    `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
    'utf8',
  )
  await appendDreamLog(args.paths, [
    {
      ts: args.now.toISOString(),
      type: 'dreamt',
      dream: dreamId,
      period: args.period,
      entities: args.entitiesTouched,
    },
  ])
  return { outcome: 'written', dreamId, dir }
}
