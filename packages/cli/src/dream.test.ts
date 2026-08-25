import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfigPath, type ReverieConfig } from '@openreverie/core'
import {
  appendDreamLog,
  type Document,
  type DreamDryRun,
  type DreamRunResult,
  type DreamSummary,
  type EngineDeps,
  MemoryEngine,
  memoryPaths,
} from '@openreverie/memory'
import { FakeChatProvider, FakeEmbeddingProvider } from '@openreverie/providers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type DreamEngine, runDreamCommand } from './dream.js'

function testConfig(memoryDir = '/fake/memory'): ReverieConfig {
  return {
    memoryDir,
    provider: { name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    models: { chat: 'fake-chat', reflection: 'fake-reflect', embeddings: 'fake-embed' },
    safety: { mode: 'companion', resources: [] },
    dreaming: {
      enabled: true,
      cadence: 'daily',
      triggers: { afterSession: true, onStart: true, serverTimer: true },
      maxToolCalls: 10,
    },
  }
}

function outputCollector(): { write: (line: string) => void; lines: () => string[] } {
  const lines: string[] = []
  return { write: (line: string) => lines.push(line), lines: () => lines }
}

function stubEngine(overrides: Partial<DreamEngine> = {}): DreamEngine {
  return {
    dreamNow: vi.fn(
      async () => ({ outcome: 'aborted', reason: 'dreaming is not configured' }) as DreamRunResult,
    ),
    listDreams: vi.fn(async () => [] as DreamSummary[]),
    readDream: vi.fn(async () => null),
    ...overrides,
  }
}

function doc(body: string, meta: Record<string, unknown> = {}): Document {
  return { path: '/fake/doc.md', meta: { id: 'doc_fake', ...meta }, body }
}

function summary(overrides: Partial<DreamSummary> = {}): DreamSummary {
  return {
    dreamId: 'dream_abc',
    date: '2026-08-24',
    period: '2026-08-24',
    hasNarrative: true,
    insightCount: 1,
    dir: '/fake/memory/dreams/2026-08-24-dream_abc',
    ...overrides,
  }
}

describe('runDreamCommand: no flags (run now)', () => {
  it('calls dreamNow with no options and reports a written dream', async () => {
    const engine = stubEngine({
      dreamNow: vi.fn(
        async (): Promise<DreamRunResult> => ({
          outcome: 'written',
          dreamId: 'dream_abc',
          dir: '/fake/dir',
        }),
      ),
    })
    const { write, lines } = outputCollector()

    await runDreamCommand(engine, testConfig(), [], write)

    expect(engine.dreamNow).toHaveBeenCalledWith({})
    expect(lines()).toEqual(['Dreamt dream_abc, written to /fake/dir.\n'])
  })

  it('says plainly why it did not run when the reason is not "dreaming is off"', async () => {
    const engine = stubEngine({
      dreamNow: vi.fn(
        async (): Promise<DreamRunResult> => ({
          outcome: 'aborted',
          reason: 'fewer than 5 reflected sessions (have 2)',
        }),
      ),
    })
    const { write, lines } = outputCollector()

    await runDreamCommand(engine, testConfig(), [], write)

    expect(lines()).toEqual(['Dreaming did not run: fewer than 5 reflected sessions (have 2).\n'])
  })

  it('names the config path and the --force escape hatch when dreaming is off, unforced', async () => {
    const engine = stubEngine({
      dreamNow: vi.fn(
        async (): Promise<DreamRunResult> => ({ outcome: 'aborted', reason: 'dreaming is off' }),
      ),
    })
    const { write, lines } = outputCollector()

    await runDreamCommand(engine, testConfig(), [], write)

    expect(engine.dreamNow).toHaveBeenCalledWith({})
    const [line] = lines()
    expect(line).toContain('Dreaming is off.')
    expect(line).toContain(defaultConfigPath())
    expect(line).toContain('--force')
  })

  it('catches a thrown lock error and prints a readable line instead of a stack trace', async () => {
    const engine = stubEngine({
      dreamNow: vi.fn(async () => {
        throw new Error("ENOENT: no such file or directory, open '/fake/memory/dreams/.lock'")
      }),
    })
    const { write, lines } = outputCollector()

    await runDreamCommand(engine, testConfig(), [], write)

    const [line] = lines()
    expect(line).toBeDefined()
    expect(line).not.toContain('at ')
    expect(line).toContain('Dreaming could not run')
    expect(line).toContain('reverie doctor')
  })
})

describe('runDreamCommand: --force', () => {
  it('passes force: true through to dreamNow', async () => {
    const engine = stubEngine({
      dreamNow: vi.fn(
        async (): Promise<DreamRunResult> => ({
          outcome: 'written',
          dreamId: 'dream_z',
          dir: '/d',
        }),
      ),
    })
    const { write } = outputCollector()

    await runDreamCommand(engine, testConfig(), ['--force'], write)

    expect(engine.dreamNow).toHaveBeenCalledWith({ force: true })
  })

  it('still prints the plain reason, not the off-message, for a non-off abort under force', async () => {
    const engine = stubEngine({
      dreamNow: vi.fn(
        async (): Promise<DreamRunResult> => ({
          outcome: 'aborted',
          reason: 'another process is already dreaming',
        }),
      ),
    })
    const { write, lines } = outputCollector()

    await runDreamCommand(engine, testConfig(), ['--force'], write)

    expect(lines()).toEqual(['Dreaming did not run: another process is already dreaming.\n'])
  })
})

describe('runDreamCommand: --dry-run', () => {
  it('calls dreamNow with exactly { dryRun: true } and no other engine method', async () => {
    const dryRun: DreamDryRun = {
      dryRun: true,
      period: '2026-08-24',
      due: true,
      seeds: [{ id: 'arc_1', label: 'Marathon plan', weight: 0.42 }],
      walk: ['arc_1', 'node_2'],
    }
    const engine = stubEngine({ dreamNow: vi.fn(async () => dryRun) })
    const { write, lines } = outputCollector()

    await runDreamCommand(engine, testConfig(), ['--dry-run'], write)

    // The engine's own contract (engine.ts: dryRun returns before
    // acquireDreamLock and before any chat call) means this is the one
    // call that could spend anything, and it is invoked with the option
    // that makes it a no-op. No other engine method is called at all.
    expect(engine.dreamNow).toHaveBeenCalledTimes(1)
    expect(engine.dreamNow).toHaveBeenCalledWith({ dryRun: true })
    expect(engine.listDreams).not.toHaveBeenCalled()
    expect(engine.readDream).not.toHaveBeenCalled()

    expect(lines()).toEqual([
      'Period: 2026-08-24\n',
      'Due: yes\n',
      'Seeds:\n',
      '  0.42  arc_1  Marathon plan\n',
      'Walk: arc_1 -> node_2\n',
    ])
  })

  it('is a distinct call shape from the no-flags run (negative control on flag parsing)', async () => {
    const engine = stubEngine({
      dreamNow: vi.fn(
        async (): Promise<DreamRunResult> => ({ outcome: 'aborted', reason: 'dreaming is off' }),
      ),
    })
    const { write } = outputCollector()

    await runDreamCommand(engine, testConfig(), [], write)

    expect(engine.dreamNow).toHaveBeenCalledWith({})
    expect(engine.dreamNow).not.toHaveBeenCalledWith({ dryRun: true })
  })

  it('prints "none" for empty seeds and an empty walk without crashing', async () => {
    const dryRun: DreamDryRun = {
      dryRun: true,
      period: '2026-08-24',
      due: false,
      seeds: [],
      walk: [],
    }
    const engine = stubEngine({ dreamNow: vi.fn(async () => dryRun) })
    const { write, lines } = outputCollector()

    await runDreamCommand(engine, testConfig(), ['--dry-run'], write)

    expect(lines()).toEqual(['Period: 2026-08-24\n', 'Due: no\n', 'Seeds: none\n', 'Walk: none\n'])
  })

  it('reports plainly when dreaming has no config to preview at all', async () => {
    const engine = stubEngine({
      dreamNow: vi.fn(
        async (): Promise<DreamRunResult> => ({
          outcome: 'aborted',
          reason: 'dreaming is not configured',
        }),
      ),
    })
    const { write, lines } = outputCollector()

    await runDreamCommand(engine, testConfig(), ['--dry-run'], write)

    expect(lines()).toEqual(['Dreaming is not configured.\n'])
  })

  // The tests above stub DreamEngine and can only prove the CLI called
  // dreamNow with the right option, not that nothing was actually spent.
  // This one wires a real MemoryEngine to a FakeChatProvider and checks the
  // provider's own request log, so a bug that let --dry-run fall through to
  // a real run (or otherwise touched the model) would show up as a nonzero
  // request count here, not just a passing assertion on a mock's call args.
  describe('against a real engine (integration, no mocks on the spend path)', () => {
    let dir: string

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-dream-cli-dryrun-'))
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('makes zero chat provider requests', async () => {
      const chat = new FakeChatProvider([])
      const deps: EngineDeps = {
        chat,
        embeddings: new FakeEmbeddingProvider(),
        reflectionModel: 'fake-reflect',
        embeddingModel: 'fake-embed',
        dreamingModel: 'fake-dream',
        dreaming: {
          enabled: true,
          cadence: 'daily',
          triggers: { afterSession: true, onStart: true, serverTimer: true },
          maxToolCalls: 10,
        },
        dreamPersona: () => 'a persona',
      }
      // maintenance: false, per Ruling A4: without it, opening this engine
      // with dreaming.enabled and triggers.onStart both true would fire an
      // un-awaited background dream that could itself call the chat
      // provider, contaminating the very count this test exists to check.
      const engine = await MemoryEngine.open(dir, deps, { maintenance: false })
      const { write, lines } = outputCollector()

      try {
        await runDreamCommand(engine, testConfig(dir), ['--dry-run'], write)

        expect(chat.requests).toHaveLength(0)
        expect(lines()[0]).toMatch(/^Period: /)
      } finally {
        await engine.close()
      }
    })
  })
})

describe('runDreamCommand: --list', () => {
  it('prints a plain line when there are no dreams yet', async () => {
    const engine = stubEngine({ listDreams: vi.fn(async () => []) })
    const { write, lines } = outputCollector()

    await runDreamCommand(engine, testConfig(), ['--list'], write)

    expect(lines()).toEqual(['No dreams yet.\n'])
  })

  it('prints one line per dream: date, period, insight count, narrative present', async () => {
    const engine = stubEngine({
      listDreams: vi.fn(async () => [
        summary({ dreamId: 'dream_a', date: '2026-08-24', insightCount: 3, hasNarrative: true }),
        summary({
          dreamId: 'dream_b',
          date: '2026-08-23',
          period: '2026-W34',
          insightCount: 1,
          hasNarrative: false,
        }),
      ]),
    })
    const { write, lines } = outputCollector()

    await runDreamCommand(engine, testConfig(), ['--list'], write)

    expect(lines()).toEqual([
      '2026-08-24  2026-08-24  3 insights  narrative: yes\n',
      '2026-08-23  2026-W34  1 insight  narrative: no\n',
    ])
  })

  it('catches a thrown error while listing instead of crashing', async () => {
    const engine = stubEngine({
      listDreams: vi.fn(async () => {
        throw new Error('EACCES: permission denied')
      }),
    })
    const { write, lines } = outputCollector()

    await runDreamCommand(engine, testConfig(), ['--list'], write)

    expect(lines()).toEqual(['Could not list dreams: EACCES: permission denied\n'])
  })
})

describe('runDreamCommand: --show', () => {
  it('prints an error line and does not throw for an unknown dream id', async () => {
    const engine = stubEngine({ readDream: vi.fn(async () => null) })
    const { write, lines } = outputCollector()

    await expect(
      runDreamCommand(engine, testConfig(), ['--show', 'dream_nope'], write),
    ).resolves.toBeUndefined()

    expect(lines()).toEqual(['No dream found with id dream_nope.\n'])
  })

  it('asks for a dream id when --show has none', async () => {
    const engine = stubEngine()
    const { write, lines } = outputCollector()

    await runDreamCommand(engine, testConfig(), ['--show'], write)

    expect(engine.readDream).not.toHaveBeenCalled()
    expect(lines()).toEqual(['reverie dream --show requires a dream id.\n'])
  })

  it('prints the narrative, then insight headlines with ids, then the process log path', async () => {
    const engine = stubEngine({
      readDream: vi.fn(async () => ({
        summary: summary({ dir: '/fake/memory/dreams/2026-08-24-dream_abc' }),
        narrative: doc('You keep returning to the marathon plan.'),
        insights: doc('', {
          insights: [
            { id: 'ins_1', headline: 'You keep circling back to the marathon plan' },
            { id: 'ins_2', headline: 'A quieter week than usual' },
          ],
        }),
        processLog: '{"event":"start"}\n',
      })),
    })
    const { write, lines } = outputCollector()

    await runDreamCommand(engine, testConfig(), ['--show', 'dream_abc'], write)

    expect(lines()).toEqual([
      'You keep returning to the marathon plan.\n',
      '\n',
      'Insights:\n',
      '  ins_1  You keep circling back to the marathon plan\n',
      '  ins_2  A quieter week than usual\n',
      'Process log: /fake/memory/dreams/2026-08-24-dream_abc/process.jsonl\n',
    ])
  })

  it('says plainly that no narrative was written, rather than printing nothing, for a tone-withheld dream', async () => {
    const engine = stubEngine({
      readDream: vi.fn(async () => ({
        summary: summary(),
        insights: doc('', { insights: [{ id: 'ins_1', headline: 'A pattern worth naming' }] }),
        processLog: '',
      })),
    })
    const { write, lines } = outputCollector()

    await runDreamCommand(engine, testConfig(), ['--show', 'dream_abc'], write)

    expect(lines()[0]).toBe('No narrative was written for this dream.\n')
  })

  it('prints "Insights: none" without crashing when insight.md has no usable insights array', async () => {
    const engine = stubEngine({
      readDream: vi.fn(async () => ({
        summary: summary(),
        narrative: doc('A short dream.'),
        insights: doc(''), // no `insights` key in meta at all
        processLog: '',
      })),
    })
    const { write, lines } = outputCollector()

    await runDreamCommand(engine, testConfig(), ['--show', 'dream_abc'], write)

    expect(lines()).toContain('Insights: none\n')
  })

  it('catches a thrown error while reading a dream instead of crashing', async () => {
    const engine = stubEngine({
      readDream: vi.fn(async () => {
        throw new Error('EACCES: permission denied')
      }),
    })
    const { write, lines } = outputCollector()

    await runDreamCommand(engine, testConfig(), ['--show', 'dream_abc'], write)

    expect(lines()).toEqual(['Could not read dream dream_abc: EACCES: permission denied\n'])
  })

  describe('feedback verdicts, read from the real dream log on disk', () => {
    let dir: string

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'openreverie-dream-cli-'))
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('annotates an insight with its recorded feedback verdict', async () => {
      const paths = memoryPaths(dir)
      await mkdir(paths.dreamsDir, { recursive: true })
      await appendDreamLog(paths, [
        {
          ts: '2026-08-24T10:00:00.000Z',
          type: 'feedback',
          insight: 'ins_1',
          dream: 'dream_abc',
          verdict: 'right',
          source: 'ui',
        },
      ])

      const engine = stubEngine({
        readDream: vi.fn(async () => ({
          summary: summary(),
          narrative: doc('A dream about the marathon.'),
          insights: doc('', {
            insights: [{ id: 'ins_1', headline: 'Circling the marathon plan' }],
          }),
          processLog: '',
        })),
      })
      const { write, lines } = outputCollector()

      await runDreamCommand(engine, testConfig(dir), ['--show', 'dream_abc'], write)

      expect(lines()).toContain('  ins_1  Circling the marathon plan (marked right)\n')
    })

    it('shows no verdict annotation, and does not crash, when the dream log is missing', async () => {
      const engine = stubEngine({
        readDream: vi.fn(async () => ({
          summary: summary(),
          narrative: doc('A dream.'),
          insights: doc('', { insights: [{ id: 'ins_1', headline: 'No feedback yet' }] }),
          processLog: '',
        })),
      })
      const { write, lines } = outputCollector()

      await runDreamCommand(engine, testConfig(dir), ['--show', 'dream_abc'], write)

      expect(lines()).toContain('  ins_1  No feedback yet\n')
    })
  })
})
