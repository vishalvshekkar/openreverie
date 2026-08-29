// Builds a ChatProvider or EmbeddingProvider from a plain selection object,
// typically resolved from config. This is the single place future adapters
// (anthropic, openrouter, and the rest) get registered.

import { OpenAiChatProvider, type OpenAiConfig, OpenAiEmbeddingProvider } from './openai.js'
import type { ChatProvider, EmbeddingProvider, FetchLike } from './types.js'

export interface ProviderSelection {
  provider: 'openai'
  apiKey: string
  baseUrl?: string
  // Passed straight through to OpenAiConfig.headers; see the comment
  // there for what it is for and how it is merged.
  headers?: Record<string, string>
}

function openAiConfig(sel: ProviderSelection): OpenAiConfig {
  const cfg: OpenAiConfig = { apiKey: sel.apiKey }
  if (sel.baseUrl !== undefined) cfg.baseUrl = sel.baseUrl
  if (sel.headers !== undefined) cfg.headers = sel.headers
  return cfg
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
