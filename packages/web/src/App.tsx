import { Component, type ReactNode, useEffect, useState } from 'react'
import type { AppApi } from './api.js'
import { AtlasView } from './atlas.js'
import { Conversations } from './views/Conversations.js'
import { Journal } from './views/Journal.js'
import { Library } from './views/Library.js'
import { Settings } from './views/Settings.js'

export type ViewId = 'conversations' | 'atlas' | 'library' | 'journal' | 'settings'

const VIEW_IDS: ViewId[] = ['conversations', 'atlas', 'library', 'journal', 'settings']

const VIEW_LABELS: Record<ViewId, string> = {
  conversations: 'Talk',
  atlas: 'Atlas',
  library: 'Record',
  journal: 'Journal',
  settings: 'Settings',
}

function isViewId(value: string): value is ViewId {
  return (VIEW_IDS as string[]).includes(value)
}

export function viewFromHash(hash: string): ViewId {
  const candidate = hash.replace(/^#\/?/, '')
  return isViewId(candidate) ? candidate : 'conversations'
}

function RailIcon({ view }: { view: ViewId }) {
  if (view === 'conversations') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4H6.5" />
        <path d="M8.5 8.5h7M8.5 12h4" />
      </svg>
    )
  }
  if (view === 'atlas') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="6" r="2.2" />
        <circle cx="5.5" cy="17" r="2.2" />
        <circle cx="18.5" cy="17" r="2.2" />
        <path d="M10.6 7.9 6.9 15.1M13.4 7.9l3.7 7.2M7.7 17h8.6" />
      </svg>
    )
  }
  if (view === 'library') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H11v16H6.5A1.5 1.5 0 0 1 5 18.5z" />
        <path d="M11 4h6.5A1.5 1.5 0 0 1 19 5.5v13a1.5 1.5 0 0 1-1.5 1.5H11" />
        <path d="M13.5 8.5h3M13.5 12h3" />
      </svg>
    )
  }
  if (view === 'journal') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M6 4h10.5A1.5 1.5 0 0 1 18 5.5v13a1.5 1.5 0 0 1-1.5 1.5H6z" />
        <path d="M6 4v16M9 8.5h6M9 12h6M9 15.5h3" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" />
    </svg>
  )
}

/*
 * A view that throws must not take the whole interface down with it. The record
 * stays readable through the other destinations.
 */
class ViewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="view-error">
          <p>This view could not be displayed.</p>
          <p>The other views still work. Reload the page to try again.</p>
        </div>
      )
    }
    return this.props.children
  }
}

export function App({ api }: { api: AppApi }) {
  const [view, setView] = useState<ViewId>(() =>
    typeof window === 'undefined' ? 'conversations' : viewFromHash(window.location.hash),
  )

  useEffect(() => {
    function syncFromHash() {
      setView(viewFromHash(window.location.hash))
    }
    window.addEventListener('hashchange', syncFromHash)
    return () => window.removeEventListener('hashchange', syncFromHash)
  }, [])

  function go(next: ViewId) {
    setView(next)
    if (typeof window !== 'undefined') window.history.replaceState({}, '', `#/${next}`)
  }

  return (
    <div className="app">
      <nav className="rail" aria-label="Sections">
        <div className="rail-mark" aria-hidden="true">
          r
        </div>
        {VIEW_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className="rail-item"
            aria-current={view === id ? 'page' : undefined}
            onClick={() => go(id)}
          >
            <RailIcon view={id} />
            <span className="rail-label">{VIEW_LABELS[id]}</span>
          </button>
        ))}
      </nav>

      {/*
       * Conversations stays mounted while hidden so a live session survives a
       * trip to the atlas. The atlas is mounted only while it is on screen, so
       * the graph costs nothing at all while the user is reading or talking.
       */}
      <div className="stage">
        <div hidden={view !== 'conversations'} style={{ height: '100%', minHeight: 0 }}>
          <ViewBoundary>
            <Conversations api={api} />
          </ViewBoundary>
        </div>
        {view === 'atlas' && (
          <ViewBoundary>
            <AtlasView api={api} />
          </ViewBoundary>
        )}
        {view === 'library' && (
          <ViewBoundary>
            <Library api={api} />
          </ViewBoundary>
        )}
        {view === 'journal' && (
          <ViewBoundary>
            <Journal />
          </ViewBoundary>
        )}
        {view === 'settings' && (
          <ViewBoundary>
            <Settings api={api} />
          </ViewBoundary>
        )}
      </div>
    </div>
  )
}
