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

  it('defaults the dreams voice to first person and the two checkboxes to on when profile.dreams is absent', async () => {
    render(<Settings api={makeApi()} />)
    expect(await screen.findByLabelText('Voice')).toHaveValue('first')
    expect(screen.getByLabelText('Mention a fresh dream when we next talk')).toBeChecked()
    expect(
      screen.getByLabelText('Let reverie recall dream insights during conversation'),
    ).toBeChecked()
  })

  it('reflects an explicit dreams voice and a checkbox turned off', async () => {
    render(
      <Settings
        api={makeApi({
          ...emptyProfile,
          dreams: { voice: 'second', openerMention: false },
        })}
      />,
    )
    expect(await screen.findByLabelText('Voice')).toHaveValue('second')
    expect(screen.getByLabelText('Mention a fresh dream when we next talk')).not.toBeChecked()
    expect(
      screen.getByLabelText('Let reverie recall dream insights during conversation'),
    ).toBeChecked()
  })

  it('patches dreams.voice through the profile PATCH path when the select changes', async () => {
    render(<Settings api={makeApi()} />)
    const select = await screen.findByLabelText('Voice')
    await user.selectOptions(select, 'third')
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toEqual({ dreams: { voice: 'third' } })
  })

  it('patches dreams.promptSection through the profile PATCH path when its checkbox changes', async () => {
    render(<Settings api={makeApi()} />)
    const checkbox = await screen.findByLabelText(
      'Let reverie recall dream insights during conversation',
    )
    await user.click(checkbox)
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toEqual({ dreams: { promptSection: false } })
  })

  it('says plainly that enabling dreaming and its cadence live in config.toml, not here', async () => {
    render(<Settings api={makeApi()} />)
    expect(await screen.findByText('Dreams')).toBeInTheDocument()
    expect(screen.getByText(/config\.toml/)).toBeInTheDocument()
  })

  // The user's own complaint: "the settings in the web should mention how
  // to save it, or should say whatever you change is automatically saved
  // instantly". Every field on this page calls updateProfile on change (a
  // select or checkbox) or on blur (a text field), which writes profile.md
  // atomically via engine.updateProfileSettings; there is no separate save
  // step anywhere on this page. The copy states that, and only that: it
  // must not claim anything about config.toml-governed settings, which are
  // not on this page at all.
  it('states plainly that every field on the page saves automatically, with no save button', async () => {
    render(<Settings api={makeApi()} />)
    const note = await screen.findByText(/saved the moment you change it/)
    expect(note).toHaveTextContent(/no separate save button/i)
  })

  // config.toml is read once at startup (packages/server/src/launch.ts
  // calls loadConfig exactly once and bakes config.dreaming into the
  // registry's dreamTrigger wiring at construction time), so a hand-edit
  // to config.toml's [dreaming] table cannot take effect in an already
  // running server or CLI session. The Dreams section must say this
  // plainly rather than implying a config.toml edit takes effect live the
  // way this page's own fields do.
  it('says a config.toml dreaming change takes effect on the next start, not while the current process keeps running', async () => {
    render(<Settings api={makeApi()} />)
    await screen.findByText('Dreams')
    expect(screen.getByText(/next time you start/)).toBeInTheDocument()
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
