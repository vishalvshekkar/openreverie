import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { AppApi, PublicProfile } from '../api.js'
import './settings.css'

const ENGAGEMENT_OPTIONS = [
  [
    'leading',
    'Leading. reverie brings things up on its own and follows threads from earlier without being asked.',
  ],
  [
    'balanced',
    'Balanced. reverie mostly follows your lead, but will bring something back up if it seems worth it.',
  ],
  [
    'following',
    'Following. reverie waits for you to bring things up and rarely initiates on its own.',
  ],
] as const

const TONE_OPTIONS = [
  ['warm', 'Warm. Caring and gentle, the register of a close friend.'],
  ['playful', 'Playful. Light and a little teasing when the moment allows it.'],
  ['snarky', 'Snarky. Dry and a bit sharp-tongued, still on your side.'],
  ['direct', 'Direct. Plain and to the point, little cushioning.'],
  ['formal', 'Formal. More measured and reserved, less familiar.'],
] as const

const ORIENTATION_OPTIONS = [
  ['listening', 'Listening. Mostly reflects and asks questions, does not rush to solve.'],
  ['balanced', 'Balanced. A mix of listening and offering a next step when that seems useful.'],
  ['solutions', 'Solutions. Leans toward offering next steps and suggestions.'],
] as const

const TEXT_FIELDS = [
  ['preferredName', 'Preferred name'],
  ['pronouns', 'Pronouns'],
  ['location', 'Location'],
  ['occupation', 'Occupation'],
  ['timezone', 'Timezone'],
  ['birthday', 'Birthday'],
] as const

type TextField = (typeof TEXT_FIELDS)[number][0]

export function Settings({ api }: { api: AppApi }): JSX.Element {
  const [profile, setProfile] = useState<PublicProfile | null>(null)
  const [safetyMode, setSafetyMode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        setProfile(await api.getProfile())
        setSafetyMode((await api.getSettings()).safetyMode)
      } catch {
        setError('Settings could not be loaded. The rest of the record still works.')
      }
    })()
  }, [api])

  // Only whitelisted keys are ever sent. An empty box means the field is
  // unknown, which is null on the wire, rather than an empty string.
  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        setProfile(await api.updateProfile(body))
        setError(null)
      } catch {
        setError('That change could not be saved.')
      }
    },
    [api],
  )

  if (error !== null && profile === null) {
    return (
      <div className="settings">
        <p role="alert">{error}</p>
      </div>
    )
  }
  if (profile === null) {
    return (
      <div className="settings">
        <p>Loading settings.</p>
      </div>
    )
  }

  return (
    <div className="settings">
      <h2>Settings</h2>
      {error !== null && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}

      <section className="settings-group">
        <h3>Style</h3>
        <p className="settings-note">
          How reverie talks with you in general. This is saved and lasts.
        </p>
        <StyleSelect
          id="engagement"
          label="Engagement"
          value={profile.style.engagement}
          options={ENGAGEMENT_OPTIONS}
          onChange={(value) => void patch({ style: { engagement: value } })}
        />
        <StyleSelect
          id="tone"
          label="Tone"
          value={profile.style.tone}
          options={TONE_OPTIONS}
          onChange={(value) => void patch({ style: { tone: value } })}
        />
        <StyleSelect
          id="orientation"
          label="Orientation"
          value={profile.style.orientation}
          options={ORIENTATION_OPTIONS}
          onChange={(value) => void patch({ style: { orientation: value } })}
        />
      </section>

      <section className="settings-group">
        <h3>Profile</h3>
        <p className="settings-note">
          Every field can be left blank. Blank means not known, and nothing here is guessed.
        </p>
        {TEXT_FIELDS.map(([field, label]) => (
          <TextRow
            key={field}
            field={field}
            label={label}
            value={profile[field]}
            onCommit={(value) => void patch({ [field]: value === '' ? null : value })}
          />
        ))}
        <label className="settings-row" htmlFor="birthdayGreetings">
          <span>Birthday greetings</span>
          <input
            id="birthdayGreetings"
            type="checkbox"
            checked={profile.birthdayGreetings === true}
            onChange={(event) => void patch({ birthdayGreetings: event.target.checked })}
          />
        </label>
      </section>

      <section className="settings-group">
        <h3>Dreams</h3>
        <p className="settings-note">
          Turning dreaming on and how often it runs are set in config.toml, not here. These settings
          only shape a dream once one has run.
        </p>
        <label className="settings-row" htmlFor="dreamsVoice">
          <span>Voice</span>
          <select
            id="dreamsVoice"
            value={profile.dreams?.voice ?? 'first'}
            onChange={(event) => void patch({ dreams: { voice: event.target.value } })}
          >
            <option value="first">First person</option>
            <option value="second">Second person</option>
            <option value="third">Third person</option>
          </select>
        </label>
        <label className="settings-row" htmlFor="dreamsOpenerMention">
          <span>Mention a fresh dream when we next talk</span>
          <input
            id="dreamsOpenerMention"
            type="checkbox"
            checked={profile.dreams?.openerMention !== false}
            onChange={(event) => void patch({ dreams: { openerMention: event.target.checked } })}
          />
        </label>
        <label className="settings-row" htmlFor="dreamsPromptSection">
          <span>Let reverie recall dream insights during conversation</span>
          <input
            id="dreamsPromptSection"
            type="checkbox"
            checked={profile.dreams?.promptSection !== false}
            onChange={(event) => void patch({ dreams: { promptSection: event.target.checked } })}
          />
        </label>
      </section>

      <section className="settings-group">
        <h3>Safety mode</h3>
        <p>{safetyMode ?? 'not known'}</p>
        <p className="settings-note">
          This one is changed by hand in the config file, deliberately.
        </p>
      </section>
    </div>
  )
}

function StyleSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  value: string
  options: readonly (readonly [string, string])[]
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <label className="settings-row" htmlFor={id}>
      <span>{label}</span>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([optionValue, description]) => (
          <option key={optionValue} value={optionValue}>
            {description}
          </option>
        ))}
      </select>
    </label>
  )
}

function TextRow({
  field,
  label,
  value,
  onCommit,
}: {
  field: TextField
  label: string
  value: string | null
  onCommit: (value: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState(value ?? '')
  useEffect(() => {
    setDraft(value ?? '')
  }, [value])
  return (
    <label className="settings-row" htmlFor={field}>
      <span>{label}</span>
      <input
        id={field}
        type="text"
        value={draft}
        placeholder="not known"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== (value ?? '')) onCommit(draft)
        }}
      />
    </label>
  )
}
