import { describe, expect, it, vi } from 'vitest'
import { mainWith } from './index.js'
import { runWebCommand } from './web.js'

describe('runWebCommand', () => {
  it('waits for a termination signal, closes the server, and removes listeners', async () => {
    const handlers = new Map<string, () => void>()
    const close = vi.fn(async () => {})
    const launchServer = vi.fn(async () => ({
      origin: 'http://127.0.0.1:4312',
      bootstrapUrl: 'http://127.0.0.1:4312/?token=test',
      close,
    }))
    const promise = runWebCommand({
      launchServer,
      write: () => {},
      signals: {
        on: (signal, handler) => handlers.set(signal, handler),
        off: (signal) => handlers.delete(signal),
      },
    })

    await vi.waitFor(() => expect(handlers.has('SIGINT')).toBe(true))
    handlers.get('SIGINT')?.()
    await promise

    expect(close).toHaveBeenCalledOnce()
    expect(handlers.size).toBe(0)
  })
})

describe('mainWith', () => {
  it('dispatches web before normal chat setup and keeps read dispatch separate', async () => {
    const runWeb = vi.fn(async () => {})
    const runRead = vi.fn(async () => 0)
    const openCliContext = vi.fn()
    const deps = {
      runWeb,
      runRead,
      runSetup: vi.fn(async () => {}),
      openCliContext,
      write: () => {},
      colorEnabled: () => false,
    }

    await mainWith(['web'], deps as never)
    await mainWith(['read'], deps as never)

    expect(runWeb).toHaveBeenCalledOnce()
    expect(runRead).toHaveBeenCalledOnce()
    expect(openCliContext).not.toHaveBeenCalled()
  })
})
