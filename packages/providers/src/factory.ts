// Builds a ChatProvider or EmbeddingProvider from a plain selection object,
// typically resolved from config. This is the single place future adapters
// (anthropic, openrouter, and the rest) get registered.

import { OpenAiChatProvider, OpenAiEmbeddingProvider } from './openai.js'
import type { ChatProvider, EmbeddingProvider, FetchLike } from './types.js'

export interface ProviderSelection {
  provider: 'openai'
  apiKey: string
  baseUrl?: string
}

function openAiConfig(sel: ProviderSelection): { apiKey: string; baseUrl?: string } {
  return sel.baseUrl === undefined
    ? { apiKey: sel.apiKey }
    : { apiKey: sel.apiKey, baseUrl: sel.baseUrl }
}

export function createChatProvider(sel: ProviderSelection, fetchImpl?: FetchLike): ChatProvider {
  if (sel.provider === 'openai') {
    return new OpenAiChatProvider(openAiConfig(sel), fetchImpl)
  }
  throw new Error(`unknown provider: ${sel.provider}`)
}

export function createEmbeddingProvider(
  sel: ProviderSelection,
  fetchImpl?: FetchLike,
): EmbeddingProvider {
  if (sel.provider === 'openai') {
    return new OpenAiEmbeddingProvider(openAiConfig(sel), fetchImpl)
  }
  throw new Error(`unknown provider: ${sel.provider}`)
}
