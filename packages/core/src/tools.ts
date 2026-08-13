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

import type { DocKind, GraphQuery, MemoryEngine } from '@openreverie/memory'
import type { ToolCall, ToolDefinition } from '@openreverie/providers'
import { z } from 'zod'

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
})

const noArgs = z.strictObject({})

const resolveProposalArgs = z.strictObject({
  proposalId: z.string(),
  resolution: z.enum(['accepted', 'rejected']),
})

export function toolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'search_memory',
      description:
        'Search memory before answering from a vague impression of what was probably said. Use this whenever the ' +
        'conversation touches something that might already be recorded: an ongoing arc, a past event, a person, a ' +
        'decision made earlier. It runs a hybrid search over items, session summaries, rollups, and arc and realm ' +
        'pages, and returns ranked hits with a snippet from each. Retrieve before asserting: check the record rather ' +
        'than guess.',
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
              'rollup_daily, rollup_weekly. Omit to search across all kinds.',
          },
          after: {
            type: 'string',
            description: 'Only include results dated on or after this date (YYYY-MM-DD).',
          },
          before: {
            type: 'string',
            description: 'Only include results dated on or before this date (YYYY-MM-DD).',
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
        'specific person appears in. In every case nodeId is the id of the node you are starting from.',
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
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_arcs',
      description:
        'List every arc currently tracked, with its id, name, and status. Cheap orientation: use this to see what ' +
        'is currently open before deciding whether to search or read further.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'list_realms',
      description:
        'List every realm (life domain) currently tracked, with its id and name. Cheap orientation, like list_arcs, ' +
        'for getting your bearings before a deeper lookup.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'resolve_proposal',
      description:
        "Record the user's decision on a pending proposal: a memory update drafted by reflection (a new arc, a new " +
        'person, or a link between two existing things) but not yet confirmed. Use this only right after the user ' +
        'has actually said yes or no to a specific proposal you raised with them. Never resolve a proposal on your ' +
        'own judgment.',
      parameters: {
        type: 'object',
        properties: {
          proposalId: {
            type: 'string',
            description: 'The id of the proposal being resolved.',
          },
          resolution: {
            type: 'string',
            enum: ['accepted', 'rejected'],
            description: 'Whether the user accepted or rejected the proposal.',
          },
        },
        required: ['proposalId', 'resolution'],
        additionalProperties: false,
      },
    },
  ]
}

export async function dispatchTool(
  engine: MemoryEngine,
  sessionId: string,
  call: ToolCall,
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
      case 'resolve_proposal':
        return await dispatchResolveProposal(engine, parsedArgs.value)
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

  const hits = await engine.search(query, filters, limit)
  return JSON.stringify(hits)
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

  await engine.remember(sessionId, parsed.data.text, parsed.data.kind)
  return JSON.stringify({ ok: true })
}

async function dispatchListArcs(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = noArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('list_arcs', parsed.error))
  return JSON.stringify(engine.listArcs())
}

async function dispatchListRealms(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = noArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('list_realms', parsed.error))
  return JSON.stringify(engine.listRealms())
}

async function dispatchResolveProposal(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = resolveProposalArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('resolve_proposal', parsed.error))

  await engine.resolveProposal(parsed.data.proposalId, parsed.data.resolution)
  return JSON.stringify({ ok: true })
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
