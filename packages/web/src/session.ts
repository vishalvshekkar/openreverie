import type { Session, StreamEvent, TranscriptLine } from './api.js'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  pending: boolean
}

export interface ChatState {
  session: Session | null
  messages: ChatMessage[]
  lastSequence: number
  sending: boolean
  thinking: boolean
  activeTool: string | null
  mode: string
  error: string | null
}

export type ChatAction =
  | { type: 'stream'; event: StreamEvent }
  | { type: 'resync'; lines: TranscriptLine[] }
  | { type: 'new-session'; session: Session }
  | { type: 'turn-start'; text: string }
  | { type: 'load-session'; session: Session; lines: TranscriptLine[] }

export const initialChatState: ChatState = {
  session: null,
  messages: [],
  lastSequence: 0,
  sending: false,
  thinking: false,
  activeTool: null,
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
            messages: appendText(state.messages, event.text),
            thinking: false,
            activeTool: null,
          }
        case 'tool':
          return { ...state, lastSequence, activeTool: event.name }
        case 'mode':
          return { ...state, lastSequence, mode: event.mode }
        case 'done':
          return {
            ...state,
            lastSequence,
            messages: finalizeTrailingAssistant(state.messages),
            sending: false,
            thinking: false,
            activeTool: null,
          }
        case 'error':
          return {
            ...state,
            lastSequence,
            messages: finalizeTrailingAssistant(state.messages),
            sending: false,
            thinking: false,
            activeTool: null,
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
        activeTool: null,
        error: null,
      }
    case 'new-session':
      return { ...initialChatState, session: action.session }
    case 'turn-start':
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: newMessageId(), role: 'user', content: action.text, pending: false },
        ],
        sending: true,
        thinking: false,
        activeTool: null,
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

export function messagesFromTranscript(lines: TranscriptLine[]): ChatMessage[] {
  return lines.map((line) => ({
    id: `line-${line.lineSequence}`,
    role: line.role,
    content: line.content,
    pending: false,
  }))
}
