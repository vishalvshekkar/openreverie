// `reverie dream`: run a dream on demand, preview one without spending
// anything, list past dreams, or read one back. All four actions delegate
// to the engine (dreamNow, listDreams, readDream); this file only parses
// the flags and renders the result as text a person reads in a terminal.
//
// engine is typed as DreamEngine, a narrow structural interface, not the
// concrete MemoryEngine class: the same move commands.ts makes for
// CommandEngine. The real MemoryEngine already satisfies it as written, so
// index.ts passes the real engine straight through, and tests can hand
// this a plain stub object with vi.fn() methods instead of casting one
// through unknown.

import { join } from 'node:path'
import { defaultConfigPath, type ReverieConfig } from '@openreverie/core'
import {
  type Document,
  type DreamDryRun,
  type DreamRunResult,
  type DreamSummary,
  foldDreamLog,
  memoryPaths,
  nodeStores,
  readDreamLog,
} from '@openreverie/memory'

export interface DreamEngine {
  dreamNow(options?: { force?: boolean; dryRun?: boolean }): Promise<DreamRunResult | DreamDryRun>
  listDreams(): Promise<DreamSummary[]>
  readDream(dreamId: string): Promise<{
    summary: DreamSummary
    narrative?: Document
    insights: Document
    processLog: string
  } | null>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatWeight(weight: number): string {
  return weight.toFixed(2)
}

async function runDryRun(engine: DreamEngine, write: (line: string) => void): Promise<void> {
  let result: DreamRunResult | DreamDryRun
  try {
    result = await engine.dreamNow({ dryRun: true })
  } catch (err) {
    write(`Could not preview a dream: ${errorMessage(err)}\n`)
    return
  }

  if (!('dryRun' in result) || result.dryRun !== true) {
    // dreamNow skips the dry-run shape only when dreaming has no config at
    // all wired into the engine, which means there is nothing to preview.
    write('Dreaming is not configured.\n')
    return
  }

  write(`Period: ${result.period}\n`)
  write(`Due: ${result.due ? 'yes' : 'no'}\n`)
  if (result.seeds.length === 0) {
    write('Seeds: none\n')
  } else {
    write('Seeds:\n')
    for (const seed of result.seeds) {
      write(`  ${formatWeight(seed.weight)}  ${seed.id}  ${seed.label}\n`)
    }
  }
  write(result.walk.length === 0 ? 'Walk: none\n' : `Walk: ${result.walk.join(' -> ')}\n`)
}

async function runNow(
  engine: DreamEngine,
  force: boolean,
  write: (line: string) => void,
): Promise<void> {
  let result: DreamRunResult | DreamDryRun
  try {
    result = await engine.dreamNow(force ? { force: true } : {})
  } catch (err) {
    write(
      `Dreaming could not run: ${errorMessage(err)}. Your memory folder may be damaged; try 'reverie doctor'.\n`,
    )
    return
  }

  if ('dryRun' in result) {
    // This function never passes dryRun, so dreamNow cannot actually
    // return the preview shape here. Handled anyway so both members of
    // the return type are covered.
    write('Dreaming did not run.\n')
    return
  }

  if (result.outcome === 'aborted') {
    if (!force && result.reason === 'dreaming is off') {
      write(
        `Dreaming is off. Turn it on by setting enabled = true under [dreaming] in your config file (the default location is ${defaultConfigPath()}), or run 'reverie dream --force' to dream anyway.\n`,
      )
      return
    }
    write(`Dreaming did not run: ${result.reason}.\n`)
    return
  }

  write(`Dreamt ${result.dreamId ?? 'unknown'}, written to ${result.dir ?? 'unknown'}.\n`)
}

async function runList(engine: DreamEngine, write: (line: string) => void): Promise<void> {
  let dreams: DreamSummary[]
  try {
    dreams = await engine.listDreams()
  } catch (err) {
    write(`Could not list dreams: ${errorMessage(err)}\n`)
    return
  }

  if (dreams.length === 0) {
    write('No dreams yet.\n')
    return
  }

  for (const dream of dreams) {
    const insightWord = dream.insightCount === 1 ? 'insight' : 'insights'
    write(
      `${dream.date}  ${dream.period}  ${dream.insightCount} ${insightWord}  narrative: ${dream.hasNarrative ? 'yes' : 'no'}\n`,
    )
  }
}

// Feedback verdicts live only in the append-only dream log, not in
// insight.md itself (a written insight is a record; feedback on it is a
// separate, later event). readDream does not carry them, so --show reads
// the log directly. A corrupt or unreadable log means verdicts are simply
// not shown; --show must still work, just without that annotation.
async function feedbackVerdicts(config: ReverieConfig): Promise<Map<string, string>> {
  try {
    const paths = memoryPaths(config.memoryDir, nodeStores())
    const records = await readDreamLog(paths)
    const state = foldDreamLog(records)
    const verdicts = new Map<string, string>()
    for (const [insightId, record] of state.feedback) {
      verdicts.set(insightId, record.verdict)
    }
    return verdicts
  } catch {
    return new Map()
  }
}

async function runShow(
  engine: DreamEngine,
  config: ReverieConfig,
  dreamId: string,
  write: (line: string) => void,
): Promise<void> {
  let result: Awaited<ReturnType<DreamEngine['readDream']>>
  try {
    result = await engine.readDream(dreamId)
  } catch (err) {
    write(`Could not read dream ${dreamId}: ${errorMessage(err)}\n`)
    return
  }

  if (result === null) {
    write(`No dream found with id ${dreamId}.\n`)
    return
  }

  if (result.narrative !== undefined) {
    write(`${result.narrative.body.trim()}\n`)
  } else {
    write('No narrative was written for this dream.\n')
  }
  write('\n')

  const rawInsights = result.insights.meta.insights
  const insights = Array.isArray(rawInsights) ? rawInsights : []
  if (insights.length === 0) {
    write('Insights: none\n')
  } else {
    const verdicts = await feedbackVerdicts(config)
    write('Insights:\n')
    for (const raw of insights) {
      const insight = raw as { id?: unknown; headline?: unknown }
      const id = typeof insight.id === 'string' ? insight.id : 'unknown'
      const headline = typeof insight.headline === 'string' ? insight.headline : '(no headline)'
      const verdict = verdicts.get(id)
      write(`  ${id}  ${headline}${verdict !== undefined ? ` (marked ${verdict})` : ''}\n`)
    }
  }

  write(`Process log: ${join(result.summary.dir, 'process.jsonl')}\n`)
}

export async function runDreamCommand(
  engine: DreamEngine,
  config: ReverieConfig,
  args: string[],
  write: (line: string) => void,
): Promise<void> {
  const showIndex = args.indexOf('--show')
  if (showIndex !== -1) {
    const dreamId = args[showIndex + 1]
    if (dreamId === undefined || dreamId.startsWith('-')) {
      write('reverie dream --show requires a dream id.\n')
      return
    }
    await runShow(engine, config, dreamId, write)
    return
  }

  if (args.includes('--list')) {
    await runList(engine, write)
    return
  }

  if (args.includes('--dry-run')) {
    await runDryRun(engine, write)
    return
  }

  await runNow(engine, args.includes('--force'), write)
}
