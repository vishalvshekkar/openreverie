// First-run setup wizard for reverie: asks about the provider, API key
// handling, model choices, memory folder, and safety mode, then writes
// config.toml. The safety mode copy mirrors docs/superpowers/specs
// section 9 (Safety modes): both modes are described honestly, in two
// sentences each, with no preselected default.

import os from 'node:os'
import path from 'node:path'
import {
  defaultConfigPath,
  defaultCrisisResources,
  type ReverieConfig,
  saveConfig,
} from '@openreverie/core'

export interface SetupIo {
  question(prompt: string): Promise<string>
  write(text: string): void
}

const DEFAULT_CHAT_MODEL = 'gpt-5'
const DEFAULT_REFLECTION_MODEL = 'gpt-5-mini'
const DEFAULT_EMBEDDINGS_MODEL = 'text-embedding-3-small'
const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY'

function defaultMemoryDir(): string {
  return path.join(os.homedir(), '.reverie', 'memory')
}

async function ask(io: SetupIo, prompt: string): Promise<string> {
  const answer = await io.question(prompt)
  return answer.trim()
}

async function askWithDefault(io: SetupIo, label: string, fallback: string): Promise<string> {
  const answer = await ask(io, `${label} [${fallback}]: `)
  return answer === '' ? fallback : answer
}

async function askProvider(io: SetupIo): Promise<void> {
  const answer = await ask(io, 'Provider (only openai is supported right now) [openai]: ')
  if (answer !== '' && answer.toLowerCase() !== 'openai') {
    io.write('Only openai is supported right now. Using openai.\n')
  }
}

interface ApiKeyChoice {
  apiKeyEnv?: string
  apiKey?: string
}

async function askApiKey(io: SetupIo): Promise<ApiKeyChoice> {
  io.write(`How should reverie get your OpenAI API key?
  1. Environment variable (recommended). reverie reads the key at startup and it never touches the config file.
  2. Paste the key now. reverie stores it directly in config.toml. That file is written with 0600 permissions, readable only by your user account, but the key still sits in plaintext on disk.
`)

  for (;;) {
    const choice = await ask(io, 'Choice [1]: ')

    if (choice === '' || choice === '1') {
      const envName = await askWithDefault(io, 'Environment variable name', DEFAULT_API_KEY_ENV)
      return { apiKeyEnv: envName }
    }

    if (choice === '2') {
      for (;;) {
        const key = await ask(io, 'Paste your OpenAI API key: ')
        if (key !== '') {
          return { apiKey: key }
        }
        io.write('An empty key is not usable. Paste the key, or Ctrl+C to stop.\n')
      }
    }

    io.write('Enter 1 or 2.\n')
  }
}

async function askSafetyMode(io: SetupIo): Promise<'companion' | 'firewall'> {
  io.write(`Choose a safety mode. This shapes how reverie responds if a conversation moves into crisis territory (self-harm, acute distress). You can change this later in the config file.
  1. Companion (suggested). reverie stays present and keeps listening with warmth, never changing the subject or pulling away. It gently and persistently points you toward crisis resources and real people alongside staying in the conversation.
  2. Firewall. reverie states plainly that this is beyond what it should handle and gives you crisis resources and professional help immediately. It then declines to continue that specific thread until you move on, staying warm and firm rather than cold.
`)

  for (;;) {
    const choice = await ask(io, 'Choice (1 or 2, no default, this one matters): ')
    if (choice === '1') return 'companion'
    if (choice === '2') return 'firewall'
    io.write('Enter 1 or 2. There is no default for this one; pick deliberately.\n')
  }
}

export async function runSetup(io: SetupIo, configPath?: string): Promise<void> {
  io.write('Setting up reverie.\n\n')

  await askProvider(io)
  const keyChoice = await askApiKey(io)
  const chatModel = await askWithDefault(io, 'Chat model', DEFAULT_CHAT_MODEL)
  const reflectionModel = await askWithDefault(io, 'Reflection model', DEFAULT_REFLECTION_MODEL)
  const embeddingsModel = await askWithDefault(io, 'Embeddings model', DEFAULT_EMBEDDINGS_MODEL)
  const memoryDir = await askWithDefault(io, 'Memory folder', defaultMemoryDir())
  const mode = await askSafetyMode(io)

  io.write(
    '\nCrisis resources default to the US 988 lifeline and Find A Helpline (international). ' +
      'Edit safety.resources in the config file to add local or trusted contacts.\n',
  )

  const provider: ReverieConfig['provider'] = { name: 'openai' }
  if (keyChoice.apiKeyEnv !== undefined) provider.apiKeyEnv = keyChoice.apiKeyEnv
  if (keyChoice.apiKey !== undefined) provider.apiKey = keyChoice.apiKey

  const config: ReverieConfig = {
    memoryDir,
    provider,
    models: { chat: chatModel, reflection: reflectionModel, embeddings: embeddingsModel },
    safety: { mode, resources: defaultCrisisResources.map((resource) => ({ ...resource })) },
    // Wizard questions for style land in a later task; balanced/warm/listening
    // matches the zod defaults in @openreverie/core so this is a no-op for
    // anyone who has not been asked yet.
    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
  }

  const resolvedPath = configPath ?? defaultConfigPath()
  await saveConfig(config, resolvedPath)

  io.write(`\nWrote config to ${resolvedPath}.\nStart reverie with: reverie\n`)
}
