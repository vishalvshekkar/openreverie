// Tool definitions offered to the chat model, and dispatch from a tool
// call to the MemoryEngine. This is the model's only way to reach into
// memory: it never sees the filesystem or the index directly.
//
// dispatchTool never throws. A malformed argument, an unknown tool name,
// or a failure inside the engine itself (a session id that does not
// exist, a proposal that is already resolved) all come back as a JSON
// string of the form {"error": "..."} instead of an exception. The
// calling loop treats every dispatch as a tool result to hand back to the
// model, so the model sees its own mistake in the transcript and can
// correct it, rather than the whole session crashing on a bad call.

import type {
  DocKind,
  GraphQuery,
  ListArcsOptions,
  ListEntitiesOptions,
  ListPeopleOptions,
  ListRealmsOptions,
  MemoryEngine,
} from '@openreverie/memory'
import { updateProfileArgsSchema } from '@openreverie/memory'
import type { ToolCall, ToolDefinition } from '@openreverie/providers'
import { z } from 'zod'
import { isModeName, MODE_NAMES, MODES, type ModeName } from './modes.js'

// Mode is session state, so it needs no persister and no injected
// configuration: AgentSession owns it, supplies this hook from runTurn,
// and therefore works identically in the CLI and the server by
// construction. This replaces the old ToolDeps, whose only member was a
// style persister that only the CLI ever wired up.
export interface ToolHooks {
  setMode?: (mode: ModeName) => Promise<void>
}

const searchMemoryArgs = z.strictObject({
  query: z.string(),
  kinds: z.array(z.string()).optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  limit: z.number().optional(),
})

const graphQueryArgs = z.strictObject({
  kind: z.enum(['neighbors', 'items_in_arc', 'arcs_involving_person']),
  nodeId: z.string(),
})

const readDocumentArgs = z.strictObject({
  docId: z.string(),
})

const readTranscriptArgs = z.strictObject({
  sessionId: z.string(),
})

const rememberArgs = z.strictObject({
  text: z.string(),
  kind: z.enum(['observation', 'feeling', 'event', 'intention']).optional(),
  eventTime: z.string().optional(),
})

const listArcsArgs = z.strictObject({
  status: z.enum(['active', 'dormant', 'closed']).optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
})

const listRealmsArgs = z.strictObject({
  offset: z.number().optional(),
  limit: z.number().optional(),
})

const listPeopleArgs = z.strictObject({
  nameContains: z.string().optional(),
  hasPage: z.boolean().optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
})

const listEntitiesArgs = z.strictObject({
  nameContains: z.string().optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
})

const setModeArgs = z.strictObject({ mode: z.string() })

