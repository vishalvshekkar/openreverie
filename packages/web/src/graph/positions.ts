import type { Point, Positions } from './layout.js'

const STORAGE_KEY = 'openreverie.atlas.positions'

function resolveStorage(storage: Storage | undefined): Storage | undefined {
  if (storage !== undefined) return storage
  return typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage
}

function isFinitePoint(value: unknown): value is Point {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Point>
  return (
    typeof candidate.x === 'number' &&
    typeof candidate.y === 'number' &&
    Number.isFinite(candidate.x) &&
    Number.isFinite(candidate.y)
  )
}

// Loads saved node positions. Never throws: a missing key, a throwing
// Storage, unparseable JSON, or a value with the wrong shape all resolve to
// an empty result rather than propagating. Entries for node ids that no
// longer exist in the graph are returned as-is; the caller (layout.ts) only
// looks up ids present in the current graph, so stale entries are harmless.
export function loadPositions(storage?: Storage): Positions {
  const store = resolveStorage(storage)
  if (store === undefined) return {}

  let raw: string | null
  try {
    raw = store.getItem(STORAGE_KEY)
  } catch {
    return {}
  }
  if (raw === null) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}

  const result: Positions = {}
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isFinitePoint(value)) result[id] = { x: value.x, y: value.y }
  }
  return result
}

// Saves only finite base coordinates. Non-finite entries are dropped before
// serializing rather than written as null or omitted silently mid-object,
// since JSON.stringify would otherwise turn NaN/Infinity into `null`. A
// throwing Storage (private mode, quota) is swallowed: losing a save is
// acceptable, corrupting stored state is not.
export function savePositions(positions: Positions, storage?: Storage): void {
  const store = resolveStorage(storage)
  if (store === undefined) return

  const clean: Positions = {}
  for (const [id, point] of Object.entries(positions)) {
    if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
      clean[id] = { x: point.x, y: point.y }
    }
  }

  try {
    store.setItem(STORAGE_KEY, JSON.stringify(clean))
  } catch {
    // Ignored: see function comment above.
  }
}

export function clearPositions(storage?: Storage): void {
  const store = resolveStorage(storage)
  if (store === undefined) return
  try {
    store.removeItem(STORAGE_KEY)
  } catch {
    // Ignored: see savePositions above.
  }
}
