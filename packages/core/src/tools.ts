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

import type { DocKind, ForgetInput, GraphQuery, MemoryEngine } from '@openreverie/memory'
import type { ToolCall, ToolDefinition } from '@openreverie/providers'
import { z } from 'zod'
import type { StyleConfig } from './config.js'

// Core must not know config file paths or how style preferences are
// persisted: that is a CLI concern. ToolDeps is how a caller injects the
// one operation dispatchTool needs to fulfil update_style, without core
// ever importing from the config file layer. Optional because most tests
// and most tool calls never touch it; when update_style is called without
// one wired up, dispatch reports that plainly instead of throwing.
export interface ToolDeps {
  updateStyle?: (patch: Partial<StyleConfig>) => Promise<StyleConfig>
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
})

const noArgs = z.strictObject({})

const resolveProposalArgs = z.strictObject({
  proposalId: z.string(),
  resolution: z.enum(['accepted', 'rejected']),
})

const updateStyleArgs = z
  .strictObject({
    engagement: z.enum(['leading', 'balanced', 'following']).optional(),
    tone: z.enum(['warm', 'playful', 'snarky', 'direct', 'formal']).optional(),
    orientation: z.enum(['listening', 'balanced', 'solutions']).optional(),
  })
  .refine(
    (value) =>
      value.engagement !== undefined || value.tone !== undefined || value.orientation !== undefined,
    { message: 'at least one of engagement, tone, or orientation is required' },
  )

const forgetArgs = z.strictObject({
  what: z.string(),
  nodeIds: z.array(z.string()).optional(),
  edges: z
    .array(
      z.strictObject({
        edge: z.enum(['part_of', 'in', 'from', 'involves', 'relates_to']),
        from: z.string(),
        to: z.string(),
      }),
    )
    .optional(),
  documents: z.array(z.strictObject({ docId: z.string(), body: z.string() })).optional(),
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
              'rollup_daily, rollup_weekly, person. Omit to search across all kinds.',
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
    {
      name: 'update_style',
      description:
        'Change how you converse with this person going forward: engagement (leading, balanced, following), tone ' +
        '(warm, playful, snarky, direct, formal), or orientation (listening, balanced, solutions). Use this only ' +
        'when the person has actually asked to change how you talk with them, not on your own judgment. At least ' +
        'one field is required; omit the axes that should stay as they are. The change applies immediately, from ' +
        'that point in the conversation onward, and is saved so it persists into future sessions.',
      parameters: {
        type: 'object',
        properties: {
          engagement: {
            type: 'string',
            enum: ['leading', 'balanced', 'following'],
            description: 'How much you initiate versus wait to be led.',
          },
          tone: {
            type: 'string',
            enum: ['warm', 'playful', 'snarky', 'direct', 'formal'],
            description: 'The register you speak in.',
          },
          orientation: {
            type: 'string',
            enum: ['listening', 'balanced', 'solutions'],
            description:
              'Whether you mostly listen, balance listening and suggesting, or offer next steps.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'forget',
      description:
        'Remove or correct something from the record: retract a node or edge from the graph, rewrite a ' +
        'document to no longer state something, or both, in one call. Use this only when the user has actually ' +
        'asked you to forget, remove, or correct something, never on your own judgment. Read a document first if ' +
        'you plan to rewrite it: the body you supply replaces it completely, and an empty or whitespace-only body ' +
        'is refused. This never touches the transcript of any conversation; transcripts are permanent and are ' +
        'never edited by this or any other tool.',
      parameters: {
        type: 'object',
        properties: {
          what: {
            type: 'string',
            description:
              'A short, plain description of what is being forgotten. Used as the git commit message.',
          },
          nodeIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of person, arc, or entity nodes to retract from the graph.',
          },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                edge: {
                  type: 'string',
                  enum: ['part_of', 'in', 'from', 'involves', 'relates_to'],
                },
                from: { type: 'string' },
                to: { type: 'string' },
              },
              required: ['edge', 'from', 'to'],
              additionalProperties: false,
            },
            description:
              'Specific edges to retract, each naming the edge type and the two node ids it connects.',
          },
          documents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                docId: { type: 'string' },
                body: { type: 'string' },
              },
              required: ['docId', 'body'],
              additionalProperties: false,
            },
            description:
              'Documents to rewrite in full, with the fact removed. The body you provide replaces the ' +
              'document completely; an empty or whitespace-only body is refused.',
          },
        },
        required: ['what'],
        additionalProperties: false,
      },
    },
  ]
}

export async function dispatchTool(
  engine: MemoryEngine,
  sessionId: string,
  call: ToolCall,
  deps?: ToolDeps,
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
      case 'update_style':
        return await dispatchUpdateStyle(deps, parsedArgs.value)
      case 'forget':
        return await dispatchForget(engine, parsedArgs.value)
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

async function dispatchUpdateStyle(deps: ToolDeps | undefined, value: unknown): Promise<string> {
  const parsed = updateStyleArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('update_style', parsed.error))

  if (!deps?.updateStyle) {
    return errorJson('update_style is not available in this session: no persister is configured')
  }

  // zod's .optional() fields type as `T | undefined` even though an
  // absent key in the input yields an absent key in parsed.data, never an
  // explicit `undefined` value. exactOptionalPropertyTypes distinguishes
  // "absent" from "present and undefined", so the patch handed to the
  // persister is rebuilt key-by-key to match Partial<StyleConfig> exactly.
  const patch: Partial<StyleConfig> = {}
  if (parsed.data.engagement !== undefined) patch.engagement = parsed.data.engagement
  if (parsed.data.tone !== undefined) patch.tone = parsed.data.tone
  if (parsed.data.orientation !== undefined) patch.orientation = parsed.data.orientation

  const style = await deps.updateStyle(patch)
  return JSON.stringify({
    ok: true,
    style,
    message:
      'These settings apply from this moment onward in this conversation, and persist into future sessions.',
  })
}

async function dispatchForget(engine: MemoryEngine, value: unknown): Promise<string> {
  const parsed = forgetArgs.safeParse(value)
  if (!parsed.success) return errorJson(zodErrorMessage('forget', parsed.error))

  // Same reasoning as dispatchUpdateStyle's patch above: zod's .optional()
  // fields type as `T | undefined` even when the key itself is absent from
  // parsed.data, and exactOptionalPropertyTypes distinguishes "absent" from
  // "present and undefined". Rebuilt key-by-key so ForgetInput's optional
  // fields are only ever set when a value is actually present.
  const input: ForgetInput = { what: parsed.data.what }
  if (parsed.data.nodeIds !== undefined) input.nodeIds = parsed.data.nodeIds
  if (parsed.data.edges !== undefined) input.edges = parsed.data.edges
  if (parsed.data.documents !== undefined) input.documents = parsed.data.documents

  const result = await engine.forget(input)
  return JSON.stringify({ ok: true, ...result })
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
