import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App, viewFromHash } from './App.js'
import type { AppApi } from './api.js'

/*
 * The shell is tested on its own. Each view is replaced with a marker that
 * records how many times it mounted, so these tests describe navigation and
 * mounting policy rather than the contents of any view.
 */

let conversationsMounts = 0
let atlasMounts = 0
let libraryMounts = 0

vi.mock('./views/Conversations.js', () => ({
  Conversations: () => {
    // Counted in an effect with no dependencies, so this records mounts rather
    // than renders. A re-render must not look like a remount.
    useEffect(() => {
      conversationsMounts += 1
    }, [])
    return <div>conversations view</div>
  },
}))

vi.mock('./atlas.js', () => ({
  AtlasView: () => {
    useEffect(() => {
      atlasMounts += 1
    }, [])
    return <div>atlas view</div>
  },
}))

vi.mock('./views/Library.js', () => ({
  Library: () => {
    useEffect(() => {
      libraryMounts += 1
    }, [])
    return <div>library view</div>
  },
}))

const api = {} as AppApi
let user: ReturnType<typeof userEvent.setup>

beforeEach(() => {
  user = userEvent.setup()
  conversationsMounts = 0
  atlasMounts = 0
  libraryMounts = 0
  window.history.replaceState({}, '', '/')
})

describe('viewFromHash', () => {
  it('reads a known view out of the hash', () => {
    expect(viewFromHash('#/atlas')).toBe('atlas')
    expect(viewFromHash('#library')).toBe('library')
  })

  it('falls back to conversations for anything else', () => {
    expect(viewFromHash('')).toBe('conversations')
    expect(viewFromHash('#/nonsense')).toBe('conversations')
  })
})

describe('App shell', () => {
  it('opens on conversations and leaves the atlas unmounted', () => {
    render(<App api={api} />)
    expect(screen.getByText('conversations view')).toBeVisible()
    expect(atlasMounts).toBe(0)
    expect(libraryMounts).toBe(0)
  })

  it('mounts the atlas only once it is selected', async () => {
    render(<App api={api} />)
    await user.click(screen.getByRole('button', { name: /atlas/i }))
    expect(screen.getByText('atlas view')).toBeVisible()
    expect(atlasMounts).toBe(1)
  })

  it('unmounts the atlas on the way back so the graph costs nothing while reading', async () => {
    render(<App api={api} />)
    await user.click(screen.getByRole('button', { name: /atlas/i }))
    await user.click(screen.getByRole('button', { name: /talk/i }))
    expect(screen.queryByText('atlas view')).not.toBeInTheDocument()
  })

  it('keeps conversations mounted across a trip to the atlas so a live session survives', async () => {
    render(<App api={api} />)
    await user.click(screen.getByRole('button', { name: /atlas/i }))
    await user.click(screen.getByRole('button', { name: /record/i }))
    await user.click(screen.getByRole('button', { name: /talk/i }))
    expect(conversationsMounts).toBe(1)
    expect(screen.getByText('conversations view')).toBeVisible()
  })

  it('hides conversations rather than showing two views at once', async () => {
    render(<App api={api} />)
    await user.click(screen.getByRole('button', { name: /atlas/i }))
    expect(screen.getByText('conversations view')).not.toBeVisible()
  })

  it('marks the current destination in the rail', async () => {
    render(<App api={api} />)
    await user.click(screen.getByRole('button', { name: /record/i }))
    expect(screen.getByRole('button', { name: /record/i })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: /talk/i })).not.toHaveAttribute('aria-current')
  })

  it('restores the view named in the address bar', () => {
    window.history.replaceState({}, '', '#/library')
    render(<App api={api} />)
    expect(screen.getByText('library view')).toBeVisible()
  })
})