export function toolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'search_memory',
      description:
        'Search memory before answering from a vague impression of what was probably said. Use this whenever the ' +
        'conversation touches something that might already be recorded: an ongoing arc, a past event, a person, a ' +
        'decision made earlier. Retrieve before asserting: check the record rather than guess. Results come back ' +
        'in two parts. documents are ranked passages from pages, summaries and rollups, each with a snippet. ' +
        'nodes are graph nodes whose name matches the query, including people and things that have no page of ' +
        'their own; a node hit carries an id you can pass to graph_query, and a docId only when a page exists. A ' +
        'node hit with hasPage: false means this person or thing is known and recorded, and there is nothing ' +
        'written about them beyond their name and their links.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to search for, in plain language.',
          },
          kinds: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Restrict results to these document kinds. Valid values: constitution, realm, arc, summary, ' +
              'rollup_daily, rollup_weekly, person, journal, journaling. Omit to search across all kinds.',
          },
          after: {
            type: 'string',
            description:
              'Only include dated artifacts on or after this date, YYYY-MM-DD. Dated artifacts are session ' +
              'summaries, daily rollups, weekly rollups, and journal entries; a weekly rollup matches if any day ' +
              'of its week falls in range. Living documents that are rewritten over time (the constitution, and ' +
              'realm, arc and person pages) have no single date and are never excluded by these filters. To ' +
              'search only within a date range, combine this with kinds.',
          },
          before: {
            type: 'string',
            description:
              'Only include dated artifacts on or before this date, YYYY-MM-DD. Dated artifacts are session ' +
              'summaries, daily rollups, weekly rollups, and journal entries; a weekly rollup matches if any day ' +
              'of its week falls in range. Living documents that are rewritten over time (the constitution, and ' +
              'realm, arc and person pages) have no single date and are never excluded by these filters. To ' +
              'search only within a date range, combine this with kinds.',
          },
          limit: {
            type: 'number',
            description:
              'Maximum number of results to return. Defaults to a small handful if omitted.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'graph_query',
      description:
        'Query the relationship graph directly, for structural facts a text search would not surface. Use ' +
        '"neighbors" to see everything linked to a node (a person, an item, an arc, a realm). Use "items_in_arc" to ' +
        'list what has been filed under a specific arc. Use "arcs_involving_person" to find every storyline a ' +
        'specific person appears in. In every case nodeId is the id of the node you are starting from. A returned ' +
        'node that has a page on disk carries a docId; pass that docId to read_document to get its full text.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['neighbors', 'items_in_arc', 'arcs_involving_person'],
            description: 'Which graph query to run.',
          },
          nodeId: {
            type: 'string',
            description:
              'The id of the node to query from: any node id for "neighbors", an arc id for "items_in_arc", a ' +
              'person id for "arcs_involving_person".',
          },
        },
        required: ['kind', 'nodeId'],
        additionalProperties: false,
      },
    },
    {
      name: 'read_document',
      description:
        'Read the full text of one document by id, when a search snippet or a rollup gist is not enough and you ' +
        'need the whole thing: the complete narrative of an arc, the full text of a daily rollup, the constitution ' +
        'in full. Returns the document metadata and its body.',
      parameters: {
        type: 'object',
        properties: {
          docId: {
            type: 'string',
            description: 'The id of the document to read.',
          },
        },
        required: ['docId'],
        additionalProperties: false,
      },
    },
    {
      name: 'read_transcript',
      description:
        'Read the verbatim transcript of a past session by session id, for full fidelity when a summary is not ' +
        'enough: exact wording, an exact quote, a detail a summary would have compressed away. Summaries are lossy ' +
        'on purpose; the transcript is not.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'The id of the session whose transcript to read.',
          },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
    },
    {
      name: 'remember',
      description:
        'Capture something worth recording right now, mid-session, when it is urgent or explicit enough that it ' +
        'should not wait for the automatic end-of-session reflection. This is for noting what is happening now, not ' +
        'for asserting or correcting facts about the past.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The thing to remember, in a short, clear sentence.',
          },
          kind: {
            type: 'string',
            enum: ['observation', 'feeling', 'event', 'intention'],
            description: 'What sort of thing this is. Defaults to observation if omitted.',
          },
          eventTime: {
            type: 'string',
            description:
              'When the thing happens or happened, in the person\'s own words ("tonight at 7.25", "last Tuesday"), only when they actually stated a time. Leave it out otherwise. This is separate from when they told you.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_arcs',
      description:
        'List the arcs (ongoing storylines) tracked in memory, with each arc id, name, status, when it was last ' +
        'touched, and the docId of its page when it has one. Pass that docId to read_document for the full ' +
        'narrative. Status comes from the arc page itself and is absent when the arc has no page or its page ' +
        'cannot be read. The system prompt preloads active arcs only, so this is the only way to reach a dormant ' +
        'or closed arc. Cheap orientation: use it to see what is open before deciding whether to search or read ' +
        'further. Results come back as a page: total is the true count, and hasMore says whether more remain.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'dormant', 'closed'],
            description: 'Return only arcs with this status. Omit to get arcs of every status.',
          },
          offset: {
            type: 'number',
            description: 'How many rows to skip. Defaults to 0.',
          },
          limit: {
            type: 'number',
            description: 'How many rows to return. Defaults to 50, and is capped at 200.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'list_realms',
      description:
        'List the realms (life domains) tracked in memory, with each realm id, name, and the docId of its page ' +
        'when it has one. Pass that docId to read_document for the full text. Cheap orientation, like list_arcs, ' +
        'for getting your bearings before a deeper lookup. Results come back as a page: total is the true count, ' +
        'and hasMore says whether more remain.',
      parameters: {
        type: 'object',
        properties: {
          offset: {
            type: 'number',
            description: 'How many rows to skip. Defaults to 0.',
          },
          limit: {
            type: 'number',
            description: 'How many rows to return. Defaults to 50, and is capped at 200.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'list_people',
      description:
        'List the people recorded in memory, with each person id, name, whether they have a page, the docId of ' +
        'that page when they do, and when they were first recorded. The system prompt shows only the most recent ' +
        'forty, so this is how you reach anyone older, and how you look someone up by name without guessing. A ' +
        'person with no page is still fully recorded: they have an id you can pass to graph_query, and nothing ' +
        'written about them beyond their name and their links. Results come back as a page: total is the true ' +
        'count of matching people, and hasMore says whether more remain.',
      parameters: {
        type: 'object',
        properties: {
          nameContains: {
            type: 'string',
            description:
              'Return only people whose name contains this text, case-insensitively. Omit to list everyone.',
          },
          hasPage: {
            type: 'boolean',
            description:
              'Return only people who have a page (true) or only those who do not (false). Omit for both.',
          },
          offset: {
            type: 'number',
            description: 'How many rows to skip. Defaults to 0.',
          },
          limit: {
            type: 'number',
            description: 'How many rows to return. Defaults to 50, and is capped at 200.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'list_entities',
      description:
        'List the entities recorded in memory (films, books, companies, places, bands, works of fiction), with ' +
        'each entity id, name, and when it was first recorded. The system prompt shows only the most recent ' +
        'thirty, so this is how you reach anything older. Entities have no pages in this release, so there is ' +
        'nothing to read beyond the name and what the graph links to it; pass the id to graph_query for that. ' +
        'Results come back as a page: total is the true count of matching entities, and hasMore says whether ' +
        'more remain.',
      parameters: {
        type: 'object',
        properties: {
          nameContains: {
            type: 'string',
            description:
              'Return only entities whose name contains this text, case-insensitively. Omit to list everything.',
          },
          offset: {
            type: 'number',
            description: 'How many rows to skip. Defaults to 0.',
          },
          limit: {
            type: 'number',
            description: 'How many rows to return. Defaults to 50, and is capped at 200.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'set_mode',
      description:
        'Change what this conversation is doing, when the person asks for something this conversation needs. ' +
        'The modes are: ' +
        MODE_NAMES.map((name) => `${name} (${MODES[name].summary})`).join('; ') +
        '. The change lasts for this conversation only and is not saved. If instead they are asking for a ' +
        'lasting change to how you talk with them in general, do not call this: point them at /style in the ' +
        'terminal or the settings pane in the browser, and say plainly that you do not change that setting ' +
        'yourself.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: [...MODE_NAMES],
            description: 'The mode this conversation should be in from now on.',
          },
        },
        required: ['mode'],
        additionalProperties: false,
      },
    },
    {
      name: 'update_profile',
      description:
        'Record a plain fact about the person in their profile, the moment you learn it: what they want to be ' +
        'called, their pronouns, where they live, their timezone, their birthday, what they do. Also record their ' +
        'answer about birthday greetings when they give it. Write a fact only when they have actually told you; ' +
        'never infer one, not pronouns from a name, not a location from a timezone, not a birthday from an ' +
        'offhand remark about turning thirty. This is for the current value of a fact. What a fact means to them, ' +
        'and how it changed, belongs in the record you write at the end of a session, not here. You cannot change ' +
        'how you talk with them from this tool; that is /style in the terminal or the settings pane in the browser.',
      parameters: {
        type: 'object',
        properties: {
          preferredName: {
            type: 'string',
            description: 'What to call them, which is not necessarily their legal name.',
          },
          pronouns: {
            type: 'string',
            description: 'Free text, exactly as they said it. Not a fixed list.',
          },
          location: { type: 'string', description: 'Where they live, as they say it.' },
          timezone: {
            type: 'string',
            description: 'Their IANA timezone, for example Asia/Kolkata or Europe/Berlin.',
          },
          birthday: {
            type: 'string',
            description: 'MM-DD, or YYYY-MM-DD when they gave the year. Never guess a year.',
          },
          occupation: { type: 'string', description: 'Their current role, as they describe it.' },
          birthdayGreetings: {
            type: 'boolean',
            description:
              'Whether they want you to say something on their birthday. Set this from their own answer, ' +
              'never on your own judgment.',
          },
        },
        additionalProperties: false,
      },
    },
  ]
}

export async function dispatchTool(
  engine: MemoryEngine,
  sessionId: string,
  call: ToolCall,
  hooks?: ToolHooks,
): Promise<string> {
  const parsedArgs = parseArguments(call.arguments)
  if (!parsedArgs.ok) {
    return errorJson(parsedArgs.error)
  }

  try {
    switch (call.name) {
      case 'search_memory':
        return await dispatchSearchMemory(engine, parsedArgs.value)
      case 'graph_query':
        return await dispatchGraphQuery(engine, parsedArgs.value)
      case 'read_document':
        return await dispatchReadDocument(engine, parsedArgs.value)
      case 'read_transcript':
        return await dispatchReadTranscript(engine, parsedArgs.value)
      case 'remember':
        return await dispatchRemember(engine, sessionId, parsedArgs.value)
      case 'list_arcs':
        return await dispatchListArcs(engine, parsedArgs.value)
      case 'list_realms':
        return await dispatchListRealms(engine, parsedArgs.value)
      case 'list_people':
        return await dispatchListPeople(engine, parsedArgs.value)
      case 'list_entities':
        return await dispatchListEntities(engine, parsedArgs.value)
      case 'set_mode':
        return await dispatchSetMode(hooks, parsedArgs.value)
      case 'update_profile':
        return await dispatchUpdateProfile(engine, parsedArgs.value)
      default:
        return errorJson(`unknown tool: ${call.name}`)
    }
  } catch (err) {
    return errorJson(errorMessage(err))
  }
}

async function dispatchSearchMemory(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = searchMemoryArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('search_memory', parsed.error))

  const { query, kinds, after, before, limit } = parsed.data
  const hasFilters = kinds !== undefined || after !== undefined || before !== undefined
  const filters = hasFilters
    ? {
        ...(kinds !== undefined ? { kinds: kinds as DocKind[] } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(before !== undefined ? { before } : {}),
      }
    : undefined

  const results = await engine.search(query, filters, limit)
  return JSON.stringify(results)
}

async function dispatchGraphQuery(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = graphQueryArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('graph_query', parsed.error))

  const query = toGraphQuery(parsed.data)
  const rows = engine.graphQuery(query)
  return JSON.stringify(rows)
}

function toGraphQuery(input: {
  kind: 'neighbors' | 'items_in_arc' | 'arcs_involving_person'
  nodeId: string
}): GraphQuery {
  if (input.kind === 'neighbors') return { kind: 'neighbors', nodeId: input.nodeId }
  if (input.kind === 'items_in_arc') return { kind: 'items_in_arc', arcId: input.nodeId }
  return { kind: 'arcs_involving_person', personId: input.nodeId }
}

async function dispatchReadDocument(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = readDocumentArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('read_document', parsed.error))

  const doc = await engine.readDocumentById(parsed.data.docId)
  if (!doc) return errorJson(`not found: ${parsed.data.docId}`)
  return JSON.stringify({ meta: doc.meta, body: doc.body })
}

async function dispatchReadTranscript(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = readTranscriptArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('read_transcript', parsed.error))

  const lines = await engine.readTranscript(parsed.data.sessionId)
  return JSON.stringify(lines)
}

async function dispatchRemember(
  engine: MemoryEngine,
  sessionId: string,
  value: unknown,
): Promise<string> {
  const parsed = rememberArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('remember', parsed.error))

  await engine.remember(sessionId, parsed.data.text, parsed.data.kind, parsed.data.eventTime)
  return JSON.stringify({ ok: true })
}

