import type { ServerLaunchOptions } from '@openreverie/server'

interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown
  off(signal: NodeJS.Signals, listener: () => void): unknown
}

export interface RunWebCommandDeps {
  launchServer: (options: ServerLaunchOptions) => Promise<{ close(): Promise<void> }>
  write: (line: string) => void
  configPath?: string
  signals?: SignalSource
}

export async function runWebCommand(deps: RunWebCommandDeps): Promise<void> {
  const running = await deps.launchServer({
    write: deps.write,
    ...(deps.configPath === undefined ? {} : { configPath: deps.configPath }),
  })
  const signals = deps.signals ?? process
  let stop: (() => void) | undefined
  const stopped = new Promise<void>((resolve) => {
    stop = resolve
  })
  const onSignal = (): void => stop?.()
  signals.on('SIGINT', onSignal)
  signals.on('SIGTERM', onSignal)
  try {
    await stopped
  } finally {
    signals.off('SIGINT', onSignal)
    signals.off('SIGTERM', onSignal)
    await running.close()
  }
}
