import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AppApi, PublicProfile } from '../api.js'
import { Settings } from './Settings.js'

const emptyProfile: PublicProfile = {
  preferredName: null,
  pronouns: null,
  location: null,
  timezone: null,
  birthday: null,
  birthdayGreetings: null,
  occupation: null,
  style: { engagement: 'balanced', tone: 'warm', orientation: 'listening' },
  prose: '',
}

let patches: Record<string, unknown>[]
let user: ReturnType<typeof userEvent.setup>

function makeApi(profile: PublicProfile = emptyProfile): AppApi {
  return {
    getProfile: async () => profile,
    getSettings: async () => ({ safetyMode: 'companion' as const }),
    updateProfile: async (patch: Record<string, unknown>) => {
      patches.push(patch)
      return profile
    },
  } as unknown as AppApi
}

beforeEach(() => {
  patches = []
  user = userEvent.setup()
})

describe('Settings', () => {
  it('shows the safety mode read-only, with the reason', async () => {
    render(<Settings api={makeApi()} />)
    expect(await screen.findByText('companion')).toBeInTheDocument()
    expect(screen.getByText(/changed by hand in the config file/)).toBeInTheDocument()
  })

  it('renders a blank field as not known rather than an empty box that looks like a mistake', async () => {
    render(<Settings api={makeApi()} />)
    const input = await screen.findByLabelText('Preferred name')
    expect(input).toHaveAttribute('placeholder', 'not known')
    expect(input).toHaveValue('')
  })

  it('sends only whitelisted keys when a style select changes', async () => {
    render(<Settings api={makeApi()} />)
    const select = await screen.findByLabelText('Tone')
    await user.selectOptions(select, 'direct')
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toEqual({ style: { tone: 'direct' } })
  })

  it('sends null when a field is cleared, not an empty string', async () => {
    render(<Settings api={makeApi({ ...emptyProfile, location: 'Bengaluru' })} />)
    const input = await screen.findByLabelText('Location')
    await user.clear(input)
    await user.tab()
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toEqual({ location: null })
  })

  it('never sends an infrastructure key', async () => {
    render(<Settings api={makeApi()} />)
    const input = await screen.findByLabelText('Preferred name')
    await user.type(input, 'Vish')
    await user.tab()
    await waitFor(() => expect(patches).toHaveLength(1))
    for (const patch of patches) {
      for (const key of Object.keys(patch)) {
        expect([
          'preferredName',
          'pronouns',
          'location',
          'timezone',
          'birthday',
          'occupation',
          'birthdayGreetings',
          'style',
          'prose',
        ]).toContain(key)
      }
    }
  })

  it('says so plainly when settings cannot be loaded', async () => {
    const failing = {
      getProfile: async () => {
        throw new Error('offline')
      },
      getSettings: async () => ({ safetyMode: 'companion' as const }),
      updateProfile: async () => emptyProfile,
    } as unknown as AppApi
    render(<Settings api={failing} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded')
  })
})
