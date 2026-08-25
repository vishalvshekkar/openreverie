import type { Session, StreamEvent, TranscriptLine } from './api.js'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  pending: boolean
  // Present only on role: 'tool'. name backs the human label a tool chip
  // renders (see TOOL_LABELS in views/Conversations.tsx, which this module
  // deliberately knows nothing about: the wording lives with the view).
  // status distinguishes a call still in flight from one that has
  // finished, so the reducer can flip a chip in place rather than deleting
  // and re-creating it.
  toolName?: string | undefined
  toolStatus?: 'running' | 'done'
}

export interface ChatState {
  session: Session | null
  messages: ChatMessage[]
  lastSequence: number
  sending: boolean
  thinking: boolean
  mode: string
  error: string | null
}

export type ChatAction =
  | { type: 'stream'; event: StreamEvent }
  | { type: 'resync'; lines: TranscriptLine[] }
  | { type: 'new-session'; session: Session }
  | { type: 'turn-start'; text: string }
  | { type: 'load-session'; session: Session; lines: TranscriptLine[] }
  | { type: 'clear-session' }

export const initialChatState: ChatState = {
  session: null,
  messages: [],
  lastSequence: 0,
  sending: false,
  thinking: false,
  mode: 'general',
  error: null,
}

function newMessageId(): string {
  return crypto.randomUUID()
}

function appendText(messages: ChatMessage[], value: string): ChatMessage[] {
  const last = messages[messages.length - 1]
  if (last && last.role === 'assistant' && last.pending) {
    const updated: ChatMessage = { ...last, content: last.content + value }
    return [...messages.slice(0, -1), updated]
  }
  return [...messages, { id: newMessageId(), role: 'assistant', content: value, pending: true }]
}

function finalizeTrailingAssistant(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1]
  if (last && last.role === 'assistant' && last.pending) {
    const updated: ChatMessage = { ...last, pending: false }
    return [...messages.slice(0, -1), updated]
  }
  return messages
}

/*
 * There is no tool-completion event anywhere in the stream (see StreamEvent
 * below: a 'tool' event fires when a call starts, and nothing fires when it
 * ends). The moment a 'tool' event, a 'text' event, or the turn's own
 * 'done'/'error' arrives is exactly the moment any previously running tool
 * call is known to have finished, so that is the signal this reducer uses
 * to flip a chip from its running form to its done form, in place, rather
 * than deleting it. The chip then stays in the thread permanently: the same
 * durable scrollback line the CLI already keeps for a tool call.
 */
function flipRunningTool(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1]
  if (last && last.role === 'tool' && last.toolStatus === 'running') {
    const updated: ChatMessage = { ...last, toolStatus: 'done' }
    return [...messages.slice(0, -1), updated]
  }
  return messages
}

// A new tool call starting settles whatever call preceded it (if any) before
// appending its own running chip, so at most one chip is ever "running" at a
// time.
function appendRunningTool(messages: ChatMessage[], name: string): ChatMessage[] {
  const settled = flipRunningTool(messages)
  return [
    ...settled,
    {
      id: newMessageId(),
      role: 'tool',
      content: '',
      pending: false,
      toolName: name,
      toolStatus: 'running',
    },
  ]
}

export function sessionReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'stream': {
      const event = action.event
      if (event.seq <= state.lastSequence) return state
      const lastSequence = event.seq
      switch (event.type) {
        case 'thinking':
          return { ...state, lastSequence, thinking: true }
        case 'text':
          return {
            ...state,
            lastSequence,
            messages: appendText(flipRunningTool(state.messages), event.text),
            thinking: false,
          }
        case 'tool':
          return { ...state, lastSequence, messages: appendRunningTool(state.messages, event.name) }
        case 'mode':
          return { ...state, lastSequence, mode: event.mode }
        case 'done':
          return {
            ...state,
            lastSequence,
            messages: finalizeTrailingAssistant(flipRunningTool(state.messages)),
            sending: false,
            thinking: false,
          }
        case 'error':
          return {
            ...state,
            lastSequence,
            messages: finalizeTrailingAssistant(flipRunningTool(state.messages)),
            sending: false,
            thinking: false,
            error: event.message,
          }
      }
      break
    }
    case 'resync':
      return {
        ...state,
        messages: messagesFromTranscript(action.lines),
        sending: false,
        thinking: false,
        error: null,
      }
    case 'new-session':
      return {
        ...initialChatState,
        session: action.session,
        mode: action.session.mode ?? initialChatState.mode,
      }
    case 'clear-session':
      return initialChatState
    case 'turn-start':
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: newMessageId(), role: 'user', content: action.text, pending: false },
        ],
        sending: true,
        thinking: false,
        error: null,
      }
    case 'load-session':
      return {
        ...initialChatState,
        session: action.session,
        messages: messagesFromTranscript(action.lines),
      }
  }
}

export function newTurnId(): string {
  return crypto.randomUUID()
}

/*
 * A tool's name lives only on the assistant transcript line that requested
 * it (TranscriptLine.toolCalls); the matching result line (role: 'tool')
 * carries only toolCallId. Resolving id -> name here is what lets a
 * reopened session show the same human label a live one does, rather than a
 * generic placeholder with no name to look up.
 */
export function messagesFromTranscript(lines: TranscriptLine[]): ChatMessage[] {
  const toolNameById = new Map<string, string>()
  const messages: ChatMessage[] = []
  for (const line of lines) {
    if (line.role === 'assistant') {
      for (const call of line.toolCalls ?? []) toolNameById.set(call.id, call.name)
      // The engine writes one assistant line per tool call in a round, and
      // only the first carries the announcement text: every line after the
      // first has empty content and exists only to carry its own toolCalls
      // entry. Rendering that as a blank "reverie" bubble is a defect, not
      // a quiet turn, so it is dropped here instead of passed through.
      if (line.content === '' && (line.toolCalls?.length ?? 0) > 0) continue
    }
    if (line.role === 'tool') {
      messages.push({
        id: `line-${line.lineSequence}`,
        role: 'tool',
        content: line.content,
        pending: false,
        toolName: line.toolCallId === undefined ? undefined : toolNameById.get(line.toolCallId),
        toolStatus: 'done',
      })
      continue
    }
    messages.push({
      id: `line-${line.lineSequence}`,
      role: line.role,
      content: line.content,
      pending: false,
    })
  }
  return messages
}