async function dispatchListArcs(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = listArcsArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('list_arcs', parsed.error))

  // Rebuilt key by key rather than spread: exactOptionalPropertyTypes
  // distinguishes an absent key from a key present and undefined, and zod's
  // .optional() types as `T | undefined`.
  const options: ListArcsOptions = {}
  if (parsed.data.status !== undefined) options.status = parsed.data.status
  if (parsed.data.offset !== undefined) options.offset = parsed.data.offset
  if (parsed.data.limit !== undefined) options.limit = parsed.data.limit

  return JSON.stringify(await engine.listArcs(options))
}

async function dispatchListRealms(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = listRealmsArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('list_realms', parsed.error))

  const options: ListRealmsOptions = {}
  if (parsed.data.offset !== undefined) options.offset = parsed.data.offset
  if (parsed.data.limit !== undefined) options.limit = parsed.data.limit

  return JSON.stringify(engine.listRealms(options))
}

async function dispatchListPeople(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = listPeopleArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('list_people', parsed.error))

  const options: ListPeopleOptions = {}
  if (parsed.data.nameContains !== undefined) options.nameContains = parsed.data.nameContains
  if (parsed.data.hasPage !== undefined) options.hasPage = parsed.data.hasPage
  if (parsed.data.offset !== undefined) options.offset = parsed.data.offset
  if (parsed.data.limit !== undefined) options.limit = parsed.data.limit

  return JSON.stringify(engine.listPeople(options))
}

