import graphology from 'graphology'
import { useEffect, useMemo, useRef, useState } from 'react'
import type Sigma from 'sigma'
import type { GraphEdge, GraphNode, GraphSnapshot } from './api.js'

// graphology ships CommonJS type declarations for an ES module build. The
// default export is the Graph class at runtime, but the declaration file nests
// it under `.default`, so unwrap it for the type checker while keeping the
// runtime default export as the value.
type GraphClass = typeof import('graphology').default
type Graph = InstanceType<GraphClass>
const Graph = graphology as unknown as GraphClass

type NodeType = GraphNode['type']

const NODE_TYPES: NodeType[] = ['realm', 'arc', 'item', 'session', 'person', 'entity']

const TYPE_COLORS: Record<NodeType, string> = {
  realm: '#303030',
  arc: '#4a4a4a',
  item: '#6b6b6b',
  session: '#8a8a8a',
  person: '#1a1a1a',
  entity: '#454545',
}

export function colorForType(type: NodeType): string {
  return TYPE_COLORS[type]
}

function seededUnit(id: string, axis: 'x' | 'y'): number {
  let hash = axis === 'x' ? 2166136261 : 16777619
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return ((hash >>> 0) / 0xffffffff) * 2 - 1
}

export interface AtlasModel {
  graph: Graph
  semanticNodes: GraphNode[]
}

export function buildAtlasModel(
  snapshot: GraphSnapshot,
  enabled: ReadonlySet<NodeType>,
): AtlasModel {
  const semanticNodes = snapshot.nodes
    .filter((node) => enabled.has(node.type))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
  const ids = new Set(semanticNodes.map((node) => node.id))
  const graph = new Graph()
  for (const node of semanticNodes) {
    graph.addNode(node.id, {
      label: node.label,
      x: seededUnit(node.id, 'x'),
      y: seededUnit(node.id, 'y'),
      size: 8,
      color: colorForType(node.type),
    })
  }
  for (const edge of snapshot.edges) {
    if (ids.has(edge.from) && ids.has(edge.to)) {
      graph.addEdgeWithKey(edge.key, edge.from, edge.to, {
        size: 1 + edge.confidence,
        color: edge.confirmed ? '#222222' : '#777777',
      })
    }
  }
  return { graph, semanticNodes }
}

function webglAvailable(): boolean {
  if (typeof WebGLRenderingContext === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return canvas.getContext('webgl') !== null
  } catch {
    return false
  }
}

function AtlasDetail({
  node,
  edges,
  onOpenDocument,
}: {
  node: GraphNode
  edges: GraphEdge[]
  onOpenDocument: (docId: string) => void
}) {
  const docId = node.docId
  return (
    <div>
      <h2>{node.label}</h2>
      <dl className="atlas-facts">
        <dt>Type</dt>
        <dd>{node.type}</dd>
        <dt>Asserted</dt>
        <dd>{node.assertedAt}</dd>
        {docId !== undefined && (
          <>
            <dt>Document</dt>
            <dd>{docId}</dd>
          </>
        )}
      </dl>
      {edges.length > 0 && (
        <div className="atlas-edges">
          <h3>Relationships</h3>
          <ul>
            {edges.map((edge) => (
              <li key={edge.key}>
                <span className="atlas-edge-type">{edge.type}</span>
                <span>Confidence: {edge.confidence}</span>
                <span>{edge.confirmed ? 'Confirmed' : 'Unconfirmed'}</span>
                {edge.sourceSessionId !== undefined && (
                  <span>Source session: {edge.sourceSessionId}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="atlas-history">Assertion history is not available in this release.</p>
      {docId !== undefined && (
        <button type="button" onClick={() => onOpenDocument(docId)}>
          Open document
        </button>
      )}
    </div>
  )
}

export function Atlas({
  snapshot,
  onOpenDocument,
}: {
  snapshot: GraphSnapshot
  onOpenDocument: (docId: string) => void
}) {
  const [enabled, setEnabled] = useState<Set<NodeType>>(() => new Set(NODE_TYPES))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const model = useMemo(() => buildAtlasModel(snapshot, enabled), [snapshot, enabled])

  const selectedNode = useMemo(
    () => (selectedId === null ? undefined : snapshot.nodes.find((node) => node.id === selectedId)),
    [snapshot, selectedId],
  )

  const selectedEdges = useMemo(
    () =>
      selectedId === null
        ? []
        : snapshot.edges.filter((edge) => edge.from === selectedId || edge.to === selectedId),
    [snapshot, selectedId],
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container || model.graph.order === 0 || !webglAvailable()) return

    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const settings = reducedMotion ? { zoomDuration: 0, doubleClickZoomingDuration: 0 } : {}

    let cancelled = false
    let renderer: Sigma | null = null

    void import('sigma').then(({ default: SigmaClass }) => {
      if (cancelled) return
      try {
        renderer = new SigmaClass(model.graph, container, settings)
        renderer.on('clickNode', ({ node }) => setSelectedId(node))
        renderer.on('clickStage', () => setSelectedId(null))
      } catch {
        // Sigma needs WebGL and a real canvas. The semantic list and detail panel still work.
      }
    })

    return () => {
      cancelled = true
      renderer?.kill()
    }
  }, [model])

  function toggleType(type: NodeType) {
    setEnabled((current) => {
      const next = new Set(current)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  function selectNode(node: GraphNode) {
    setSelectedId(node.id)
  }

  if (model.semanticNodes.length === 0) {
    return (
      <section className="atlas" aria-label="Atlas">
        <p className="atlas-empty">No graph records yet.</p>
      </section>
    )
  }

  return (
    <section className="atlas" aria-label="Atlas">
      <div className="atlas-canvas" ref={containerRef} />
      <div className="atlas-sidebar">
        <ul className="atlas-node-list" aria-label="Atlas nodes">
          {model.semanticNodes.map((node) => (
            <li key={node.id}>
              <button type="button" onClick={() => selectNode(node)}>
                {node.label}
              </button>
            </li>
          ))}
        </ul>
        <fieldset className="atlas-filter">
          <legend>Node types</legend>
          {NODE_TYPES.map((type) => (
            <label key={type}>
              <input
                type="checkbox"
                checked={enabled.has(type)}
                onChange={() => toggleType(type)}
              />
              {type}
            </label>
          ))}
        </fieldset>
      </div>
      <aside className="atlas-detail" aria-live="polite">
        {selectedNode !== undefined ? (
          <AtlasDetail node={selectedNode} edges={selectedEdges} onOpenDocument={onOpenDocument} />
        ) : (
          <p className="atlas-detail-hint">Select a node to see its details.</p>
        )}
      </aside>
    </section>
  )
}
