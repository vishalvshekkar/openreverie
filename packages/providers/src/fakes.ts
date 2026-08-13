// Test fakes for ChatProvider and EmbeddingProvider. Exported for use in
// tests across every package, not just this one.

import type {
  ChatEvent,
  ChatProvider,
  ChatRequest,
  ChatResult,
  EmbeddingProvider,
} from './types.js'

function hash32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// A scripted result for FakeChatProvider. The base shape (`text`,
// `toolCalls`) is exactly ChatResult, so every existing call site that
// builds these as plain object literals keeps compiling and behaving
// unchanged. Two optional fields extend it for tests that need to probe
// streaming behavior a single-shot `text` string cannot express:
//
// - `textChunks`: when present, stream() yields one 'text' event per
//   array entry instead of a single event carrying the whole `text`
//   string.
// - `throwAfterTextEvents`: when present, stream() throws immediately
//   after yielding this many 'text' events, before any tool_call or done
//   event. Simulates a provider that fails mid-stream after some text has
//   already reached the caller.
export interface FakeChatResult extends ChatResult {
  textChunks?: string[]
  throwAfterTextEvents?: number
}

export class FakeChatProvider implements ChatProvider {
  readonly name = 'fake'
  readonly requests: ChatRequest[] = []
  private readonly scripted: FakeChatResult[]
  private cursor = 0

  constructor(scripted: FakeChatResult[]) {
    this.scripted = scripted
  }

  private next(): FakeChatResult {
    if (this.cursor >= this.scripted.length) {
      throw new Error('FakeChatProvider: scripted results exhausted')
    }
    const result = this.scripted[this.cursor]
    if (!result) {
      throw new Error('FakeChatProvider: scripted results exhausted')
    }
    this.cursor += 1
    return result
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req)
    return this.next()
  }

  stream(req: ChatRequest): AsyncIterable<ChatEvent> {
    this.requests.push(req)
    const result = this.next()
    return (async function* generate() {
      const chunks = result.textChunks ?? [result.text]
      let emitted = 0
      for (const chunk of chunks) {
        yield { type: 'text', text: chunk }
        emitted += 1
        if (result.throwAfterTextEvents !== undefined && emitted >= result.throwAfterTextEvents) {
          throw new Error('FakeChatProvider: scripted mid-stream failure')
        }
      }
      for (const toolCall of result.toolCalls) {
        yield { type: 'tool_call', toolCall }
      }
      yield { type: 'done' }
    })()
  }
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fake'

  async embed(_model: string, texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const raw = Array.from({ length: 8 }, (_, i) => (hash32(`${t}:${i}`) % 2000) / 1000 - 1)
      const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1
      return raw.map((v) => v / norm)
    })
  }
}