async function dispatchListEntities(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = listEntitiesArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('list_entities', parsed.error))

  const options: ListEntitiesOptions = {}
  if (parsed.data.nameContains !== undefined) options.nameContains = parsed.data.nameContains
  if (parsed.data.offset !== undefined) options.offset = parsed.data.offset
  if (parsed.data.limit !== undefined) options.limit = parsed.data.limit

  return JSON.stringify(engine.listEntities(options))
}

async function dispatchSetMode(hooks: ToolHooks | undefined, value: unknown): Promise<string> {
  const parsed = setModeArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('set_mode', parsed.error))

  if (!isModeName(parsed.data.mode)) {
    return errorJson(`invalid arguments for set_mode: mode must be one of ${MODE_NAMES.join(', ')}`)
  }
  if (!hooks?.setMode) {
    return errorJson('set_mode is not available in this session')
  }
  await hooks.setMode(parsed.data.mode)
  return JSON.stringify({ ok: true, mode: parsed.data.mode })
}

// Unlike set_mode, this does not go through ToolHooks. Style lives in
// config.toml, whose path is a CLI concern core must not know; the profile
// lives in the memory folder, which MemoryEngine already owns. The schema
// is the shared MODEL-WRITE allowlist from @openreverie/memory, so this
// tool and MemoryEngine.updateProfile can never disagree about what a
// model may write. An invalid field (an unrecognized timezone, a malformed
// birthday) is a validation failure here, reported as a tool error rather
// than thrown, so the model sees its own mistake in the transcript and can
// correct it.
async function dispatchUpdateProfile(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = updateProfileArgsSchema.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('update_profile', parsed.error))

  const profile = await engine.updateProfile(parsed.data)
  return JSON.stringify({
    ok: true,
    timezone: profile.meta.timezone,
    message: 'Saved.',
  })
}

function parseArguments(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return { ok: true, value: {} }
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch (err) {
    return { ok: false, error: `could not parse tool arguments as JSON: ${errorMessage(err)}` }
  }
}

function zodErrorMessage(toolName: string, error: z.ZodError): string {
  const detail = error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ')
  return `invalid arguments for ${toolName}: ${detail}`
}

function errorJson(message: string): string {
  return JSON.stringify({ error: message })
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
