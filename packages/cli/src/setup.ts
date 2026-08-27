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
  type StyleConfig,
  saveConfig,
} from '@openreverie/core'
import {
  ensureMemoryTree,
  loadProfile,
  memoryPaths,
  nodeStores,
  systemTimeZone,
  writeProfile,
} from '@openreverie/memory'

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

export interface StyleOption<T extends string> {
  value: T
  label: string
}

// One numbered choice per style axis, with a plain one-line, honest
// description per option and a sensible default that pressing enter
// accepts. Kept generic so the three axes below share one prompt-and-parse
// loop instead of three near-duplicates.
async function askStyleAxis<T extends string>(
  io: SetupIo,
  intro: string,
  options: StyleOption<T>[],
  defaultValue: T,
): Promise<T> {
  const defaultIndex = options.findIndex((option) => option.value === defaultValue) + 1
  const menu = options.map((option, i) => `  ${i + 1}. ${option.label}`).join('\n')
  io.write(`${intro}\n${menu}\n`)

  for (;;) {
    const choice = await ask(io, `Choice [${defaultIndex}]: `)
    if (choice === '') return defaultValue

    const index = Number.parseInt(choice, 10)
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      const chosen = options[index - 1]
      if (chosen) return chosen.value
    }
    io.write(`Enter a number from 1 to ${options.length}, or press enter for the default.\n`)
  }
}

async function askStyle(io: SetupIo): Promise<StyleConfig> {
  io.write(
    '\nA few quick questions about how reverie talks with you. These are starting points, not ' +
      'fixed forever: you can change any of them later with /style in the terminal, or in the ' +
      'settings pane in the browser.\n',
  )

  const engagement = await askStyleAxis<StyleConfig['engagement']>(
    io,
    '\nHow much should reverie initiate versus wait for you to bring things up?',
    [
      {
        value: 'leading',
        label:
          'Leading. reverie brings things up on its own and follows threads from earlier without being asked.',
      },
      {
        value: 'balanced',
        label:
          'Balanced (suggested). reverie mostly follows your lead, but will bring something back up if it seems worth it.',
      },
      {
        value: 'following',
        label:
          'Following. reverie waits for you to bring things up and rarely initiates on its own.',
      },
    ],
    'balanced',
  )

  const tone = await askStyleAxis<StyleConfig['tone']>(
    io,
    '\nWhat register should reverie speak in?',
    [
      {
        value: 'warm',
        label: 'Warm (suggested). Caring and gentle, the register of a close friend.',
      },
      {
        value: 'playful',
        label: 'Playful. Light and a little teasing when the moment allows it.',
      },
      {
        value: 'snarky',
        label: 'Snarky. Dry and a bit sharp-tongued, still on your side.',
      },
      {
        value: 'direct',
        label: 'Direct. Plain and to the point, little cushioning.',
      },
      {
        value: 'formal',
        label: 'Formal. More measured and reserved, less familiar.',
      },
    ],
    'warm',
  )

  const orientation = await askStyleAxis<StyleConfig['orientation']>(
    io,
    '\nWhen you bring something up, should reverie mostly listen or mostly offer next steps?',
    [
      {
        value: 'listening',
        label: 'Listening (suggested). Mostly reflects and asks questions, does not rush to solve.',
      },
      {
        value: 'balanced',
        label: 'Balanced. A mix of listening and offering a next step when that seems useful.',
      },
      {
        value: 'solutions',
        label: 'Solutions. Leans toward offering next steps and suggestions.',
      },
    ],
    'listening',
  )

  return { engagement, tone, orientation }
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

  const style = await askStyle(io)

  const provider: ReverieConfig['provider'] = { name: 'openai' }
  if (keyChoice.apiKeyEnv !== undefined) provider.apiKeyEnv = keyChoice.apiKeyEnv
  if (keyChoice.apiKey !== undefined) provider.apiKey = keyChoice.apiKey

  const config: ReverieConfig = {
    memoryDir,
    provider,
    models: { chat: chatModel, reflection: reflectionModel, embeddings: embeddingsModel },
    safety: { mode, resources: defaultCrisisResources.map((resource) => ({ ...resource })) },
    dreaming: {
      enabled: false,
      cadence: 'daily',
      triggers: { afterSession: true, onStart: true, serverTimer: true },
      maxToolCalls: 10,
    },
  }

  const resolvedPath = configPath ?? defaultConfigPath()
  await saveConfig(config, resolvedPath)

  // Order matters here, and getting it wrong loses data. Create the memory
  // tree first, because that is what seeds profile.md with a system-default
  // timezone when the file is absent; writing a profile before that step
  // means the seeding finds a file and skips. Then load, merge, and write
  // back, never write fresh, because a rerun on an existing folder would
  // otherwise discard every other field the person has.
  const paths = memoryPaths(memoryDir, nodeStores())
  // reverie setup genuinely runs on the person's own machine, so the
  // system zone is the honest default here, seeding profile.md the same
  // way ensureMemoryTree always has.
  const timezone = systemTimeZone()
  await ensureMemoryTree(paths, timezone)
  const profile = await loadProfile(paths, timezone)
  await writeProfile(paths, {
    ...profile,
    meta: { ...profile.meta, style: { ...(profile.meta.style ?? {}), ...style } },
  })
  io.write(`Wrote your style choices to ${paths.profile}.\n`)

  io.write(`\nWrote config to ${resolvedPath}.\nStart reverie with: reverie\n`)
}
