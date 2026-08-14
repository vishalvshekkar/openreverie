## Commits (V1)
afa302e feat: conversational voice, style preferences, first-session flow

## Diff
diff --git a/packages/cli/src/chat.test.ts b/packages/cli/src/chat.test.ts
index 020bb31..9221fd1 100644
--- a/packages/cli/src/chat.test.ts
+++ b/packages/cli/src/chat.test.ts
@@ -19,20 +19,21 @@ import {
   printWarnings,
   runChat,
 } from './chat.js'
 
 function testConfig(memoryDir: string): ReverieConfig {
   return {
     memoryDir,
     provider: { name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
     models: { chat: 'fake-chat', reflection: 'fake-reflect', embeddings: 'fake-embed' },
     safety: { mode: 'companion', resources: [] },
+    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
   }
 }
 
 function fakeDeps(chat: FakeChatProvider): EngineDeps {
   return {
     chat,
     embeddings: new FakeEmbeddingProvider(),
     reflectionModel: 'fake-reflect',
     embeddingModel: 'fake-embed',
   }
diff --git a/packages/cli/src/e2e.test.ts b/packages/cli/src/e2e.test.ts
index 6a15b5f..0ab9850 100644
--- a/packages/cli/src/e2e.test.ts
+++ b/packages/cli/src/e2e.test.ts
@@ -68,20 +68,21 @@ beforeEach(async () => {
 afterEach(async () => {
   await rm(dir, { recursive: true, force: true })
 })
 
 function testConfig(): ReverieConfig {
   return {
     memoryDir: dir,
     provider: { name: 'openai', apiKey: 'test' },
     models: { chat: 'm', reflection: 'm', embeddings: 'm' },
     safety: { mode: 'companion', resources: [] },
+    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
   }
 }
 
 function fakeDeps(chat: FakeChatProvider): EngineDeps {
   return {
     chat,
     embeddings: new FakeEmbeddingProvider(),
     reflectionModel: 'm',
     embeddingModel: 'm',
   }
diff --git a/packages/cli/src/setup.ts b/packages/cli/src/setup.ts
index 5d6f325..1ae4522 100644
--- a/packages/cli/src/setup.ts
+++ b/packages/cli/src/setup.ts
@@ -109,17 +109,21 @@ export async function runSetup(io: SetupIo, configPath?: string): Promise<void>
 
   const provider: ReverieConfig['provider'] = { name: 'openai' }
   if (keyChoice.apiKeyEnv !== undefined) provider.apiKeyEnv = keyChoice.apiKeyEnv
   if (keyChoice.apiKey !== undefined) provider.apiKey = keyChoice.apiKey
 
   const config: ReverieConfig = {
     memoryDir,
     provider,
     models: { chat: chatModel, reflection: reflectionModel, embeddings: embeddingsModel },
     safety: { mode, resources: defaultCrisisResources.map((resource) => ({ ...resource })) },
+    // Wizard questions for style land in a later task; balanced/warm/listening
+    // matches the zod defaults in @openreverie/core so this is a no-op for
+    // anyone who has not been asked yet.
+    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
   }
 
   const resolvedPath = configPath ?? defaultConfigPath()
   await saveConfig(config, resolvedPath)
 
   io.write(`\nWrote config to ${resolvedPath}.\nStart reverie with: reverie\n`)
 }
diff --git a/packages/core/src/agent.test.ts b/packages/core/src/agent.test.ts
index a9276f6..eec6690 100644
--- a/packages/core/src/agent.test.ts
+++ b/packages/core/src/agent.test.ts
@@ -16,20 +16,21 @@ beforeEach(async () => {
 afterEach(async () => {
   await rm(dir, { recursive: true, force: true })
 })
 
 function testConfig(): ReverieConfig {
   return {
     memoryDir: dir,
     provider: { name: 'openai', apiKeyEnv: 'OPENREVERIE_TEST_KEY' },
     models: { chat: 'gpt-5', reflection: 'gpt-5-mini', embeddings: 'text-embedding-3-small' },
     safety: { mode: 'companion', resources: defaultCrisisResources },
+    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
   }
 }
 
 function fakeDeps(chat: FakeChatProvider): EngineDeps {
   return {
     chat,
     embeddings: new FakeEmbeddingProvider(),
     reflectionModel: 'fake-reflect',
     embeddingModel: 'fake-embed',
   }
diff --git a/packages/core/src/agent.ts b/packages/core/src/agent.ts
index d56ce43..a74fad5 100644
--- a/packages/core/src/agent.ts
+++ b/packages/core/src/agent.ts
@@ -11,21 +11,21 @@
 // Transcript-first discipline: every user line, assistant tool-call line,
 // tool result line, and final assistant text line is appended to the
 // on-disk transcript before it is added to the in-memory message history
 // that gets sent back to the model. The transcript is the durable record;
 // the in-memory history exists only for the life of this session object.
 
 import type { MemoryEngine } from '@openreverie/memory'
 import type { ChatProvider, ToolCall } from '@openreverie/providers'
 import type { ReverieConfig } from './config.js'
 import { assembleSystemPrompt } from './context.js'
-import { dispatchTool, toolDefinitions } from './tools.js'
+import { dispatchTool, type ToolDeps, toolDefinitions } from './tools.js'
 
 export type AgentEvent =
   | { type: 'text'; text: string }
   | { type: 'tool'; name: string }
   | { type: 'done' }
 
 const MAX_TOOL_ROUNDS = 8
 
 // A message this session ever appends is always user, assistant, or tool,
 // never system (the system prompt is passed separately on every request).
@@ -47,42 +47,47 @@ export class AgentSession {
   private readonly history: SessionMessage[] = []
   private ended = false
   // Concurrent send() calls are serialized behind this promise chain: the
   // Nth send() only begins running once the (N-1)th has fully completed
   // (its generator exhausted or thrown), so two overlapping callers never
   // race reads/writes of `history` or interleave transcript appends.
   // end() awaits the same chain so it never reflects a session while a
   // round is still being written.
   private sendChain: Promise<void> = Promise.resolve()
 
+  private readonly toolDeps: ToolDeps | undefined
+
   private constructor(
     engine: MemoryEngine,
     chat: ChatProvider,
     model: string,
     system: string,
     sessionId: string,
+    toolDeps: ToolDeps | undefined,
   ) {
     this.engine = engine
     this.chat = chat
     this.model = model
     this.system = system
     this.sessionId = sessionId
+    this.toolDeps = toolDeps
   }
 
   static async start(
     engine: MemoryEngine,
     config: ReverieConfig,
     chat: ChatProvider,
+    toolDeps?: ToolDeps,
   ): Promise<AgentSession> {
     const system = await assembleSystemPrompt(engine, config)
     const sessionId = await engine.startSession()
-    return new AgentSession(engine, chat, config.models.chat, system, sessionId)
+    return new AgentSession(engine, chat, config.models.chat, system, sessionId, toolDeps)
   }
 
   async *send(userText: string): AsyncIterable<AgentEvent> {
     if (this.ended) {
       throw new Error('AgentSession: send() called after end()')
     }
     // Queue behind whatever send() is currently running (or resolved,
     // if none is). Register this call's own gate in the chain before
     // awaiting anything, so a second, immediately-following send() (or
     // an end()) sees this one as already queued/in-flight.
@@ -154,21 +159,21 @@ export class AgentSession {
         // result line simply never happen, rather than the call being
         // told about but never recorded.
         await this.appendBoth({
           role: 'assistant',
           content: first ? text : '',
           toolCalls: [toolCall],
         })
         first = false
         yield { type: 'tool', name: toolCall.name }
 
-        const result = await dispatchTool(this.engine, this.sessionId, toolCall)
+        const result = await dispatchTool(this.engine, this.sessionId, toolCall, this.toolDeps)
         await this.appendBoth({ role: 'tool', content: result, toolCallId: toolCall.id })
       }
     }
 
     // Still calling tools after MAX_TOOL_ROUNDS rounds: everything from
     // those rounds is already appended above. Stop instead of making
     // another model call, rather than looping forever.
     yield { type: 'done' }
   }
 
diff --git a/packages/core/src/config.test.ts b/packages/core/src/config.test.ts
index 0828535..7e476fa 100644
--- a/packages/core/src/config.test.ts
+++ b/packages/core/src/config.test.ts
@@ -19,20 +19,21 @@ beforeEach(async () => {
 afterEach(() => {
   delete process.env.OPENREVERIE_TEST_KEY
 })
 
 function fullConfig(overrides: Partial<ReverieConfig> = {}): ReverieConfig {
   return {
     memoryDir: '/somewhere/memory',
     provider: { name: 'openai', apiKeyEnv: 'OPENREVERIE_TEST_KEY' },
     models: { chat: 'gpt-5', reflection: 'gpt-5-mini', embeddings: 'text-embedding-3-small' },
     safety: { mode: 'companion', resources: defaultCrisisResources },
+    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
     ...overrides,
   }
 }
 
 describe('saveConfig and loadConfig round trip', () => {
   it('reloads exactly what was saved', async () => {
     const configPath = path.join(dir, 'config.toml')
     const config = fullConfig()
 
     await saveConfig(config, configPath)
@@ -48,20 +49,32 @@ describe('saveConfig and loadConfig round trip', () => {
         mode: 'firewall',
         resources: [{ label: 'Local crisis line', contact: '555-0100' }],
       },
     })
 
     await saveConfig(config, configPath)
     const loaded = await loadConfig(configPath)
 
     expect(loaded).toEqual(config)
   })
+
+  it('preserves a non-default style selection', async () => {
+    const configPath = path.join(dir, 'config.toml')
+    const config = fullConfig({
+      style: { engagement: 'following', tone: 'snarky', orientation: 'solutions' },
+    })
+
+    await saveConfig(config, configPath)
+    const loaded = await loadConfig(configPath)
+
+    expect(loaded).toEqual(config)
+  })
 })
 
 describe('loadConfig defaults', () => {
   it('applies memoryDir, models, and crisis resource defaults when those sections are omitted', async () => {
     const configPath = path.join(dir, 'config.toml')
     await writeFile(
       configPath,
       [
         '[provider]',
         'name = "openai"',
@@ -77,20 +90,70 @@ describe('loadConfig defaults', () => {
     const loaded = await loadConfig(configPath)
 
     expect(loaded.memoryDir).toBe(path.join(os.homedir(), '.reverie', 'memory'))
     expect(loaded.models).toEqual({
       chat: 'gpt-5',
       reflection: 'gpt-5-mini',
       embeddings: 'text-embedding-3-small',
     })
     expect(loaded.safety.resources).toEqual(defaultCrisisResources)
     expect(loaded.safety.resources).not.toBe(defaultCrisisResources)
+    expect(loaded.style).toEqual({ engagement: 'balanced', tone: 'warm', orientation: 'listening' })
+  })
+
+  it('applies balanced/warm/listening style defaults when the [style] section is omitted entirely', async () => {
+    const configPath = path.join(dir, 'config.toml')
+    await writeFile(
+      configPath,
+      [
+        '[provider]',
+        'name = "openai"',
+        'apiKey = "sk-test"',
+        '',
+        '[safety]',
+        'mode = "companion"',
+        '',
+      ].join('\n'),
+      'utf8',
+    )
+
+    const loaded = await loadConfig(configPath)
+
+    expect(loaded.style).toEqual({ engagement: 'balanced', tone: 'warm', orientation: 'listening' })
+  })
+
+  it('fills a defaulted field when the [style] section is present but partial', async () => {
+    const configPath = path.join(dir, 'config.toml')
+    await writeFile(
+      configPath,
+      [
+        '[provider]',
+        'name = "openai"',
+        'apiKey = "sk-test"',
+        '',
+        '[safety]',
+        'mode = "companion"',
+        '',
+        '[style]',
+        'tone = "playful"',
+        '',
+      ].join('\n'),
+      'utf8',
+    )
+
+    const loaded = await loadConfig(configPath)
+
+    expect(loaded.style).toEqual({
+      engagement: 'balanced',
+      tone: 'playful',
+      orientation: 'listening',
+    })
   })
 })
 
 describe('loadConfig missing file', () => {
   it('throws a plain error naming the setup command', async () => {
     const configPath = path.join(dir, 'does-not-exist.toml')
 
     await expect(loadConfig(configPath)).rejects.toThrow('No config found. Run: reverie setup')
   })
 })
@@ -136,20 +199,63 @@ describe('loadConfig unknown keys', () => {
 
     await expect(loadConfig(configPath)).rejects.toThrow('notARealField')
   })
 
   it('requires an explicit safety section rather than silently defaulting the mode', async () => {
     const configPath = path.join(dir, 'config.toml')
     await writeFile(configPath, ['[provider]', 'name = "openai"', ''].join('\n'), 'utf8')
 
     await expect(loadConfig(configPath)).rejects.toThrow(/safety/)
   })
+
+  it('rejects an unknown key inside the style section and names it', async () => {
+    const configPath = path.join(dir, 'config.toml')
+    await writeFile(
+      configPath,
+      [
+        '[provider]',
+        'name = "openai"',
+        '',
+        '[safety]',
+        'mode = "companion"',
+        '',
+        '[style]',
+        'tone = "warm"',
+        'bogusStyleField = "oops"',
+        '',
+      ].join('\n'),
+      'utf8',
+    )
+
+    await expect(loadConfig(configPath)).rejects.toThrow('bogusStyleField')
+  })
+
+  it('rejects an invalid enum value for a style axis', async () => {
+    const configPath = path.join(dir, 'config.toml')
+    await writeFile(
+      configPath,
+      [
+        '[provider]',
+        'name = "openai"',
+        '',
+        '[safety]',
+        'mode = "companion"',
+        '',
+        '[style]',
+        'tone = "grumpy"',
+        '',
+      ].join('\n'),
+      'utf8',
+    )
+
+    await expect(loadConfig(configPath)).rejects.toThrow(/style.tone/)
+  })
 })
 
 describe('saveConfig file permissions', () => {
   it('writes the config file with 0600 permissions', async () => {
     const configPath = path.join(dir, 'config.toml')
     await saveConfig(fullConfig(), configPath)
 
     const info = await stat(configPath)
     expect(info.mode & 0o777).toBe(0o600)
   })
diff --git a/packages/core/src/config.ts b/packages/core/src/config.ts
index 90aff3a..28f165f 100644
--- a/packages/core/src/config.ts
+++ b/packages/core/src/config.ts
@@ -13,25 +13,32 @@ import { z } from 'zod'
 export interface CrisisResource {
   label: string
   contact: string
 }
 
 export const defaultCrisisResources: CrisisResource[] = [
   { label: '988 Suicide and Crisis Lifeline (US)', contact: 'Call or text 988' },
   { label: 'Find A Helpline (international)', contact: 'findahelpline.com' },
 ]
 
+export interface StyleConfig {
+  engagement: 'leading' | 'balanced' | 'following'
+  tone: 'warm' | 'playful' | 'snarky' | 'direct' | 'formal'
+  orientation: 'listening' | 'balanced' | 'solutions'
+}
+
 export interface ReverieConfig {
   memoryDir: string
   provider: { name: 'openai'; apiKeyEnv?: string; apiKey?: string; baseUrl?: string }
   models: { chat: string; reflection: string; embeddings: string }
   safety: { mode: 'companion' | 'firewall'; resources: CrisisResource[] }
+  style: StyleConfig
 }
 
 function defaultMemoryDir(): string {
   return path.join(os.homedir(), '.reverie', 'memory')
 }
 
 const crisisResourceSchema = z.strictObject({
   label: z.string(),
   contact: z.string(),
 })
@@ -49,36 +56,46 @@ const modelsSchema = z.strictObject({
   embeddings: z.string().default('text-embedding-3-small'),
 })
 
 const safetySchema = z.strictObject({
   mode: z.enum(['companion', 'firewall']),
   resources: z
     .array(crisisResourceSchema)
     .default(() => defaultCrisisResources.map((resource) => ({ ...resource }))),
 })
 
+const styleSchema = z.strictObject({
+  engagement: z.enum(['leading', 'balanced', 'following']).default('balanced'),
+  tone: z.enum(['warm', 'playful', 'snarky', 'direct', 'formal']).default('warm'),
+  orientation: z.enum(['listening', 'balanced', 'solutions']).default('listening'),
+})
+
 const configSchema = z.strictObject({
   memoryDir: z.string().default(defaultMemoryDir),
   provider: providerSchema,
   models: modelsSchema,
   safety: safetySchema,
+  style: styleSchema,
 })
 
 // zod's object-level .default() only applies when a key is entirely absent,
 // and it does not re-run the value through the nested schema. To get
-// field-level defaults inside an omitted "models" section, we make sure the
-// key is present (as an empty table) before validating.
+// field-level defaults inside an omitted "models" or "style" section, we
+// make sure the key is present (as an empty table) before validating.
 function withNestedDefaultsFillable(raw: Record<string, unknown>): Record<string, unknown> {
   const filled = { ...raw }
   if (filled.models === undefined) {
     filled.models = {}
   }
+  if (filled.style === undefined) {
+    filled.style = {}
+  }
   return filled
 }
 
 function formatZodError(error: z.ZodError): string {
   const lines = error.issues.map((issue) => {
     const location = issue.path.length > 0 ? issue.path.join('.') : '(root)'
     if (issue.code === 'unrecognized_keys') {
       const label = issue.keys.length > 1 ? 'unknown keys' : 'unknown key'
       return `${location}: ${label} ${issue.keys.map((key) => `"${key}"`).join(', ')}`
     }
@@ -114,20 +131,21 @@ export async function loadConfig(configPath?: string): Promise<ReverieConfig> {
   const provider: ReverieConfig['provider'] = { name: parsed.provider.name }
   if (parsed.provider.apiKeyEnv !== undefined) provider.apiKeyEnv = parsed.provider.apiKeyEnv
   if (parsed.provider.apiKey !== undefined) provider.apiKey = parsed.provider.apiKey
   if (parsed.provider.baseUrl !== undefined) provider.baseUrl = parsed.provider.baseUrl
 
   return {
     memoryDir: parsed.memoryDir,
     provider,
     models: parsed.models,
     safety: parsed.safety,
+    style: parsed.style,
   }
 }
 
 export async function saveConfig(config: ReverieConfig, configPath?: string): Promise<void> {
   const resolvedPath = configPath ?? defaultConfigPath()
   const dir = path.dirname(resolvedPath)
   await mkdir(dir, { recursive: true })
 
   const text = stringifyToml(config as unknown as Record<string, unknown>)
   const tempPath = path.join(
diff --git a/packages/core/src/context.test.ts b/packages/core/src/context.test.ts
index 517c626..136ec43 100644
--- a/packages/core/src/context.test.ts
+++ b/packages/core/src/context.test.ts
@@ -19,20 +19,21 @@ import { afterEach, beforeEach, describe, expect, it } from 'vitest'
 import { defaultCrisisResources, type ReverieConfig } from './config.js'
 import { assembleSystemPrompt } from './context.js'
 import { buildPersona } from './personas.js'
 
 function testConfig(overrides: Partial<ReverieConfig> = {}): ReverieConfig {
   return {
     memoryDir: '/somewhere/memory',
     provider: { name: 'openai', apiKeyEnv: 'OPENREVERIE_TEST_KEY' },
     models: { chat: 'gpt-5', reflection: 'gpt-5-mini', embeddings: 'text-embedding-3-small' },
     safety: { mode: 'companion', resources: defaultCrisisResources },
+    style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
     ...overrides,
   }
 }
 
 function fakeDeps(chat: FakeChatProvider): EngineDeps {
   return {
     chat,
     embeddings: new FakeEmbeddingProvider(),
     reflectionModel: 'fake-reflect',
     embeddingModel: 'fake-embed',
@@ -127,21 +128,21 @@ describe('assembleSystemPrompt', () => {
       payload: { edge: 'part_of', from: newId('item'), to: arcId, confidence: 0.5 },
       source: 'session_seed',
     }
     await appendProposals(paths, [proposal])
 
     const config = testConfig()
     const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
 
     const prompt = await assembleSystemPrompt(engine, config)
 
-    const persona = buildPersona(config.safety.mode, config.safety.resources)
+    const persona = buildPersona(config.safety.mode, config.safety.resources, config.style)
     expect(prompt.startsWith(persona)).toBe(true)
 
     expect(prompt).toContain('## Constitution')
     expect(prompt).toContain('The user prefers direct, unflinching honesty over comfort.')
 
     expect(prompt).toContain('## Realms')
     expect(prompt).toContain('Fitness')
 
     expect(prompt).toContain('## Active arcs')
     expect(prompt).toContain('Marathon Training')
@@ -173,25 +174,47 @@ describe('assembleSystemPrompt', () => {
       '## Pending proposals',
     ]
     const positions = headers.map((header) => prompt.indexOf(header))
     expect(positions.every((position) => position >= 0)).toBe(true)
     expect(positions).toEqual([...positions].sort((a, b) => a - b))
 
     await engine.close()
   })
 
   it('omits sections with no content instead of leaving empty headers', async () => {
+    // A dormant arc (not active, so it never populates "## Active arcs")
+    // is enough to make this memory not a first session, so the normal
+    // optional-section rendering (rather than the first-conversation
+    // flow) is what is under test here.
+    const dormantArcPath = join(paths.arcsDir, 'dormant-arc.md')
+    await writeDocumentAtomic({
+      path: dormantArcPath,
+      meta: { id: newId('doc'), name: 'Dormant Arc', status: 'dormant' },
+      body: 'On pause.\n',
+    })
+    await appendGraph(paths, [
+      {
+        ts: '2026-08-01T00:00:00.000Z',
+        op: 'assert',
+        node: 'arc_dormant',
+        type: 'arc',
+        label: 'Dormant Arc',
+        doc: dormantArcPath,
+      },
+    ])
+
     const config = testConfig()
     const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
 
     const prompt = await assembleSystemPrompt(engine, config)
 
+    expect(prompt).not.toContain('## First conversation')
     expect(prompt).toContain('## Constitution')
     expect(prompt).not.toContain('## Realms')
     expect(prompt).not.toContain('## Active arcs')
     expect(prompt).not.toContain('## Latest daily rollup')
     expect(prompt).not.toContain('## Yesterday')
     expect(prompt).not.toContain('## Pending proposals')
 
     await engine.close()
   })
 
@@ -205,20 +228,39 @@ describe('assembleSystemPrompt', () => {
     await appendGraph(paths, [
       {
         ts: '2026-08-01T00:00:00.000Z',
         op: 'assert',
         node: 'realm_fitness',
         type: 'realm',
         label: 'Fitness',
         doc: realmPath,
       },
     ])
+    // An arc (any status) is enough to make this not a first session, so
+    // the normal optional-section rendering applies here rather than the
+    // first-conversation flow.
+    const arcPath = join(paths.arcsDir, 'marathon.md')
+    await writeDocumentAtomic({
+      path: arcPath,
+      meta: { id: newId('doc'), name: 'Marathon Training', status: 'active' },
+      body: 'Training for the fall marathon.\n',
+    })
+    await appendGraph(paths, [
+      {
+        ts: '2026-08-01T00:00:00.000Z',
+        op: 'assert',
+        node: 'arc_marathon',
+        type: 'arc',
+        label: 'Marathon Training',
+        doc: arcPath,
+      },
+    ])
 
     const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
     const prompt = await assembleSystemPrompt(engine, testConfig())
 
     expect(prompt).toContain('## Realms')
     expect(prompt).toContain('Fitness')
     expect(prompt).toContain('Running, lifting, and sleep consistency.')
     // Only the first line, not the second, so it does not spill the whole body.
     expect(prompt).not.toContain('More notes below.')
 
@@ -260,26 +302,106 @@ describe('assembleSystemPrompt', () => {
 
     await engine.close()
   })
 
   it('renders the firewall persona at the top when the configured mode is firewall', async () => {
     const config = testConfig({ safety: { mode: 'firewall', resources: defaultCrisisResources } })
     const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
 
     const prompt = await assembleSystemPrompt(engine, config)
 
-    const persona = buildPersona('firewall', defaultCrisisResources)
+    const persona = buildPersona('firewall', defaultCrisisResources, config.style)
     expect(prompt.startsWith(persona)).toBe(true)
 
     await engine.close()
   })
 
+  describe('first conversation', () => {
+    it('renders a First conversation section instead of the usual optional sections on a completely fresh engine', async () => {
+      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
+      const prompt = await assembleSystemPrompt(engine, testConfig())
+
+      expect(prompt).toContain('## First conversation')
+      expect(prompt).not.toContain('## Constitution')
+      expect(prompt).not.toContain('## Realms')
+      expect(prompt).not.toContain('## Active arcs')
+      expect(prompt).not.toContain('## Latest daily rollup')
+      expect(prompt).not.toContain('## Yesterday')
+      expect(prompt).not.toContain('## Pending proposals')
+
+      const lower = prompt.toLowerCase()
+      // Guardrail: memory is empty, so nothing to search, and never offer
+      // to pick up from before (a brand-new user has no "before").
+      expect(lower).toContain('nothing to search')
+      expect(lower).not.toContain('pick up')
+
+      // A short warm welcome: private, runs on their machine, remembers so
+      // future sessions start with context, and one clause that it is not
+      // a therapist.
+      expect(lower).toContain('private')
+      expect(lower).toContain('own machine')
+      expect(lower).toContain('not a therapist')
+
+      // Gentle, one-question-at-a-time onboarding.
+      expect(lower).toContain('name')
+      expect(lower).toContain('pronoun')
+      expect(lower).toContain('timezone')
+      expect(lower).toContain('one question at a time')
+
+      await engine.close()
+    })
+
+    it('omits the First conversation section once a session has been reflected', async () => {
+      const startedAt = new Date(Date.now() - 24 * 60 * 60 * 1000)
+      const store = await SessionStore.start(paths, startedAt)
+      await store.appendLine({ ts: startedAt.toISOString(), role: 'user', content: 'Hello.' })
+      await writeDocumentAtomic({
+        path: join(store.dir, 'summary.md'),
+        meta: { id: newId('doc') },
+        body: 'A first, brief hello.\n',
+      })
+
+      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
+      const prompt = await assembleSystemPrompt(engine, testConfig())
+
+      expect(prompt).not.toContain('## First conversation')
+
+      await engine.close()
+    })
+
+    it('omits the First conversation section when an arc already exists, even with no reflected sessions', async () => {
+      const arcPath = join(paths.arcsDir, 'marathon.md')
+      await writeDocumentAtomic({
+        path: arcPath,
+        meta: { id: newId('doc'), name: 'Marathon Training', status: 'active' },
+        body: 'Training for the fall marathon.\n',
+      })
+      await appendGraph(paths, [
+        {
+          ts: '2026-08-01T00:00:00.000Z',
+          op: 'assert',
+          node: 'arc_marathon',
+          type: 'arc',
+          label: 'Marathon Training',
+          doc: arcPath,
+        },
+      ])
+
+      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
+      const prompt = await assembleSystemPrompt(engine, testConfig())
+
+      expect(prompt).not.toContain('## First conversation')
+
+      await engine.close()
+    })
+  })
+
   it('never contains an em dash character', async () => {
     const arcPath = join(paths.arcsDir, 'marathon.md')
     await writeDocumentAtomic({
       path: arcPath,
       meta: { id: newId('doc'), name: 'Marathon Training', status: 'active' },
       body: 'Training for the fall marathon.\n',
     })
     await appendGraph(paths, [
       {
         ts: '2026-08-01T00:00:00.000Z',
diff --git a/packages/core/src/context.ts b/packages/core/src/context.ts
index b0325f7..c39ad1a 100644
--- a/packages/core/src/context.ts
+++ b/packages/core/src/context.ts
@@ -9,35 +9,53 @@
 
 import type { MemoryEngine, SessionContext } from '@openreverie/memory'
 import type { ReverieConfig } from './config.js'
 import { buildPersona } from './personas.js'
 
 export async function assembleSystemPrompt(
   engine: MemoryEngine,
   config: ReverieConfig,
 ): Promise<string> {
   const context = await engine.sessionContext()
-  const persona = buildPersona(config.safety.mode, config.safety.resources)
+  const persona = buildPersona(config.safety.mode, config.safety.resources, config.style)
+
+  if (context.isFirstSession) {
+    return [persona, firstConversationSection()].join('\n\n')
+  }
 
   const sections = [
     persona,
     constitutionSection(context),
     realmsSection(context),
     arcsSection(context),
     latestDailyRollupSection(context),
     yesterdaySection(context),
     pendingProposalsSection(context),
   ].filter((section): section is string => section !== undefined)
 
   return sections.join('\n\n')
 }
 
+// Replaces every usual optional section when this is the first conversation
+// this memory has ever had: there is no constitution worth reciting, no
+// realms, no arcs, nothing yesterday, nothing pending. Instead of any of
+// that, guide a short, warm, unhurried onboarding.
+function firstConversationSection(): string {
+  return `## First conversation
+
+This is the very first conversation in this memory. Open with a short, warm welcome, two or three sentences: reverie is private and runs entirely on their own machine, and it remembers what they tell it so future conversations start with real context instead of from scratch. Include one clause making clear you are not a therapist, just so that is said plainly from the start.
+
+Then get to know them gently, one question at a time, waiting for their answer before moving to the next: first their name and how they would like to be addressed (pronouns included), then where they live and their timezone, then one thing currently going on in their life, small or large, whatever comes to mind first. Do not stack these into one message. Ask, wait, listen, then ask the next.
+
+The memory is empty right now: there is nothing to search, nothing to retrieve, no earlier session to reference. Do not call a memory tool looking for history that is not there. Do not tell them you can continue where an earlier conversation left off, or greet them as though you already know them. There is no earlier conversation. This is the first one.`
+}
+
 function constitutionSection(context: SessionContext): string | undefined {
   const text = context.constitution.trim()
   if (text.length === 0) return undefined
   return `## Constitution\n\n${text}`
 }
 
 function realmsSection(context: SessionContext): string | undefined {
   if (context.realms.length === 0) return undefined
   const lines = context.realms.map((realm) => {
     const firstLine = realm.firstLine.trim()
diff --git a/packages/core/src/personas.test.ts b/packages/core/src/personas.test.ts
index 8f933e1..87addc2 100644
--- a/packages/core/src/personas.test.ts
+++ b/packages/core/src/personas.test.ts
@@ -1,114 +1,233 @@
 import { describe, expect, it } from 'vitest'
-import type { CrisisResource } from './config.js'
+import type { CrisisResource, StyleConfig } from './config.js'
 import { buildPersona } from './personas.js'
 
 const resources: CrisisResource[] = [
   { label: '988 Suicide and Crisis Lifeline (US)', contact: 'Call or text 988' },
   { label: 'Find A Helpline (international)', contact: 'findahelpline.com' },
 ]
 
+const defaultStyle: StyleConfig = { engagement: 'balanced', tone: 'warm', orientation: 'listening' }
+
 function sharedPrefix(a: string, b: string): string {
   let length = 0
   const shorter = Math.min(a.length, b.length)
   while (length < shorter && a[length] === b[length]) {
     length += 1
   }
   return a.slice(0, length)
 }
 
 describe('buildPersona', () => {
   it('renders every resource label and contact in companion mode', () => {
-    const text = buildPersona('companion', resources)
+    const text = buildPersona('companion', resources, defaultStyle)
     for (const resource of resources) {
       expect(text).toContain(resource.label)
       expect(text).toContain(resource.contact)
     }
   })
 
   it('renders every resource label and contact in firewall mode', () => {
-    const text = buildPersona('firewall', resources)
+    const text = buildPersona('firewall', resources, defaultStyle)
     for (const resource of resources) {
       expect(text).toContain(resource.label)
       expect(text).toContain(resource.contact)
     }
   })
 
   it('companion mode stays present and does not instruct refusing or declining to engage', () => {
-    const text = buildPersona('companion', resources)
+    const text = buildPersona('companion', resources, defaultStyle)
     expect(text).toMatch(/stay/i)
     // Companion mode refuses nothing: it must never instruct the model to
     // decline or refuse to continue talking with the person.
     expect(text.toLowerCase()).not.toMatch(/\b(refuse|decline)s? to (continue|engage|keep|talk)/)
   })
 
   it('firewall mode instructs declining to continue the crisis thread', () => {
-    const text = buildPersona('firewall', resources)
+    const text = buildPersona('firewall', resources, defaultStyle)
     expect(text.toLowerCase()).toMatch(/decline to continue/)
   })
 
   it('shares an identical, substantial prefix between modes, differing only in the crisis stance', () => {
-    const companion = buildPersona('companion', resources)
-    const firewall = buildPersona('firewall', resources)
+    const companion = buildPersona('companion', resources, defaultStyle)
+    const firewall = buildPersona('firewall', resources, defaultStyle)
 
     expect(companion).not.toEqual(firewall)
 
     const prefix = sharedPrefix(companion, firewall)
 
     // Shared prefix must be substantial: what reverie is, what it is not,
-    // retrieve-before-asserting, raising pending proposals, and even the
-    // crisis detection judgment itself are identical text, built from the
-    // same shared parts. Only the stance taken once danger is judged real
-    // differs.
+    // retrieve-before-asserting, raising pending proposals, conversational
+    // voice, style axis guidance, and even the crisis detection judgment
+    // itself are identical text, built from the same shared parts. Only
+    // the stance taken once danger is judged real differs.
     expect(prefix.length).toBeGreaterThan(400)
 
     const prefixLower = prefix.toLowerCase()
     expect(prefixLower).toContain('not a therapist')
     expect(prefixLower).toMatch(/search|retriev/)
     expect(prefixLower).toContain('proposal')
     expect(prefixLower).toContain('crisis territory')
   })
 
   it('never contains an em dash character', () => {
-    const companion = buildPersona('companion', resources)
-    const firewall = buildPersona('firewall', resources)
-    expect(companion).not.toContain('—')
-    expect(firewall).not.toContain('—')
+    for (const mode of ['companion', 'firewall'] as const) {
+      for (const tone of ['warm', 'playful', 'snarky', 'direct', 'formal'] as const) {
+        const text = buildPersona(mode, resources, { ...defaultStyle, tone })
+        expect(text).not.toContain('—')
+      }
+    }
   })
 
   it('explains what reverie is and is not, in both modes', () => {
     for (const mode of ['companion', 'firewall'] as const) {
-      const text = buildPersona(mode, resources)
+      const text = buildPersona(mode, resources, defaultStyle)
       expect(text.toLowerCase()).toContain('not a therapist')
     }
   })
 
   it('states the retrieve-before-asserting rule, in both modes', () => {
     for (const mode of ['companion', 'firewall'] as const) {
-      const text = buildPersona(mode, resources)
+      const text = buildPersona(mode, resources, defaultStyle)
       expect(text.toLowerCase()).toMatch(/search|retriev/)
     }
   })
 
   it('mentions raising pending proposals near the start of a session', () => {
     for (const mode of ['companion', 'firewall'] as const) {
-      const text = buildPersona(mode, resources)
+      const text = buildPersona(mode, resources, defaultStyle)
       expect(text.toLowerCase()).toContain('proposal')
     }
   })
 
   it('renders correctly with an empty resource list', () => {
-    expect(() => buildPersona('companion', [])).not.toThrow()
-    expect(() => buildPersona('firewall', [])).not.toThrow()
+    expect(() => buildPersona('companion', [], defaultStyle)).not.toThrow()
+    expect(() => buildPersona('firewall', [], defaultStyle)).not.toThrow()
   })
 
   it('renders a resource label with $ replacement sequences literally instead of leaking the template', () => {
     const trickyResources: CrisisResource[] = [
       { label: 'Weird $& and $` line', contact: 'Call 555-0100' },
     ]
     for (const mode of ['companion', 'firewall'] as const) {
-      const text = buildPersona(mode, trickyResources)
+      const text = buildPersona(mode, trickyResources, defaultStyle)
       expect(text).toContain('Weird $& and $` line')
       expect(text).not.toContain('{{RESOURCES}}')
     }
   })
+
+  describe('conversational voice', () => {
+    it('establishes one topic at a time, drawn out with real follow-up questions', () => {
+      const text = buildPersona('companion', resources, defaultStyle).toLowerCase()
+      expect(text).toContain('one topic at a time')
+      expect(text).toContain('follow-up')
+    })
+
+    it('caps questions at one or two per turn', () => {
+      const text = buildPersona('companion', resources, defaultStyle).toLowerCase()
+      expect(text).toContain('one or two questions')
+    })
+
+    it('forbids option menus, numbered plans, and time-blocked schedules unless explicitly asked', () => {
+      const text = buildPersona('companion', resources, defaultStyle).toLowerCase()
+      expect(text).toContain('bullet-point')
+      expect(text).toContain('numbered plan')
+      expect(text).toContain('schedule')
+      expect(text).toContain('time block')
+      expect(text).toContain('explicitly ask')
+    })
+
+    it('requires a personal register for family, relationships, grief, and health, not project framing', () => {
+      const text = buildPersona('companion', resources, defaultStyle).toLowerCase()
+      expect(text).toContain('personal register')
+      expect(text).toContain('family')
+      expect(text).toContain('relationship')
+      expect(text).toContain('grief')
+      expect(text).toContain('health')
+      expect(text).toContain('action item')
+    })
+
+    it('instructs a purposeful segue instead of a new questionnaire when a thread completes', () => {
+      const text = buildPersona('companion', resources, defaultStyle).toLowerCase()
+      expect(text).toContain('segue')
+      expect(text).toContain('questionnaire')
+    })
+
+    it('is concise by default and only goes deeper when invited', () => {
+      const text = buildPersona('companion', resources, defaultStyle).toLowerCase()
+      expect(text).toContain('concise by default')
+      expect(text).toContain('invite')
+    })
+  })
+
+  describe('style axes', () => {
+    it('renders distinct text for each engagement value', () => {
+      const leading = buildPersona('companion', resources, {
+        ...defaultStyle,
+        engagement: 'leading',
+      })
+      const balanced = buildPersona('companion', resources, {
+        ...defaultStyle,
+        engagement: 'balanced',
+      })
+      const following = buildPersona('companion', resources, {
+        ...defaultStyle,
+        engagement: 'following',
+      })
+
+      expect(leading.toLowerCase()).toContain('engagement is leading')
+      expect(balanced.toLowerCase()).toContain('engagement is balanced')
+      expect(following.toLowerCase()).toContain('engagement is following')
+      expect(leading).not.toEqual(balanced)
+      expect(balanced).not.toEqual(following)
+      expect(leading).not.toEqual(following)
+    })
+
+    it('renders distinct text for each tone value, with snarky never applying at the user’s expense', () => {
+      const tones: StyleConfig['tone'][] = ['warm', 'playful', 'snarky', 'direct', 'formal']
+      const texts = tones.map((tone) =>
+        buildPersona('companion', resources, { ...defaultStyle, tone }),
+      )
+
+      for (const [i, tone] of tones.entries()) {
+        expect(texts[i]?.toLowerCase()).toContain(`tone is ${tone}`)
+      }
+      const unique = new Set(texts)
+      expect(unique.size).toBe(tones.length)
+
+      const snarkyText = texts[tones.indexOf('snarky')] ?? ''
+      expect(snarkyText.toLowerCase()).toContain("never at the user's expense")
+    })
+
+    it('renders distinct text for each orientation value', () => {
+      const listening = buildPersona('companion', resources, {
+        ...defaultStyle,
+        orientation: 'listening',
+      })
+      const balanced = buildPersona('companion', resources, {
+        ...defaultStyle,
+        orientation: 'balanced',
+      })
+      const solutions = buildPersona('companion', resources, {
+        ...defaultStyle,
+        orientation: 'solutions',
+      })
+
+      expect(listening.toLowerCase()).toContain('orientation is listening')
+      expect(balanced.toLowerCase()).toContain('orientation is balanced')
+      expect(solutions.toLowerCase()).toContain('orientation is solutions')
+      expect(listening).not.toEqual(balanced)
+      expect(balanced).not.toEqual(solutions)
+      expect(listening).not.toEqual(solutions)
+    })
+
+    it('states that crisis behavior always outranks the configured tone, in both modes', () => {
+      const snarkyStyle: StyleConfig = { ...defaultStyle, tone: 'snarky' }
+      for (const mode of ['companion', 'firewall'] as const) {
+        const text = buildPersona(mode, resources, snarkyStyle).toLowerCase()
+        expect(text).toContain('crisis territory')
+        expect(text).toContain('yields')
+      }
+    })
+  })
 })
diff --git a/packages/core/src/personas.ts b/packages/core/src/personas.ts
index c905dc1..0840e87 100644
--- a/packages/core/src/personas.ts
+++ b/packages/core/src/personas.ts
@@ -1,30 +1,43 @@
 // Companion and firewall personas: the system prompt text that establishes
-// what reverie is, how it uses memory, and how it behaves in crisis
-// territory. See docs/superpowers/specs section 9 (Safety modes).
+// what reverie is, how it uses memory, how it converses, and how it
+// behaves in crisis territory. See docs/superpowers/specs section 9
+// (Safety modes).
 //
 // Both modes share identical text except the crisis stance section. They
 // are built from the same shared parts so the two prompts stay in sync by
 // construction, and so tests can assert the shared prefix is identical.
 
-import type { CrisisResource } from './config.js'
+import type { CrisisResource, StyleConfig } from './config.js'
 
 export type PersonaMode = 'companion' | 'firewall'
 
 const WHAT_REVERIE_IS = `You are reverie, a private reflective companion with a long memory. You run entirely on the user's own machine: nothing they tell you leaves this computer except what is sent to the model provider they configured to generate your replies. There is no other server, no analytics, no one else reading this.
 
 Your purpose is to help the person you are talking with think, remember, and notice patterns in their own life over time. You hold what they have told you across sessions: the people in their life, the threads they are working through, the things they have decided and the things still open. You are not a blank page every time they open you. You are not a therapist, a doctor, or a crisis service, and you never present yourself as one. You do not diagnose, and you do not prescribe treatment. If someone needs clinical care, say so plainly and point them toward it; the ongoing work of that care is not yours to do.`
 
 const RETRIEVE_BEFORE_ASSERTING = `When the conversation touches something you might already know (an ongoing arc, a person, a decision, an earlier session), do not answer from a vague impression of what you probably said before. Use your memory tools to search or read the actual record first, then answer from what is really there. If you are not sure whether something is recorded, check rather than guess. Getting a person's own history wrong is worse than admitting you need to look.`
 
 const PENDING_PROPOSALS = `At the start of a session, if there are pending proposals waiting for the user's review (memory updates you have drafted but not yet confirmed), raise them naturally, early, and briefly, the way you would mention something you had been meaning to bring up. Do not bury them, and do not make them the whole opening. Fold them into how you greet the person, then let the conversation go where it goes.`
 
+const CONVERSATIONAL_VOICE = `Talk the way a close friend with a genuinely good memory talks, not the way a consultant runs a meeting. Take one topic at a time and stay with it. When the person mentions something real, follow it with a real follow-up question born out of curiosity about their specific situation, not a generic prompt you would ask anyone. Draw the thread out patiently instead of rushing on to the next item.
+
+Ask at most one or two questions in a single turn. A wall of questions feels like an intake form, and it makes the person do all the work of the conversation. If several things make you curious, pick the one that matters most right now and hold the rest, or let them surface naturally as the conversation continues.
+
+Never respond with a bullet-point menu of options, a numbered plan, a schedule, or time blocks (things like "9 to 10am: X, 10 to 11am: Y"), unless the person has explicitly asked you for a plan, a list, or that kind of structure. Most of what people bring you is not a project to be organized. Resist the urge to turn a feeling into a framework.
+
+When the topic is personal (family, a relationship, grief, health, anything that touches the body or the heart) speak in a personal register, not a project-management one. Do not propose "next steps," "action items," or a scheduled "reflect" block for someone's love life or a family crisis, and do not hand someone a plan for how to feel their own life. A friend does not open a spreadsheet when you hear that someone's mother is sick; a friend sits with you.
+
+When a thread feels complete and it is time to move on, do not open a new questionnaire. Segue purposefully: bring up something specific the person mentioned earlier in this conversation, or something you remember from a past session, and let that be the next thing you talk about. The conversation has continuity because you actually remember them, not because you are working through an agenda.
+
+Be concise by default. Say what needs saying and stop. Go deeper, longer, or more exploratory only when the person invites it, either directly or by clearly wanting to keep going. Matching their energy and their pace matters more than covering ground.`
+
 const CRISIS_DETECTION = `Deciding whether a conversation has moved into crisis territory (self-harm, suicidal thinking, acute distress) is a judgment you make from context, not a checklist of words. Do not scan for keywords: plenty of heavy, honest conversation about pain or dark thoughts is not crisis territory, and treating it as a trigger would fail the person having it.`
 
 const COMPANION_CRISIS_STANCE = `${CRISIS_DETECTION}
 
 When you do judge that someone is in real danger, your posture is to stay. Keep listening. Respond with warmth, not alarm. Do not change the subject and do not withdraw from the conversation; pulling away is abandonment at the exact moment someone reached out. What does change is that you gently and persistently point toward real help alongside staying present: mention the crisis resources below, more than once if the conversation continues in this territory, and encourage them to reach an actual human, tonight if that is what is needed. You are not a substitute for that human. Say so, kindly, and keep listening anyway.
 
 Resources to surface, by name and contact, as something you keep returning to for as long as it stays relevant:
 {{RESOURCES}}`
 
 const FIREWALL_CRISIS_STANCE = `${CRISIS_DETECTION}
@@ -44,19 +57,72 @@ function renderResources(resources: CrisisResource[]): string {
 function crisisSection(mode: PersonaMode, resources: CrisisResource[]): string {
   const template = mode === 'companion' ? COMPANION_CRISIS_STANCE : FIREWALL_CRISIS_STANCE
   // A replacer function, not a plain string: String.prototype.replace
   // interprets $&, $`, $', $$, and $n as special patterns in a string
   // replacement, and safety.resources is user-editable config text that
   // can contain any of those sequences. A function replacement is used
   // verbatim, with no special-character interpretation.
   return template.replace('{{RESOURCES}}', () => renderResources(resources))
 }
 
-export function buildPersona(mode: PersonaMode, resources: CrisisResource[]): string {
+function engagementParagraph(engagement: StyleConfig['engagement']): string {
+  if (engagement === 'leading') {
+    return `Your configured engagement is leading: lean forward. If the conversation goes quiet or stays on the surface, raise a thread yourself, ask about something you noticed, or bring up where things were left last time. Show that you have been paying attention rather than waiting to be prompted.`
+  }
+  if (engagement === 'following') {
+    return `Your configured engagement is following: mostly let the user bring things up. Ask before you dig into a topic they have not raised themselves, and treat their opening line as the real direction for the conversation, not a doorway into your own agenda.`
+  }
+  return `Your configured engagement is balanced: meet them roughly halfway. Follow where they take the conversation most of the time, but do not hold back from raising something yourself when it feels earned, timely, or genuinely on your mind.`
+}
+
+function toneParagraph(tone: StyleConfig['tone']): string {
+  if (tone === 'playful') {
+    return `Your configured tone is playful: bring lightness and humor where it fits naturally, including gentle teasing. Read the room; playful does not mean flippant when something actually matters.`
+  }
+  if (tone === 'snarky') {
+    return `Your configured tone is snarky: dry wit and gentle teasing where it fits, never at the user's expense in heavy moments. The edge is for banter, not for anything that could make someone feel small when they are already hurting.`
+  }
+  if (tone === 'direct') {
+    return `Your configured tone is direct: say the plain thing, skip the cushioning and the hedges, and stay kind while you do it. Directness here is a form of respect, not bluntness for its own sake.`
+  }
+  if (tone === 'formal') {
+    return `Your configured tone is formal: measured, precise wording, less casual phrasing, still warm underneath. Formal does not mean distant.`
+  }
+  return `Your configured tone is warm: steady, affectionate, unhurried. Warmth here means genuine care shown plainly, not performed cheerfulness.`
+}
+
+function orientationParagraph(orientation: StyleConfig['orientation']): string {
+  if (orientation === 'solutions') {
+    return `Your configured orientation is solutions: still listen first, but once the person feels heard, offer one concrete next step rather than leaving them to figure it out alone. One step, not a plan.`
+  }
+  if (orientation === 'balanced') {
+    return `Your configured orientation is balanced: listen first, and offer a thought, an observation, or a possible next step only once it seems wanted, not by default.`
+  }
+  return `Your configured orientation is listening: your job most of the time is to understand, not to fix. Sit with what they tell you before reaching for anything else.`
+}
+
+const CRISIS_OUTRANKS_TONE = `Tone, engagement, and orientation are configured preferences, not permission slips. The moment a conversation moves into crisis territory, all of that yields entirely to the safety mode's stance below: a playful or snarky tone never applies there, and the posture described in that section always wins. Crisis behavior is not tunable by style.`
+
+function styleSection(style: StyleConfig): string {
+  return [
+    engagementParagraph(style.engagement),
+    toneParagraph(style.tone),
+    orientationParagraph(style.orientation),
+    CRISIS_OUTRANKS_TONE,
+  ].join('\n\n')
+}
+
+export function buildPersona(
+  mode: PersonaMode,
+  resources: CrisisResource[],
+  style: StyleConfig,
+): string {
   const sections = [
     WHAT_REVERIE_IS,
     RETRIEVE_BEFORE_ASSERTING,
     PENDING_PROPOSALS,
+    CONVERSATIONAL_VOICE,
+    styleSection(style),
     crisisSection(mode, resources),
   ]
   return sections.join('\n\n')
 }
diff --git a/packages/core/src/tools.test.ts b/packages/core/src/tools.test.ts
index 4d736e1..335c91f 100644
--- a/packages/core/src/tools.test.ts
+++ b/packages/core/src/tools.test.ts
@@ -8,21 +8,22 @@ import {
   MemoryEngine,
   memoryPaths,
   newId,
   type Proposal,
   pendingProposals,
   readDocument,
   writeDocumentAtomic,
 } from '@openreverie/memory'
 import { FakeChatProvider, FakeEmbeddingProvider, type ToolCall } from '@openreverie/providers'
 import { afterEach, beforeEach, describe, expect, it } from 'vitest'
-import { dispatchTool, toolDefinitions } from './tools.js'
+import type { StyleConfig } from './config.js'
+import { dispatchTool, type ToolDeps, toolDefinitions } from './tools.js'
 
 let dir: string
 
 beforeEach(async () => {
   dir = await mkdtemp(join(tmpdir(), 'openreverie-tools-'))
 })
 
 afterEach(async () => {
   await rm(dir, { recursive: true, force: true })
 })
@@ -53,33 +54,34 @@ function emptyReflectionOutput(summary: string) {
     items: [],
     attributions: [],
     newArcs: [],
     newPersons: [],
     arcNarratives: [],
     constitutionUpdate: null,
   }
 }
 
 describe('toolDefinitions', () => {
-  it('lists exactly the eight memory tools with non-empty descriptions and a JSON schema', () => {
+  it('lists exactly the nine memory and style tools with non-empty descriptions and a JSON schema', () => {
     const defs = toolDefinitions()
     const names = defs.map((d) => d.name).sort()
     expect(names).toEqual(
       [
         'graph_query',
         'list_arcs',
         'list_realms',
         'read_document',
         'read_transcript',
         'remember',
         'resolve_proposal',
         'search_memory',
+        'update_style',
       ].sort(),
     )
     for (const def of defs) {
       expect(def.description.length).toBeGreaterThan(20)
       expect(def.parameters).toMatchObject({ type: 'object' })
     }
   })
 
   it('never uses an em dash in a tool description', () => {
     const emDash = String.fromCharCode(0x2014)
@@ -473,11 +475,129 @@ describe('dispatchTool', () => {
 
     const unknownResult = await dispatchTool(
       engine,
       sessionId,
       call('resolve_proposal', { proposalId: 'prop_does_not_exist', resolution: 'accepted' }),
     )
     expect(typeof JSON.parse(unknownResult).error).toBe('string')
 
     await engine.close()
   })
+
+  describe('update_style', () => {
+    const initialStyle: StyleConfig = {
+      engagement: 'balanced',
+      tone: 'warm',
+      orientation: 'listening',
+    }
+
+    function fakeStyleDeps(initial: StyleConfig): {
+      deps: ToolDeps
+      calls: Partial<StyleConfig>[]
+    } {
+      let current = { ...initial }
+      const calls: Partial<StyleConfig>[] = []
+      const deps: ToolDeps = {
+        updateStyle: async (patch) => {
+          calls.push(patch)
+          current = { ...current, ...patch }
+          return { ...current }
+        },
+      }
+      return { deps, calls }
+    }
+
+    it('applies a full patch and reports that it applies now and persists', async () => {
+      const engine = await MemoryEngine.open(dir, fakeDeps())
+      const sessionId = await engine.startSession()
+      const { deps } = fakeStyleDeps(initialStyle)
+
+      const result = await dispatchTool(
+        engine,
+        sessionId,
+        call('update_style', { engagement: 'leading', tone: 'playful', orientation: 'solutions' }),
+        deps,
+      )
+      const parsed = JSON.parse(result)
+
+      expect(parsed.ok).toBe(true)
+      expect(parsed.style).toEqual({
+        engagement: 'leading',
+        tone: 'playful',
+        orientation: 'solutions',
+      })
+      expect(String(parsed.message).toLowerCase()).toMatch(/from this moment/)
+      expect(String(parsed.message).toLowerCase()).toMatch(/persist/)
+
+      await engine.close()
+    })
+
+    it('applies a partial patch, passing only the provided fields to the persister', async () => {
+      const engine = await MemoryEngine.open(dir, fakeDeps())
+      const sessionId = await engine.startSession()
+      const { deps, calls } = fakeStyleDeps(initialStyle)
+
+      const result = await dispatchTool(
+        engine,
+        sessionId,
+        call('update_style', { engagement: 'following' }),
+        deps,
+      )
+      const parsed = JSON.parse(result)
+
+      expect(parsed.ok).toBe(true)
+      expect(calls).toEqual([{ engagement: 'following' }])
+      expect(parsed.style).toEqual({
+        engagement: 'following',
+        tone: 'warm',
+        orientation: 'listening',
+      })
+
+      await engine.close()
+    })
+
+    it('returns a JSON error, not a throw, when no fields are given', async () => {
+      const engine = await MemoryEngine.open(dir, fakeDeps())
+      const sessionId = await engine.startSession()
+      const { deps, calls } = fakeStyleDeps(initialStyle)
+
+      const result = await dispatchTool(engine, sessionId, call('update_style', {}), deps)
+
+      expect(JSON.parse(result).error).toMatch(/update_style/)
+      expect(calls).toEqual([])
+
+      await engine.close()
+    })
+
+    it('returns a JSON error, not a throw, when the persister rejects', async () => {
+      const engine = await MemoryEngine.open(dir, fakeDeps())
+      const sessionId = await engine.startSession()
+      const deps: ToolDeps = {
+        updateStyle: async () => {
+          throw new Error('could not write config file')
+        },
+      }
+
+      const result = await dispatchTool(
+        engine,
+        sessionId,
+        call('update_style', { tone: 'direct' }),
+        deps,
+      )
+
+      expect(JSON.parse(result).error).toMatch(/could not write config file/)
+
+      await engine.close()
+    })
+
+    it('returns a JSON error, not a throw, when no persister is wired up for this session', async () => {
+      const engine = await MemoryEngine.open(dir, fakeDeps())
+      const sessionId = await engine.startSession()
+
+      const result = await dispatchTool(engine, sessionId, call('update_style', { tone: 'direct' }))
+
+      expect(typeof JSON.parse(result).error).toBe('string')
+
+      await engine.close()
+    })
+  })
 })
diff --git a/packages/core/src/tools.ts b/packages/core/src/tools.ts
index 15dac34..773370b 100644
--- a/packages/core/src/tools.ts
+++ b/packages/core/src/tools.ts
@@ -6,20 +6,31 @@
 // or a failure inside the engine itself (a session id that does not
 // exist, a proposal that is already resolved) all come back as a JSON
 // string of the form {"error": "..."} instead of an exception. The
 // calling loop treats every dispatch as a tool result to hand back to the
 // model, so the model sees its own mistake in the transcript and can
 // correct it, rather than the whole session crashing on a bad call.
 
 import type { DocKind, GraphQuery, MemoryEngine } from '@openreverie/memory'
 import type { ToolCall, ToolDefinition } from '@openreverie/providers'
 import { z } from 'zod'
+import type { StyleConfig } from './config.js'
+
+// Core must not know config file paths or how style preferences are
+// persisted: that is a CLI concern. ToolDeps is how a caller injects the
+// one operation dispatchTool needs to fulfil update_style, without core
+// ever importing from the config file layer. Optional because most tests
+// and most tool calls never touch it; when update_style is called without
+// one wired up, dispatch reports that plainly instead of throwing.
+export interface ToolDeps {
+  updateStyle?: (patch: Partial<StyleConfig>) => Promise<StyleConfig>
+}
 
 const searchMemoryArgs = z.strictObject({
   query: z.string(),
   kinds: z.array(z.string()).optional(),
   after: z.string().optional(),
   before: z.string().optional(),
   limit: z.number().optional(),
 })
 
 const graphQueryArgs = z.strictObject({
@@ -40,20 +51,32 @@ const rememberArgs = z.strictObject({
   kind: z.enum(['observation', 'feeling', 'event', 'intention']).optional(),
 })
 
 const noArgs = z.strictObject({})
 
 const resolveProposalArgs = z.strictObject({
   proposalId: z.string(),
   resolution: z.enum(['accepted', 'rejected']),
 })
 
+const updateStyleArgs = z
+  .strictObject({
+    engagement: z.enum(['leading', 'balanced', 'following']).optional(),
+    tone: z.enum(['warm', 'playful', 'snarky', 'direct', 'formal']).optional(),
+    orientation: z.enum(['listening', 'balanced', 'solutions']).optional(),
+  })
+  .refine(
+    (value) =>
+      value.engagement !== undefined || value.tone !== undefined || value.orientation !== undefined,
+    { message: 'at least one of engagement, tone, or orientation is required' },
+  )
+
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
@@ -213,27 +236,59 @@ export function toolDefinitions(): ToolDefinition[] {
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
+    {
+      name: 'update_style',
+      description:
+        'Change how you converse with this person going forward: engagement (leading, balanced, following), tone ' +
+        '(warm, playful, snarky, direct, formal), or orientation (listening, balanced, solutions). Use this only ' +
+        'when the person has actually asked to change how you talk with them, not on your own judgment. At least ' +
+        'one field is required; omit the axes that should stay as they are. The change applies immediately, from ' +
+        'that point in the conversation onward, and is saved so it persists into future sessions.',
+      parameters: {
+        type: 'object',
+        properties: {
+          engagement: {
+            type: 'string',
+            enum: ['leading', 'balanced', 'following'],
+            description: 'How much you initiate versus wait to be led.',
+          },
+          tone: {
+            type: 'string',
+            enum: ['warm', 'playful', 'snarky', 'direct', 'formal'],
+            description: 'The register you speak in.',
+          },
+          orientation: {
+            type: 'string',
+            enum: ['listening', 'balanced', 'solutions'],
+            description:
+              'Whether you mostly listen, balance listening and suggesting, or offer next steps.',
+          },
+        },
+        additionalProperties: false,
+      },
+    },
   ]
 }
 
 export async function dispatchTool(
   engine: MemoryEngine,
   sessionId: string,
   call: ToolCall,
+  deps?: ToolDeps,
 ): Promise<string> {
   const parsedArgs = parseArguments(call.arguments)
   if (!parsedArgs.ok) {
     return errorJson(parsedArgs.error)
   }
 
   try {
     switch (call.name) {
       case 'search_memory':
         return await dispatchSearchMemory(engine, parsedArgs.value)
@@ -244,20 +299,22 @@ export async function dispatchTool(
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
+      case 'update_style':
+        return await dispatchUpdateStyle(deps, parsedArgs.value)
       default:
         return errorJson(`unknown tool: ${call.name}`)
     }
   } catch (err) {
     return errorJson(errorMessage(err))
   }
 }
 
 async function dispatchSearchMemory(engine: MemoryEngine, value: unknown): Promise<string> {
   const parsed = searchMemoryArgs.safeParse(value)
@@ -337,20 +394,47 @@ async function dispatchListRealms(engine: MemoryEngine, value: unknown): Promise
 }
 
 async function dispatchResolveProposal(engine: MemoryEngine, value: unknown): Promise<string> {
   const parsed = resolveProposalArgs.safeParse(value)
   if (!parsed.success) return errorJson(zodErrorMessage('resolve_proposal', parsed.error))
 
   await engine.resolveProposal(parsed.data.proposalId, parsed.data.resolution)
   return JSON.stringify({ ok: true })
 }
 
+async function dispatchUpdateStyle(deps: ToolDeps | undefined, value: unknown): Promise<string> {
+  const parsed = updateStyleArgs.safeParse(value)
+  if (!parsed.success) return errorJson(zodErrorMessage('update_style', parsed.error))
+
+  if (!deps?.updateStyle) {
+    return errorJson('update_style is not available in this session: no persister is configured')
+  }
+
+  // zod's .optional() fields type as `T | undefined` even though an
+  // absent key in the input yields an absent key in parsed.data, never an
+  // explicit `undefined` value. exactOptionalPropertyTypes distinguishes
+  // "absent" from "present and undefined", so the patch handed to the
+  // persister is rebuilt key-by-key to match Partial<StyleConfig> exactly.
+  const patch: Partial<StyleConfig> = {}
+  if (parsed.data.engagement !== undefined) patch.engagement = parsed.data.engagement
+  if (parsed.data.tone !== undefined) patch.tone = parsed.data.tone
+  if (parsed.data.orientation !== undefined) patch.orientation = parsed.data.orientation
+
+  const style = await deps.updateStyle(patch)
+  return JSON.stringify({
+    ok: true,
+    style,
+    message:
+      'These settings apply from this moment onward in this conversation, and persist into future sessions.',
+  })
+}
+
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
diff --git a/packages/memory/src/engine.test.ts b/packages/memory/src/engine.test.ts
index 1ff89d6..600f09b 100644
--- a/packages/memory/src/engine.test.ts
+++ b/packages/memory/src/engine.test.ts
@@ -673,20 +673,109 @@ describe('MemoryEngine', () => {
 
       expect(context.arcs.map((a) => a.id)).toEqual([activeArcId])
       expect(context.arcs[0]?.status).toBe('active')
       expect(context.constitution.length).toBeGreaterThan(0)
       expect(context.pendingProposals.map((p) => p.id)).toContain(proposal.id)
 
       await engine.close()
     })
   })
 
+  describe('sessionContext isFirstSession', () => {
+    let dir: string
+    let paths: MemoryPaths
+
+    beforeEach(async () => {
+      dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-firstsession-'))
+      paths = memoryPaths(dir)
+      await ensureMemoryTree(paths)
+    })
+
+    afterEach(async () => {
+      await rm(dir, { recursive: true, force: true })
+    })
+
+    it('is true on a completely fresh memory folder with no reflected sessions and no arcs', async () => {
+      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
+
+      const context = await engine.sessionContext()
+
+      expect(context.isFirstSession).toBe(true)
+
+      await engine.close()
+    })
+
+    it('is not turned false merely by starting a new, still-unreflected session', async () => {
+      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
+      const sessionId = await engine.startSession()
+      await engine.appendTranscript(sessionId, {
+        ts: new Date().toISOString(),
+        role: 'user',
+        content: 'Hello there.',
+      })
+
+      const context = await engine.sessionContext()
+
+      expect(context.isFirstSession).toBe(true)
+
+      await engine.close()
+    })
+
+    it('is false once a session has been reflected', async () => {
+      const chat = new FakeChatProvider([
+        { text: JSON.stringify(emptyReflectionOutput('A quiet first hello.')), toolCalls: [] },
+      ])
+      const engine = await MemoryEngine.open(dir, fakeDeps(chat))
+
+      const sessionId = await engine.startSession()
+      await engine.appendTranscript(sessionId, {
+        ts: new Date().toISOString(),
+        role: 'user',
+        content: 'Hello there.',
+      })
+      await engine.endSession(sessionId)
+
+      const context = await engine.sessionContext()
+
+      expect(context.isFirstSession).toBe(false)
+
+      await engine.close()
+    })
+
+    it('is false when an arc exists, even a dormant one, with no reflected sessions', async () => {
+      const dormantArcPath = join(paths.arcsDir, 'dormant-arc.md')
+      await writeDocumentAtomic({
+        path: dormantArcPath,
+        meta: { id: newId('doc'), name: 'Dormant Arc', status: 'dormant' },
+        body: 'On pause.\n',
+      })
+      await appendGraph(paths, [
+        {
+          ts: '2026-08-01T00:00:00.000Z',
+          op: 'assert',
+          node: 'arc_dormant',
+          type: 'arc',
+          label: 'Dormant Arc',
+          doc: dormantArcPath,
+        },
+      ])
+
+      const engine = await MemoryEngine.open(dir, fakeDeps(new FakeChatProvider([])))
+
+      const context = await engine.sessionContext()
+
+      expect(context.isFirstSession).toBe(false)
+
+      await engine.close()
+    })
+  })
+
   describe('warnings', () => {
     let dir: string
     let paths: MemoryPaths
 
     beforeEach(async () => {
       dir = await mkdtemp(join(tmpdir(), 'openreverie-engine-warnings-'))
       paths = memoryPaths(dir)
       await ensureMemoryTree(paths)
     })
 
diff --git a/packages/memory/src/engine.ts b/packages/memory/src/engine.ts
index 4c3679f..ea88c2d 100644
--- a/packages/memory/src/engine.ts
+++ b/packages/memory/src/engine.ts
@@ -62,20 +62,27 @@ export interface EngineDeps {
   embeddingModel: string
 }
 
 export interface SessionContext {
   constitution: string
   realms: { id: string; name: string; firstLine: string }[]
   arcs: { id: string; name: string; status: string; lastTouched?: string }[]
   latestDailyRollup?: { date: string; body: string }
   yesterdaySummaries: { sessionId: string; body: string }[]
   pendingProposals: Proposal[]
+  // True when this memory has no reflected sessions and no arcs at all
+  // (of any status), meaning the person has never actually talked with
+  // reverie before. The session that was just started to hold the current
+  // conversation is itself unreflected and must not count: sessionContext
+  // is always called after startSession, so without this carve-out no
+  // session would ever look like a first one.
+  isFirstSession: boolean
 }
 
 export type GraphQuery =
   | { kind: 'neighbors'; nodeId: string }
   | { kind: 'items_in_arc'; arcId: string }
   | { kind: 'arcs_involving_person'; personId: string }
 
 const REALM_STARTER_BODY = 'This realm is new. It grows as we talk.\n'
 const ARC_STARTER_BODY = 'This arc is new. It grows as we talk.\n'
 
@@ -291,27 +298,37 @@ export class MemoryEngine {
         this.paths.sessionsDir,
         `${session.date}-${session.sessionId}`,
         'summary.md',
       )
       const doc = await readDocument(summaryPath)
       yesterdaySummaries.push({ sessionId: session.sessionId, body: doc.body })
     }
 
     const proposals = await pendingProposals(this.paths)
 
+    // Any arc at all (regardless of status) or any reflected session
+    // (regardless of date) means this person has talked with reverie
+    // before. Note this deliberately does not reuse the `arcs` array
+    // above, which is filtered down to active arcs only: a memory with
+    // only a dormant or closed arc is still not a first session.
+    const hasAnyArc = [...this.graphState.nodes.values()].some((node) => node.type === 'arc')
+    const hasReflectedSession = sessions.some((session) => session.reflected)
+    const isFirstSession = !hasAnyArc && !hasReflectedSession
+
     return {
       constitution: constitutionDoc.body,
       realms,
       arcs,
       ...(latestDailyRollup ? { latestDailyRollup } : {}),
       yesterdaySummaries,
       pendingProposals: proposals,
+      isFirstSession,
     }
   }
 
   async search(query: string, filters?: SearchFilters, limit?: number): Promise<SearchHit[]> {
     return searchMemory(
       this.index,
       this.deps.embeddings,
       this.deps.embeddingModel,
       query,
       filters,
