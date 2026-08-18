// Config schema, TOML persistence, and API key resolution for openreverie.
// The config file lives at ~/.reverie/config.toml by default and holds the
// provider choice, model names, safety mode, and crisis resources. See
// docs/superpowers/specs for the design.

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { StyleConfig } from '@openreverie/memory'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { z } from 'zod'

// StyleConfig lives in @openreverie/memory because style is stored in
// profile.md, whose schema lives there. Re-exported here so existing
// importers of @openreverie/core keep working; config.toml itself no
// longer holds style.
export type { StyleConfig }

export interface CrisisResource {
  label: string
  contact: string
}

export const defaultCrisisResources: CrisisResource[] = [
  { label: '988 Suicide and Crisis Lifeline (US)', contact: 'Call or text 988' },
  { label: 'Find A Helpline (international)', contact: 'findahelpline.com' },
]

export interface ReverieConfig {
  memoryDir: string
  provider: { name: 'openai'; apiKeyEnv?: string; apiKey?: string; baseUrl?: string }
  models: { chat: string; reflection: string; embeddings: string }
  safety: { mode: 'companion' | 'firewall'; resources: CrisisResource[] }
  style: StyleConfig
}

function defaultMemoryDir(): string {
  return path.join(os.homedir(), '.reverie', 'memory')
}

const crisisResourceSchema = z.strictObject({
  label: z.string(),
  contact: z.string(),
})

const providerSchema = z.strictObject({
  name: z.literal('openai'),
  apiKeyEnv: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
})

const modelsSchema = z.strictObject({
  chat: z.string().default('gpt-5'),
  reflection: z.string().default('gpt-5-mini'),
  embeddings: z.string().default('text-embedding-3-small'),
})

const safetySchema = z.strictObject({
  mode: z.enum(['companion', 'firewall']),
  resources: z
    .array(crisisResourceSchema)
    .default(() => defaultCrisisResources.map((resource) => ({ ...resource }))),
})

const styleSchema = z.strictObject({
  engagement: z.enum(['leading', 'balanced', 'following']).default('balanced'),
  tone: z.enum(['warm', 'playful', 'snarky', 'direct', 'formal']).default('warm'),
  orientation: z.enum(['listening', 'balanced', 'solutions']).default('listening'),
})

const configSchema = z.strictObject({
  memoryDir: z.string().default(defaultMemoryDir),
  provider: providerSchema,
  models: modelsSchema,
  safety: safetySchema,
  style: styleSchema,
})

// zod's object-level .default() only applies when a key is entirely absent,
// and it does not re-run the value through the nested schema. To get
// field-level defaults inside an omitted "models" or "style" section, we
// make sure the key is present (as an empty table) before validating.
function withNestedDefaultsFillable(raw: Record<string, unknown>): Record<string, unknown> {
  const filled = { ...raw }
  if (filled.models === undefined) {
    filled.models = {}
  }
  if (filled.style === undefined) {
    filled.style = {}
  }
  return filled
}

function formatZodError(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const location = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    if (issue.code === 'unrecognized_keys') {
      const label = issue.keys.length > 1 ? 'unknown keys' : 'unknown key'
      return `${location}: ${label} ${issue.keys.map((key) => `"${key}"`).join(', ')}`
    }
    return `${location}: ${issue.message}`
  })
  return lines.join('; ')
}

export function defaultConfigPath(): string {
  return path.join(os.homedir(), '.reverie', 'config.toml')
}

export async function loadConfig(configPath?: string): Promise<ReverieConfig> {
  const resolvedPath = configPath ?? defaultConfigPath()

  let text: string
  try {
    text = await readFile(resolvedPath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error('No config found. Run: reverie setup')
    }
    throw error
  }

  const raw = withNestedDefaultsFillable(parseToml(text) as Record<string, unknown>)
  const result = configSchema.safeParse(raw)
  if (!result.success) {
    throw new Error(`Invalid config at ${resolvedPath}: ${formatZodError(result.error)}`)
  }

  const parsed = result.data
  const provider: ReverieConfig['provider'] = { name: parsed.provider.name }
  if (parsed.provider.apiKeyEnv !== undefined) provider.apiKeyEnv = parsed.provider.apiKeyEnv
  if (parsed.provider.apiKey !== undefined) provider.apiKey = parsed.provider.apiKey
  if (parsed.provider.baseUrl !== undefined) provider.baseUrl = parsed.provider.baseUrl

  return {
    memoryDir: parsed.memoryDir,
    provider,
    models: parsed.models,
    safety: parsed.safety,
    style: parsed.style,
  }
}

export async function saveConfig(config: ReverieConfig, configPath?: string): Promise<void> {
  const resolvedPath = configPath ?? defaultConfigPath()
  const dir = path.dirname(resolvedPath)
  await mkdir(dir, { recursive: true })

  const text = stringifyToml(config as unknown as Record<string, unknown>)
  const tempPath = path.join(
    dir,
    `.${path.basename(resolvedPath)}.tmp-${randomBytes(6).toString('hex')}`,
  )

  await writeFile(tempPath, text, { encoding: 'utf8', mode: 0o600 })
  await rename(tempPath, resolvedPath)
}

export function resolveApiKey(config: ReverieConfig): string {
  const { apiKey, apiKeyEnv } = config.provider

  if (apiKey) {
    return apiKey
  }

  if (apiKeyEnv) {
    const fromEnv = process.env[apiKeyEnv]
    if (fromEnv) {
      return fromEnv
    }
    throw new Error(
      `No API key found. provider.apiKeyEnv names "${apiKeyEnv}", but that environment variable is not set. ` +
        'Set it, or set provider.apiKey directly in the config file.',
    )
  }

  throw new Error(
    'No API key configured. Set provider.apiKey in the config file, or set provider.apiKeyEnv to the name of ' +
      'an environment variable that holds the key.',
  )
}
