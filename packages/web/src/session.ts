import type { Session, StreamEvent, TranscriptLine } from './api.js'

export interface ChatState {
  session: Session | null
  events: StreamEvent[]
  transcript: TranscriptLine[] | null
  lastSequence: number
  sending: boolean
}

export type ChatAction =
  | { type: 'stream'; event: StreamEvent }
  | { type: 'resync'; lines: TranscriptLine[] }
  | { type: 'new-session'; session: Session }
  | { type: 'turn-start' }

export const initialChatState: ChatState = {
  session: null,
  events: [],
  transcript: null,
  lastSequence: 0,
  sending: false,
}

export function sessionReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'stream': {
      if (action.event.seq <= state.lastSequence) return state
      return {
        ...state,
        lastSequence: action.event.seq,
        events: [...state.events, action.event],
        sending: action.event.type !== 'done' && action.event.type !== 'error',
      }
    }
    case 'resync':
      return { ...state, transcript: action.lines, events: [], sending: false }
    case 'new-session':
      return { ...initialChatState, session: action.session }
    case 'turn-start':
      return { ...state, events: [], transcript: null, sending: true }
  }
}

export function newTurnId(): string {
  return crypto.randomUUID()
}
