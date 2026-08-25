import graphology from 'graphology'
import { useEffect, useMemo, useRef, useState } from 'react'
import type Sigma from 'sigma'
import type { EdgeDisplayData, NodeDisplayData } from 'sigma/types'
import type { AppApi, Document, GraphEdge, GraphNode, GraphSnapshot } from './api.js'
import './atlas.css'
import { computeLayout, type Positions } from './graph/layout.js'
import { loadPositions, savePositions } from './graph/positions.js'

// graphology ships CommonJS type declarations for an ES module build. The
// default export is the Graph class at runtime, but the declaration file nests
// it under `.default`, so unwrap it for the type checker while keeping the
// runtime default export as the value.
type GraphClass = typeof import('graphology').default
type Graph = InstanceType<GraphClass>
const Graph = graphology as unknown as GraphClass

export type NodeType = GraphNode['type']

// 'commitment' was added here to keep this list, and the Record<NodeType, ...>
// maps below, matching GraphNode['type'] (the compiler enforces the Records;
// nothing enforces this plain array, so check it by hand whenever NodeType
// gains a member). Its visual identity below is a minimal, functional
// default, not a considered design: the commitments plan explicitly
// deferred the browser Record view for commitments to a separate plan, and
// this file's own colour ramp, border width, and size band comments
// describe a deliberate ordering that a follow-up should revisit rather
// than this task guessing at.
const NODE_TYPES: NodeType[] = ['realm', 'arc', 'item', 'session', 'person', 'entity', 'commitment']

const DEFAULT_ENABLED: NodeType[] = NODE_TYPES.filter((type) => type !== 'item')

const PLURAL: Record<NodeType, string> = {
  realm: 'realms',
  arc: 'arcs',
  item: 'items',
  session: 'sessions',
  person: 'people',
  entity: 'entities',
  commitment: 'commitments',
}

// Visual weight order, strongest (realm) to weakest (commitment): realm,
// arc, person, entity, session, item, commitment. Drives node size
// (TYPE_SIZE_BAND) and ring thickness (TYPE_BORDER_WIDTH) below, and is
// also the order the seven accent hues in tokens.css are assigned in (see
// TYPE_COLOR_VAR just below) -- not because hue needs a "strength" ordering
// the way the old monochrome ramp did, but so the visual-weight channels
// (size, ring width) and the identity channel (hue) are indexed by the same
// order rather than three orders that could silently drift apart. Not kept
// as a runtime array (an earlier version of this file had one,
// TYPE_PRIORITY, purely so borderColorForType could look up "the next-
// stronger type"; that lookup is gone now that the ring is a flat neutral
// colour, see borderColorForType below, so nothing here still needs the
// order at runtime, only in the three Records below agreeing on it).
// 'commitment' is appended after 'item' rather than inserted at its
// considered place in the weight order, so the five original entries keep
// their existing size bands, ring widths, and hues (renumbering them would
// change every node type's visual weight and colour already shipped, not
// just add one). It continues the same downward trend, making it the
// smallest, thinnest-ringed entry with the last hue slot: a placeholder
// weight, not a judgment that commitments matter least.

// Type -> CSS custom property name. tokens.css defines each of these once,
// with a light value in :root and a dark override in the
// `@media (prefers-color-scheme: dark)` block (the same single-name pattern
// every other token in that file already uses), so the browser resolves the
// right value on its own; readCSSVar below just asks for whichever one is
// live. See tokens.css's own comment on these seven for the full palette
// rationale (which hue per type, and why) and the measured contrast/CVD
// numbers; the short version: the visual-weight order above maps onto the
// dataviz skill's fixed 7-slot categorical order (blue, orange, aqua,
// yellow, magenta, green, violet), so realm is always blue and commitment
// is always violet, in both themes.
const TYPE_COLOR_VAR: Record<NodeType, string> = {
  realm: '--type-realm',
  arc: '--type-arc',
  person: '--type-person',
  entity: '--type-entity',
  session: '--type-session',
  item: '--type-item',
  commitment: '--type-commitment',
}

// Literal mirror of tokens.css's --type-* values, used only where a live
// stylesheet cannot be read: this package's own jsdom test suite (vite.config.ts
// leaves vitest's `test.css` at its default of false, so `import './atlas.css'`
// -- and transitively tokens.css -- is a no-op under test), and the brief
// window before a real browser has parsed the stylesheet at all. tokens.css
// stays the single source of truth for what actually ships; atlas.test.tsx's
// node-type-colour-coverage test parses tokens.css's own text and fails the
// moment these two drift from it, so this is a documented, guarded mirror,
// not a second hand-eyeballed palette.
const LIGHT_TYPE_COLORS: Record<NodeType, string> = {
  realm: '#2a78d6',
  arc: '#e76530',
  person: '#00a06e',
  entity: '#bd8110',
  session: '#d56a93',
  item: '#008300',
  commitment: '#4a3aa7',
}

const DARK_TYPE_COLORS: Record<NodeType, string> = {
  realm: '#3987e5',
  arc: '#d95926',
  person: '#199e70',
  entity: '#c98500',
  session: '#d55181',
  item: '#008300',
  commitment: '#9085e9',
}

function prefersDarkGround(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

// Reads a CSS custom property from the live document, falling back to a
// literal when that is not possible. A single custom property name (the
// pattern every token in tokens.css uses) only ever resolves to whichever
// theme's `@media` block actually matches the browser's live
// prefers-color-scheme state -- it cannot answer "what would this look like
// in the OTHER theme", there is no such thing as asking getComputedStyle for
// a counterfactual. So the live read is only trustworthy when the caller is
// asking about the theme actually in effect (`dark === prefersDarkGround()`);
// anything else -- an explicit request for the other ramp (tests probing
// both branches, or borderColorForType-style callers wanting a specific
// ground regardless of the OS setting), or an environment with no
// resolvable stylesheet at all -- falls back to the literal instead of
// silently mislabelling the live theme's colour as the other one.
function readCSSVar(varName: string, dark: boolean, fallback: string): string {
  if (typeof document === 'undefined' || dark !== prefersDarkGround()) return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return value === '' ? fallback : value
}

// `dark` defaults to a live read of the media query so call sites in
// component code never have to know which ground is active, while tests
// (and the legend, which recomputes per render anyway) can pass it
// explicitly to check either ramp. The live path re-reads the stylesheet on
// every call rather than caching, so a caller that re-invokes this after a
// prefers-color-scheme change (see the Atlas component's matchMedia
// listener) gets the current theme's colour, not a frozen one.
export function colorForType(type: NodeType, dark: boolean = prefersDarkGround()): string {
  return readCSSVar(TYPE_COLOR_VAR[type], dark, (dark ? DARK_TYPE_COLORS : LIGHT_TYPE_COLORS)[type])
}

// Splits a 6-digit hex colour into its three channel bytes. Local to this
// module; the only caller is mixHex just below.
function hexChannels(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  return [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ]
}

// Linear interpolation between two opaque hex colours: t = 0 yields `from`,
// t = 1 yields `to`. This, not alpha, is how edges get "quieter" below.
// WebGL alpha blending was the first approach tried here and was rejected
// after reading the installed sigma 3.0.3 edge shaders
// (dist/index-fad77a13.esm.js): both edge vertex shaders set
// `v_color = a_color` and only nudge the alpha channel by a fixed `bias`
// constant; neither one multiplies v_color.rgb by alpha (no premultiplication
// anywhere in the shader source). Sigma still calls gl.blendFunc(gl.ONE,
// gl.ONE_MINUS_SRC_ALPHA) (sigma.esm.js), which is the correct blend
// function for premultiplied colour but produces a nearly full-brightness
// line regardless of alpha when fed a straight (non-premultiplied) colour,
// exactly the opposite of "faint". A low-alpha "#RRGGBBAA" edge colour would
// have looked barely dimmer than a fully opaque one. Mixing toward an
// already-opaque target colour sidesteps that shader entirely: the browser
// never sees an alpha channel to mishandle.
function mixHex(from: string, to: string, t: number): string {
  const [fromR, fromG, fromB] = hexChannels(from)
  const [toR, toG, toB] = hexChannels(to)
  const mix = (start: number, end: number) => Math.round(start + (end - start) * t)
  return [mix(fromR, toR), mix(fromG, toG), mix(fromB, toB)]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .reduce((hex, byte) => hex + byte, '#')
}

// How far a rest-state edge is mixed from the strong realm colour toward
// dimColor's paper-adjacent literal (0 = full realm strength, 1 = dimColor
// itself). Unconfirmed sits closer to dimColor than confirmed, so it reads
// as fainter without introducing a second hue: the whole edge palette is
// realm shade at varying muteness, never item's or any other type's colour,
// which is what let a bug like "unconfirmed edges are the light end of the
// ramp, so they are pale rather than faint on light paper" happen before.
const EDGE_REST_MIX_CONFIRMED = 0.55
const EDGE_REST_MIX_UNCONFIRMED = 0.75

// The rest-state (non-hovered) edge colour: dim, opaque, same hue family as
// the realm ramp on whichever ground is active, so it is dark-and-faint on
// light paper and light-and-faint on dark paper, never the wrong direction.
// Exported so the confirmed/unconfirmed distinction is unit testable; jsdom
// cannot render WebGL, so this is as close to the real edge appearance as an
// automated test can get here (see atlas.test.tsx for what is and is not
// checked).
export function edgeColor(confirmed: boolean, dark: boolean): string {
  return mixHex(
    colorForType('realm', dark),
    dimColor(dark),
    confirmed ? EDGE_REST_MIX_CONFIRMED : EDGE_REST_MIX_UNCONFIRMED,
  )
}

// The colour an edge takes when it touches the hovered node: full realm
// strength, i.e. mix fraction 0. This is what used to be the *only* edge
// colour (see the removed version of edgeColor above); reserving it for
// hover emphasis, instead of using it as the resting state, is the actual
// Problem 1 fix. edgeReducer below is what switches an edge into this
// colour instead of its resting edgeColor() value.
function edgeEmphasisColor(dark: boolean): string {
  return colorForType('realm', dark)
}

// Edge thickness stays in a narrow band regardless of confidence: a
// zero-confidence edge draws at EDGE_SIZE_BASE, a confidence-1.0 edge at
// EDGE_SIZE_BASE + EDGE_SIZE_CONFIDENCE_RANGE, a 40% relative increase and a
// 0.4px absolute one. Exported alongside edgeColor for the same reason: it
// is a pure function of data already on GraphEdge, so it is unit testable
// without a renderer.
const EDGE_SIZE_BASE = 1
const EDGE_SIZE_CONFIDENCE_RANGE = 0.4

export function edgeSize(confidence: number): number {
  return EDGE_SIZE_BASE + confidence * EDGE_SIZE_CONFIDENCE_RANGE
}

// The ring @sigma/node-border draws around every node, in the graph
// canvas's own surface colour (--panel; see the dataviz skill's "surface
// ring" mark spec: a ring in the SURFACE colour, not a contrasting stroke,
// is what keeps overlapping marks legible without adding ink that isn't
// data). Deliberately the same colour for every type, `type` is accepted
// only to keep this function's shape matching colorForType's: an earlier
// version borrowed the next-stronger type's FILL colour from the visual-weight order,
// which worked when the fill ramp was monochrome (any two adjacent shades
// were clearly different, so a ring never looked like it belonged to
// another type) but stopped working the moment fills became per-type hues:
// an entity node (yellow fill) would have worn a person-hued (aqua) ring,
// putting a second type's identity colour on every single node. A neutral
// surface ring separates nodes from each other and from the canvas
// background without impersonating any type, so identity now comes from
// exactly one channel (fill hue) instead of two that could disagree.
// TYPE_BORDER_WIDTH just below still varies by type: ring THICKNESS is a
// size-family cue, not a hue one, and keeping it lets a colour-blind reader
// use ring weight the same way a sighted reader uses node size.
export function borderColorForType(_type: NodeType, dark: boolean = prefersDarkGround()): string {
  return readCSSVar('--panel', dark, dark ? '#1b1915' : '#f7f5f1')
}

// Ring thickness as a fraction of each node's own radius (the node-border
// package's "relative" size mode: see BorderedNodeProgram below), so a
// realm's ring reads proportionally the same whether the node itself is
// drawn large or small. Ordered by the same priority as the fill ramp: the
// strongest types carry the thickest ring.
const TYPE_BORDER_WIDTH: Record<NodeType, number> = {
  realm: 0.22,
  arc: 0.19,
  person: 0.16,
  entity: 0.13,
  session: 0.11,
  item: 0.09,
  // Appended, continuing the downward trend, rather than inserted at a
  // considered rank: see the visual-weight order comment near the top of
  // this file.
  commitment: 0.07,
}

// Hover emphasis dims everything but the hovered node and its direct
// neighbours (see the nodeReducer/edgeReducer wiring below) by recolouring
// rather than hiding, so the dimmed shape of the graph stays legible. Reuses
// the same two literals as the `--rule` token on each ground: a shade close
// enough to the paper itself to read as "receded" without vanishing.
function dimColor(dark: boolean): string {
  return dark ? '#2c2924' : '#e2ded5'
}

// Each type gets its own non-overlapping size band ordered by the same
// visual-weight priority as the colour ramp, so a realm is always drawn
// larger than every arc regardless of how well-connected either node is.
// Degree still adds variation within a type's band via sizeForNode.
export const TYPE_SIZE_BAND: Record<NodeType, { min: number; max: number }> = {
  realm: { min: 17, max: 22 },
  arc: { min: 13, max: 16.5 },
  person: { min: 10, max: 12.5 },
  entity: { min: 7.5, max: 9.5 },
  session: { min: 5.5, max: 7 },
  item: { min: 3, max: 5 },
  // Appended, continuing the shrinking-band trend, rather than inserted at
  // a considered rank: see the visual-weight order comment near the top of
  // this file.
  commitment: { min: 2, max: 3.5 },
}

// The legend swatch beside each filter checkbox mirrors that same band, so
// the legend reads as an accurate key rather than a decoration: mapped
// linearly from the smallest type's band ceiling to the largest's, then
// clamped into a legend-appropriate pixel range.
const LEGEND_SWATCH_MIN_PX = 6
const LEGEND_SWATCH_MAX_PX = 16
const BAND_MAXES = Object.values(TYPE_SIZE_BAND).map((band) => band.max)
const BAND_MAX_LOW = Math.min(...BAND_MAXES)
const BAND_MAX_HIGH = Math.max(...BAND_MAXES)

function legendSwatchSize(type: NodeType): number {
  const band = TYPE_SIZE_BAND[type]
  const ratio =
    BAND_MAX_HIGH === BAND_MAX_LOW ? 1 : (band.max - BAND_MAX_LOW) / (BAND_MAX_HIGH - BAND_MAX_LOW)
  return LEGEND_SWATCH_MIN_PX + (LEGEND_SWATCH_MAX_PX - LEGEND_SWATCH_MIN_PX) * ratio
}

// The legend swatch's border mirrors the canvas ring's ordering and
// proportionality (thicker for the stronger types, same TYPE_BORDER_WIDTH
// fractions), not its exact pixel geometry: @sigma/node-border's "relative"
// size mode carves the ring from a WebGL vertex radius computed through a
// correction ratio this module has no reason to reproduce. This is a
// fraction of the legend swatch's own pixel size, not of a node's on-canvas
// radius, so the two are never claimed to match pixel-for-pixel.
export function legendBorderWidth(type: NodeType): number {
  return TYPE_BORDER_WIDTH[type] * legendSwatchSize(type)
}

// The size (in the same units as TYPE_SIZE_BAND) below which a node's label
// is not drawn at the default camera view. Exactly midway between person's
// band ceiling (12.5) and arc's band floor (13), so at rest every person and
// entity node is unlabelled and every arc and realm node is labelled,
// regardless of degree. See the settings comment further down for why this
// boundary is an exact one rather than an estimate, and atlas.test.tsx for
// the unit test that ties this constant back to TYPE_SIZE_BAND.
export const LABEL_RENDERED_SIZE_THRESHOLD = 12.75

const LABEL_MAX_LENGTH = 32

function truncateLabel(label: string): string {
  return label.length > LABEL_MAX_LENGTH ? `${label.slice(0, LABEL_MAX_LENGTH - 1)}…` : label
}

// The subset of sigma's NodeDisplayData and Settings that drawThemedNodeHover
// actually reads, typed loosely on purpose (matching this file's existing
// nodeReducer/edgeReducer style) rather than importing sigma's own
// NodeHoverDrawingFunction/Settings generics: this is a themed colour
// parametrisation of stock sigma code, not new rendering logic, so it only
// needs to promise it reads what drawDiscNodeHover itself reads.
interface HoverLabelData {
  x: number
  y: number
  size: number
  // Not read by drawThemedNodeHover itself, but required so this type stays
  // structurally assignable to sigma's own NodeDisplayData: it is what
  // `settings.defaultDrawNodeLabel` (sigma's real label renderer, called at
  // the end of drawThemedNodeHover) actually expects its `data` argument to
  // carry, and TypeScript's exactOptionalPropertyTypes checks that all the
  // way through this file's `defaultDrawNodeHover` setting, not just this
  // function's own body.
  color: string
  label: string | null
}

interface HoverLabelSettings {
  labelSize: number
  labelFont: string
  labelWeight: string
  // Loosely typed (settings: unknown), not sigma's own Settings<...>, and
  // cast into rather than structurally matched at this function's one call
  // site (in the Atlas component's sigma-construction effect): sigma's real
  // Settings type is 50-odd properties wide, and asking TypeScript to prove
  // a small local interface is bidirectionally compatible with it (once
  // through NodeHoverDrawingFunction's contravariant parameter check, once
  // through this field calling back into it) fights the type checker for no
  // real safety gain over the cast, since this is a straight pass-through:
  // sigma is handed back the exact `settings` object it gave this function
  // in the first place, unexamined.
  defaultDrawNodeLabel: (
    context: CanvasRenderingContext2D,
    data: HoverLabelData,
    settings: unknown,
  ) => void
}

// A mechanical port of sigma 3.0.3's own drawDiscNodeHover (installed at
// node_modules/sigma/dist/index-fad77a13.esm.js), parametrised on the pill's
// fill colour instead of the stock hardcoded "#FFF". See the
// defaultDrawNodeHover comment at its call site (in the Atlas component's
// sigma-construction effect) for why this exists: the stock function's
// white pill is right on light paper (identical to --panel-raised there)
// and wrong on dark paper, and now that this app also themes labelColor,
// shipping the label fix without this one would make dark-mode hover
// text LESS readable than before, not more. Every measurement below
// (padding, box radius, the flag-shaped path wrapping the node) is copied
// from the installed source as-is; only `context.fillStyle` and the final
// label draw (calling the passed-in settings.defaultDrawNodeLabel, rather
// than importing sigma's own unexported drawDiscNodeLabel) differ from it.
function drawThemedNodeHover(
  context: CanvasRenderingContext2D,
  data: HoverLabelData,
  settings: HoverLabelSettings,
  fill: string,
): void {
  const size = settings.labelSize
  const font = settings.labelFont
  const weight = settings.labelWeight
  context.font = `${weight} ${size}px ${font}`
  context.fillStyle = fill
  context.shadowOffsetX = 0
  context.shadowOffsetY = 0
  context.shadowBlur = 8
  context.shadowColor = '#000'
  const PADDING = 2
  if (typeof data.label === 'string') {
    const textWidth = context.measureText(data.label).width
    const boxWidth = Math.round(textWidth + 5)
    const boxHeight = Math.round(size + 2 * PADDING)
    const radius = Math.max(data.size, size / 2) + PADDING
    const angleRadian = Math.asin(boxHeight / 2 / radius)
    const xDeltaCoord = Math.sqrt(Math.abs(radius ** 2 - (boxHeight / 2) ** 2))
    context.beginPath()
    context.moveTo(data.x + xDeltaCoord, data.y + boxHeight / 2)
    context.lineTo(data.x + radius + boxWidth, data.y + boxHeight / 2)
    context.lineTo(data.x + radius + boxWidth, data.y - boxHeight / 2)
    context.lineTo(data.x + xDeltaCoord, data.y - boxHeight / 2)
    context.arc(data.x, data.y, radius, angleRadian, -angleRadian)
    context.closePath()
    context.fill()
  } else {
    context.beginPath()
    context.arc(data.x, data.y, data.size + PADDING, 0, Math.PI * 2)
    context.closePath()
    context.fill()
  }
  context.shadowOffsetX = 0
  context.shadowOffsetY = 0
  context.shadowBlur = 0
  settings.defaultDrawNodeLabel(context, data, settings)
}

function computeDegrees(snapshot: GraphSnapshot): Map<string, number> {
  const degrees = new Map<string, number>()
  for (const node of snapshot.nodes) degrees.set(node.id, 0)
  for (const edge of snapshot.edges) {
    degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1)
    degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1)
  }
  return degrees
}

function sizeForNode(type: NodeType, degree: number, maxDegree: number): number {
  const band = TYPE_SIZE_BAND[type]
  if (maxDegree <= 0) return band.min
  const scaled = Math.sqrt(degree / maxDegree)
  return band.min + (band.max - band.min) * scaled
}

// The node "type" every node in this view uses, dispatching sigma to the
// bordered program built in the Atlas component below rather than its
// built-in plain circle. Set both as the per-node graph attribute
// (buildAtlasModel) and as defaultNodeType in the sigma settings (belt and
// suspenders: if either wiring is ever dropped on its own, the other still
// routes every node to the ring program instead of silently falling back to
// an unbordered circle).
const BORDERED_NODE_TYPE = 'bordered'

export interface AtlasModel {
  graph: Graph
  semanticNodes: GraphNode[]
}

// Pure and independent of any layout maths: `positions` is supplied by the
// caller (the Atlas component wires it from ./graph/layout.js), so building
// the render graph for a given filter never re-runs ForceAtlas2 and stays
// trivially testable without it. A node missing from `positions` (should not
// happen once a real layout has run, but defends against an incomplete
// stub) falls back to the origin rather than throwing.
//
// `dark` defaults to a live read of the media query (as every other ground-
// dependent function in this module does) but the Atlas component below
// passes its own `dark` state explicitly instead of relying on the default:
// that state is kept in sync with a live prefers-color-scheme change
// listener, so a mid-session theme flip rebuilds this model with the new
// ramp instead of the build silently re-reading a preference that already
// changed underneath it.
export function buildAtlasModel(
  snapshot: GraphSnapshot,
  enabled: ReadonlySet<NodeType>,
  positions: Positions,
  dark: boolean = prefersDarkGround(),
): AtlasModel {
  const degrees = computeDegrees(snapshot)
  const maxDegree = Math.max(0, ...degrees.values())

  const semanticNodes = snapshot.nodes
    .filter((node) => enabled.has(node.type))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
  const ids = new Set(semanticNodes.map((node) => node.id))

  const graph = new Graph()
  for (const node of semanticNodes) {
    const point = positions[node.id] ?? { x: 0, y: 0 }
    graph.addNode(node.id, {
      label: node.label,
      x: point.x,
      y: point.y,
      size: sizeForNode(node.type, degrees.get(node.id) ?? 0, maxDegree),
      color: colorForType(node.type, dark),
      type: BORDERED_NODE_TYPE,
      borderColor: borderColorForType(node.type, dark),
      borderWidth: TYPE_BORDER_WIDTH[node.type],
    })
  }
  for (const edge of snapshot.edges) {
    if (ids.has(edge.from) && ids.has(edge.to)) {
      graph.addEdgeWithKey(edge.key, edge.from, edge.to, {
        size: edgeSize(edge.confidence),
        color: edgeColor(edge.confirmed, dark),
      })
    }
  }
  return { graph, semanticNodes }
}

// Builds the full, unfiltered graph handed to ./graph/layout.js: every node
// and edge in the snapshot regardless of the active type filter, so a
// node's position never depends on which types happen to be visible and
// never reshuffles when a filter is toggled. Carries the same `size`
// attribute buildAtlasModel assigns (noverlap, the last stage of the layout
// pipeline, reads a node's `size` to decide how much room it needs), so
// collision removal respects the same visual radii the canvas actually
// draws, not a uniform default.
function buildLayoutGraph(snapshot: GraphSnapshot): Graph {
  const degrees = computeDegrees(snapshot)
  const maxDegree = Math.max(0, ...degrees.values())
  const graph = new Graph()
  for (const node of snapshot.nodes) {
    graph.addNode(node.id, {
      size: sizeForNode(node.type, degrees.get(node.id) ?? 0, maxDegree),
    })
  }
  for (const edge of snapshot.edges) {
    if (
      graph.hasNode(edge.from) &&
      graph.hasNode(edge.to) &&
      edge.from !== edge.to &&
      !graph.hasEdge(edge.from, edge.to)
    ) {
      graph.addEdge(edge.from, edge.to)
    }
  }
  return graph
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

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

type DocumentState =
  | { status: 'idle' }
  | { status: 'loading'; docId: string }
  | { status: 'error'; docId: string }
  | { status: 'loaded'; docId: string; document: Document }

function AtlasDetail({
  node,
  edges,
  docState,
}: {
  node: GraphNode
  edges: GraphEdge[]
  docState: DocumentState
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
      {docId !== undefined && docState.status === 'loading' && (
        <p className="atlas-document-status">Loading the document.</p>
      )}
      {docId !== undefined && docState.status === 'error' && (
        <p className="atlas-document-status">The document could not load.</p>
      )}
      {docId !== undefined && docState.status === 'loaded' && (
        <article className="atlas-document" aria-label={docState.document.title}>
          <h3>{docState.document.title}</h3>
          <div className="atlas-document-body">{docState.document.body}</div>
        </article>
      )}
    </div>
  )
}

export function Atlas({
  snapshot,
  api,
}: {
  snapshot: GraphSnapshot
  api?: Pick<AppApi, 'getDocument'>
}) {
  const [enabled, setEnabled] = useState<Set<NodeType>>(() => new Set(DEFAULT_ENABLED))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [docState, setDocState] = useState<DocumentState>({ status: 'idle' })
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<Sigma | null>(null)
  // The layout's own persisted positions: seeded from the last computeLayout
  // call, then updated (and re-saved) directly on every node drag, so a
  // dragged node stays where the user put it without waiting for the next
  // full layout pass.
  const positionsRef = useRef<Positions>({})

  // Live theme state, not just a one-time matchMedia read: colorForType,
  // borderColorForType, and buildAtlasModel all default to reading the
  // media query fresh on every call, so nothing here needs to cache a
  // colour ramp, only the boolean that says which ramp is live. Subscribing
  // to the query's own 'change' event (guarded the same way
  // prefersDarkGround guards its initial read) is what turns "the ramp was
  // picked once per rebuild" into "the ramp is re-picked when the OS theme
  // actually changes": a mid-session light/dark flip now updates `dark`,
  // which both deps below (`model`, and the renderer-construction effect)
  // react to, instead of leaving already-drawn fills on a stale ramp until
  // some unrelated rebuild (a filter toggle or a new snapshot) happened to
  // come along and re-read the preference. The renderer-construction effect
  // rebuilding on a theme flip is a real, accepted cost, not a free win: it
  // tears the whole Sigma instance down and recreates it (the same thing a
  // new snapshot.revision already does), so a theme flip resets camera
  // zoom/pan and drops any drag position not yet folded into
  // layoutResult.positions. That trade is judged worth it here: a stale
  // colour ramp is a correctness bug, a reset camera on a rare, deliberate
  // user action (flipping the OS theme) is not.
  const [dark, setDark] = useState<boolean>(() => prefersDarkGround())

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (event: MediaQueryListEvent) => setDark(event.matches)
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [])

  // Layout is computed once per snapshot, independent of the type filter:
  // ForceAtlas2 and noverlap both run here, on the full unfiltered graph, so
  // toggling a filter only changes which already-placed nodes get drawn
  // rather than triggering a re-simulation. loadPositions() seeds known
  // (including previously dragged) positions back in.
  const layoutResult = useMemo(
    () => computeLayout(buildLayoutGraph(snapshot), loadPositions()),
    [snapshot],
  )

  useEffect(() => {
    positionsRef.current = layoutResult.positions
    savePositions(layoutResult.positions)
  }, [layoutResult])

  const model = useMemo(
    () => buildAtlasModel(snapshot, enabled, layoutResult.positions, dark),
    [snapshot, enabled, layoutResult, dark],
  )
  const modelRef = useRef(model)
  modelRef.current = model

  const typeCounts = useMemo(() => {
    const counts = new Map<NodeType, number>()
    for (const type of NODE_TYPES) counts.set(type, 0)
    for (const node of snapshot.nodes) counts.set(node.type, (counts.get(node.type) ?? 0) + 1)
    return counts
  }, [snapshot])

  const visibleNodes = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (query === '') return model.semanticNodes
    return model.semanticNodes.filter((node) => node.label.toLowerCase().includes(query))
  }, [model, search])

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

  // Construct the Sigma renderer once per snapshot (or on a live theme
  // flip, see the `dark` state above) and keep it alive across filter
  // toggles: the effect below swaps the underlying graph in place instead
  // of destroying and rebuilding the renderer.
  useEffect(() => {
    // Keying this effect to the snapshot revision and the live theme (and
    // nothing else) is what keeps the renderer alive across filter toggles
    // while still rebuilding on a real light/dark flip: snapshot.revision is
    // read here only to make that dependency explicit to the linter, and
    // `dark` (component state, not a fresh prefersDarkGround() read) is what
    // every colour literal in this effect's settings closes over below.
    void snapshot.revision
    const container = containerRef.current
    if (!container || !webglAvailable()) return

    const reducedMotion = prefersReducedMotion()
    // Mutable, not React state: hover fires far more often than a re-render
    // should, so the hovered node lives in a plain variable the reducers
    // close over, and a hover change asks sigma to re-run those reducers
    // directly (renderer.refresh()) instead of going through React.
    let hoveredNode: string | null = null

    // The node-border ring's size/colour attributes and everything below are
    // independent of the node-program registration itself, so this base
    // settings object is built eagerly; `nodeProgramClasses` is spread in
    // once @sigma/node-border has actually loaded (see the dynamic import
    // below), since importing it eagerly at module scope pulls in
    // sigma/rendering, which throws under jsdom (no WebGL2RenderingContext)
    // before webglAvailable() ever gets a chance to bail out.
    const baseSettings = {
      ...(reducedMotion ? { zoomDuration: 0, doubleClickZoomingDuration: 0 } : {}),
      // Gives every node a ring instead of the plain circle sigma draws by
      // default: BORDERED_NODE_TYPE is both the default node type and the
      // explicit per-node `type` attribute set in buildAtlasModel.
      defaultNodeType: BORDERED_NODE_TYPE,
      // Sigma's own default (sigma/settings/dist/sigma-settings.esm.js) is
      // `labelColor: { color: "#000" }`, unconditionally: this app never
      // overrode it before now, so every node label has always been rendered
      // in plain black regardless of theme. That was invisible in practice
      // on light paper (black ink is this app's own --ink token, near
      // enough) but on dark paper it is black text on --panel's near-black
      // #1b1915, roughly 1.1:1 contrast: unreadable. Pointing this at the
      // themed ink colour (falling back to the same literals readCSSVar
      // falls back to everywhere else in this module) fixes rest-state
      // labels in dark mode. See defaultDrawNodeHover just below for why
      // this one setting cannot ship alone.
      labelColor: { color: readCSSVar('--ink', dark, dark ? '#edeae2' : '#191713') },
      // Sigma's stock hover renderer (drawDiscNodeHover, same settings file
      // as above) hardcodes `context.fillStyle = "#FFF"` for the pill drawn
      // behind a hovered node's label, then calls the (now themed, see
      // labelColor above) label renderer on top of it. On light paper that
      // pill is indistinguishable from --panel-raised (#ffffff): no visible
      // change. On dark paper it stays a full-brightness white flag no
      // matter the theme, and once labelColor points ink at the DARK ramp's
      // light-on-dark ink colour, hovering a node in dark mode would draw
      // light text on that still-white pill: lower contrast than the
      // original bug, not a fix. drawThemedNodeHover below is a mechanical
      // port of sigma 3.0.3's drawDiscNodeHover (installed at
      // sigma/dist/index-fad77a13.esm.js), parametrised on fill colour only;
      // every measurement (padding, box radius, the flag-shaped path
      // wrapping the node) is copied as-is, not reimplemented.
      defaultDrawNodeHover: (
        context: CanvasRenderingContext2D,
        // Loosely typed, matching this file's existing nodeReducer/
        // edgeReducer convention just below (Record<string, unknown> in,
        // cast at the point drawThemedNodeHover actually reads the fields
        // it needs), rather than sigma's own PartialButFor<NodeDisplayData,
        // ...>/Settings<...> types: see the HoverLabelSettings comment above
        // for why matching those precisely fights the type checker for no
        // real safety gain here.
        data: Record<string, unknown>,
        hoverSettings: unknown,
      ) =>
        drawThemedNodeHover(
          context,
          data as unknown as HoverLabelData,
          hoverSettings as HoverLabelSettings,
          readCSSVar('--panel-raised', dark, dark ? '#201e19' : '#ffffff'),
        ),
      // Label collision control.
      //
      // What actually causes two nearby nodes' labels to overprint: read
      // from sigma 3.0.3's own source (dist/sigma.esm.js), not guessed.
      // LabelGrid buckets every labelled node into a fixed pixel grid
      // (cell = labelGridCellSize) computed ONCE per Sigma#process() call,
      // using a "null camera" projection fit to the container and the
      // graph's own bounding box (i.e. the reset/default view), not the
      // live camera; a hover-triggered renderer.refresh() rebuilds it but
      // lands on the same buckets because the underlying node coordinates
      // and container size have not changed. Each cell independently keeps
      // its Math.ceil(density / ratio^2) largest nodes by size
      // (LabelGrid#getLabelsToDisplay), and because Math.ceil of any
      // positive number is at least 1, every non-empty cell shows at least
      // one label no matter how low labelDensity goes: density only ever
      // matters when the camera is zoomed out past ratio 1. Crucially,
      // cell membership is decided purely by which pixel bucket a node's
      // centre falls in; label pixel WIDTH plays no part, and a cell's
      // top-1 pick has no visibility into its neighbouring cell's own
      // top-1 pick. Two nodes can each be the lone survivor in their own
      // cell and still print on top of each other if they are close enough
      // in world space to straddle a cell boundary. That is what was
      // happening to "Priya (mother)" and "Arjun (brother)": both are
      // `person` nodes sitting near each other, in adjacent grid cells,
      // each the only label its cell keeps. Growing labelGridCellSize
      // further was rejected as the fix: it can merge one adjacent pair
      // into a shared cell, but nothing about a fixed grid guarantees that
      // for an arbitrary pair whose real screen position depends on the
      // user's private memory data (which this codebase never has access
      // to at dev time, and jsdom cannot render to check anyway): picking
      // a bigger number and hoping is exactly the "guessing" this fix was
      // asked to avoid. labelDensity and labelGridCellSize are therefore
      // left at their prior tuned values (0.8, 160) below; changing them
      // would not have addressed the root cause and could not be verified.
      //
      // The actual fix: labelRenderedSizeThreshold (LABEL_RENDERED_SIZE_
      // THRESHOLD, 12.75) removes `person` and `entity` from default-zoom
      // labelling entirely, as a type, rather than trying to keep any two
      // specific same-tier nodes apart. This is an exact boundary, not an
      // approximation: Sigma compares this threshold directly against
      // `this.scaleSize(data.size)` (sigma.esm.js, just before the
      // `size < labelRenderedSizeThreshold` check), and
      // scaleSize(size) = size / zoomToSizeRatioFunction(camera.ratio) *
      // (itemSizesReference === 'positions' ? ... : 1). This app never sets
      // itemSizesReference, so it stays at its documented default, 'screen'
      // (sigma/settings/dist/sigma-settings.esm.js), which makes the second
      // factor exactly 1. Camera's own default state, and what
      // animatedReset returns to, is ratio: 1 (both confirmed in
      // sigma.esm.js). So at the app's initial, unzoomed view,
      // scaleSize(size) === size, and labelRenderedSizeThreshold compares
      // directly against the raw TYPE_SIZE_BAND numbers with no unknown
      // scaling constant in between. 12.75 sits strictly between person's
      // band ceiling (12.5) and arc's band floor (13); see the unit test
      // tying LABEL_RENDERED_SIZE_THRESHOLD to TYPE_SIZE_BAND in
      // atlas.test.tsx: at rest, every person and every entity (band
      // ceiling 9.5, already below the old threshold too) goes unlabelled
      // regardless of degree, while every arc and realm stays labelled
      // regardless of degree. Sessions and items remain excluded exactly as
      // before. None of this is "the two colliding nodes are hidden"; it is
      // "that whole tier is hover/zoom-revealed instead of shown at rest",
      // which is the fallback this task's own instructions sanctioned when
      // the grid alone cannot be proven to fix an arbitrary pair.
      //
      // Nothing is permanently hidden: zooming in still reveals person and
      // entity labels once scaleSize grows past 12.75 (unbounded growth
      // with zoom, same mechanism as before), and hovering a node now force-
      // shows its own label immediately regardless of size, via the
      // nodeReducer's forceLabel branch below (confirmed against source:
      // renderer.refresh() with no options takes the fullRefresh path,
      // which re-runs every node through nodeReducer and rebuilds
      // nodesWithForcedLabels; renderLabels() unions labelsToDisplay with
      // nodesWithForcedLabels and its `size < labelRenderedSizeThreshold`
      // check is itself skipped whenever `data.forceLabel` is true).
      //
      // None of the above runs under jsdom (no WebGL, so LabelGrid,
      // renderLabels, and hover events never execute in this test suite);
      // it is verified by reading sigma 3.0.3's source end to end, not by a
      // rendered assertion. Every setting name here (renderLabels,
      // labelDensity, labelGridCellSize, labelRenderedSizeThreshold,
      // nodeReducer, edgeReducer, nodeProgramClasses, defaultNodeType) was
      // confirmed against the installed sigma 3.0.3 declaration file
      // (settings.d.ts), not assumed.
      renderLabels: true,
      labelDensity: 0.8,
      labelGridCellSize: 160,
      labelRenderedSizeThreshold: LABEL_RENDERED_SIZE_THRESHOLD,
      nodeReducer: (node: string, data: Record<string, unknown>): Partial<NodeDisplayData> => {
        const rawLabel = typeof data.label === 'string' ? data.label : null
        const result = {
          ...data,
          label: rawLabel === null ? null : truncateLabel(rawLabel),
        } as Partial<NodeDisplayData>
        if (node === hoveredNode) {
          // Bypasses labelRenderedSizeThreshold for this one node (see
          // `!data.forceLabel && size < threshold` in sigma.esm.js's
          // renderLabels): a person or entity node has no label at rest
          // under the new threshold, but hovering it still surfaces the
          // label immediately, which is the "revealed on hover" half of the
          // label-collision fix above.
          result.forceLabel = true
        } else if (hoveredNode !== null) {
          const graph = modelRef.current.graph
          const isNeighbor =
            graph.hasNode(hoveredNode) &&
            graph.hasNode(node) &&
            graph.areNeighbors(node, hoveredNode)
          if (!isNeighbor) {
            result.color = dimColor(dark)
            result.label = null
          }
        }
        return result
      },
      edgeReducer: (edge: string, data: Record<string, unknown>): Partial<EdgeDisplayData> => {
        const result = { ...data } as Partial<EdgeDisplayData>
        if (hoveredNode !== null) {
          const graph = modelRef.current.graph
          const touchesHovered =
            graph.hasEdge(edge) &&
            (graph.source(edge) === hoveredNode || graph.target(edge) === hoveredNode)
          // Touching edges jump to full realm strength instead of keeping
          // their quiet resting edgeColor(); everything else dims exactly
          // as before. Without this branch the "quieter" edges from Problem
          // 1 would have made hover emphasis harder to see, not easier: the
          // resting and dimmed colours would have sat closer together.
          result.color = touchesHovered ? edgeEmphasisColor(dark) : dimColor(dark)
        }
        return result
      },
    }

    let cancelled = false
    let resizeObserver: ResizeObserver | undefined

    // Both packages are imported dynamically, and only together, so neither
    // one's module-level side effects run under jsdom: @sigma/node-border
    // re-exports from sigma/rendering, so a static top-level import of
    // either package (this one used to import sigma statically for its
    // types only, which is fine; but a value import of @sigma/node-border
    // is not) throws before webglAvailable() is ever consulted.
    void Promise.all([import('sigma'), import('@sigma/node-border')]).then(
      ([{ default: SigmaClass }, { createNodeBorderProgram }]) => {
        if (cancelled) return
        try {
          // @sigma/node-border's default two-layer shape (an outer ring,
          // then a fill) already matches what this view needs; only the
          // ring's size is made per-node instead of the package's fixed
          // default so each type's ring can carry its own thickness
          // (TYPE_BORDER_WIDTH). "relative" mode sizes the ring as a
          // fraction of the node's own radius, so a realm's ring and an
          // item's ring read as the same relative weight even though the
          // nodes themselves are drawn at very different sizes.
          const BorderedNodeProgram = createNodeBorderProgram({
            borders: [
              {
                size: { attribute: 'borderWidth', defaultValue: 0.12, mode: 'relative' },
                color: { attribute: 'borderColor' },
              },
              { size: { fill: true }, color: { attribute: 'color' } },
            ],
          })
          const settings = {
            ...baseSettings,
            nodeProgramClasses: { [BORDERED_NODE_TYPE]: BorderedNodeProgram },
          }
          const renderer = new SigmaClass(modelRef.current.graph, container, settings)
          renderer.on('clickNode', ({ node }) => setSelectedId(node))
          renderer.on('clickStage', () => setSelectedId(null))

          // Hover emphasis: dim everything but the hovered node and its
          // direct neighbours. Not exercised under jsdom (no WebGL, so
          // enterNode/leaveNode never fire in the test suite); the reducers
          // above are the actual logic under test-by-reading only.
          renderer.on('enterNode', ({ node }) => {
            hoveredNode = node
            renderer.refresh()
          })
          renderer.on('leaveNode', () => {
            hoveredNode = null
            renderer.refresh()
          })

          // Node dragging: the documented sigma pattern (downNode on the
          // renderer; mousemovebody, mouseup, mousedown on the mouse captor).
          // setCustomBBox freezes the camera's auto-fit for the drag's
          // duration so a node moving past the original bounding box does not
          // itself trigger a re-fit mid-drag, and preventSigmaDefault plus
          // stopPropagation on the body move stop sigma's default behaviour
          // for that event, which is panning the camera as if the stage
          // itself were being dragged. None of this runs under jsdom (no
          // WebGL, so the renderer this all hangs off of never exists in the
          // test suite); it is written directly against the sigma 3.0.3
          // declaration files, not guessed.
          let draggedNode: string | null = null
          renderer.on('downNode', ({ node }) => {
            draggedNode = node
            modelRef.current.graph.setNodeAttribute(node, 'highlighted', true)
            if (!renderer.getCustomBBox()) renderer.setCustomBBox(renderer.getBBox())
          })

          const mouseCaptor = renderer.getMouseCaptor()
          mouseCaptor.on('mousemovebody', (event) => {
            if (draggedNode === null) return
            const position = renderer.viewportToGraph(event)
            modelRef.current.graph.setNodeAttribute(draggedNode, 'x', position.x)
            modelRef.current.graph.setNodeAttribute(draggedNode, 'y', position.y)
            event.preventSigmaDefault()
            event.original.preventDefault()
            event.original.stopPropagation()
          })
          mouseCaptor.on('mouseup', () => {
            if (draggedNode !== null) {
              modelRef.current.graph.removeNodeAttribute(draggedNode, 'highlighted')
              const { x, y } = modelRef.current.graph.getNodeAttributes(draggedNode)
              positionsRef.current = { ...positionsRef.current, [draggedNode]: { x, y } }
              savePositions(positionsRef.current)
            }
            draggedNode = null
          })
          mouseCaptor.on('mousedown', () => {
            if (!renderer.getCustomBBox()) renderer.setCustomBBox(renderer.getBBox())
          })

          rendererRef.current = renderer

          // Sigma auto-fits and auto-centres the graph's bounding box into the
          // container at construction time (autoRescale/autoCenter, both on
          // by default), but it only re-measures the container on the
          // browser's own `resize` event, not on container/layout resizes
          // such as a CSS grid still settling its own sizing pass right after
          // mount. Force one re-measure now in case the container's real size
          // was still settling when the renderer was built, and keep
          // re-measuring on every later container resize, so the graph stays
          // fitted to whatever space the shell actually gives it instead of
          // crowding into a stale, smaller measurement.
          //
          // Reasoned from the Sigma source (resize() re-reads
          // container.offsetWidth/Height and emits "resize"; refresh() is what
          // re-runs the autoRescale/autoCenter fit against that new size), not
          // verified by a test: jsdom has no WebGL, so this branch never runs
          // under the test suite. Confirming it holds in the real browser is
          // still a manual check.
          renderer.resize(true)
          renderer.refresh()
          if (typeof ResizeObserver === 'function') {
            resizeObserver = new ResizeObserver(() => {
              renderer.resize()
              renderer.refresh()
            })
            resizeObserver.observe(container)
          }
        } catch {
          // Sigma needs WebGL and a real canvas. The semantic list and detail panel still work.
        }
      },
    )

    return () => {
      cancelled = true
      resizeObserver?.disconnect()
      rendererRef.current?.kill()
      rendererRef.current = null
    }
  }, [snapshot.revision, dark])

  useEffect(() => {
    rendererRef.current?.setGraph(model.graph)
  }, [model])

  useEffect(() => {
    if (selectedNode?.docId === undefined || !api) {
      setDocState({ status: 'idle' })
      return
    }
    const docId = selectedNode.docId
    let cancelled = false
    setDocState({ status: 'loading', docId })
    api
      .getDocument(docId)
      .then((document) => {
        if (!cancelled) setDocState({ status: 'loaded', docId, document })
      })
      .catch(() => {
        if (!cancelled) setDocState({ status: 'error', docId })
      })
    return () => {
      cancelled = true
    }
  }, [selectedNode, api])

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

  // Explicit, visible, keyboard-reachable pan/zoom controls, on top of
  // sigma's own default wheel-zoom and drag-to-pan. A missing renderer
  // (WebGL unavailable, or the async sigma import has not resolved yet) is a
  // deliberate no-op rather than a throw.
  function zoomIn() {
    rendererRef.current?.getCamera().animatedZoom({ duration: prefersReducedMotion() ? 0 : 300 })
  }
  function zoomOut() {
    rendererRef.current?.getCamera().animatedUnzoom({ duration: prefersReducedMotion() ? 0 : 300 })
  }
  function resetView() {
    rendererRef.current?.getCamera().animatedReset({ duration: prefersReducedMotion() ? 0 : 300 })
  }

  if (snapshot.nodes.length === 0) {
    return (
      <section className="atlas atlas-empty-state" aria-label="Atlas">
        <p className="atlas-empty">No graph records yet.</p>
      </section>
    )
  }

  return (
    <section className="atlas" aria-label="Atlas">
      <div className="atlas-canvas-cell">
        <div className="atlas-canvas" ref={containerRef} />
        <fieldset className="atlas-controls">
          <legend>Map view controls</legend>
          <button type="button" onClick={zoomIn} aria-label="Zoom in">
            +
          </button>
          <button type="button" onClick={zoomOut} aria-label="Zoom out">
            −
          </button>
          <button type="button" onClick={resetView} aria-label="Reset view">
            Reset
          </button>
        </fieldset>
      </div>
      <div className="atlas-sidebar">
        <div className="atlas-search">
          <label htmlFor="atlas-search-input">Search nodes</label>
          <input
            id="atlas-search-input"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by label"
          />
        </div>
        <fieldset className="atlas-filter">
          <legend>Node types</legend>
          {NODE_TYPES.map((type) => (
            <label key={type}>
              <span
                className="atlas-filter-swatch"
                style={{
                  background: colorForType(type),
                  borderStyle: 'solid',
                  borderColor: borderColorForType(type),
                  borderWidth: `${legendBorderWidth(type)}px`,
                  width: `${legendSwatchSize(type)}px`,
                  height: `${legendSwatchSize(type)}px`,
                }}
                aria-hidden="true"
              />
              <input
                type="checkbox"
                checked={enabled.has(type)}
                onChange={() => toggleType(type)}
              />
              {PLURAL[type]} <span className="atlas-filter-count">{typeCounts.get(type) ?? 0}</span>
            </label>
          ))}
        </fieldset>
        <ul className="atlas-node-list" aria-label="Atlas nodes">
          {visibleNodes.map((node) => (
            <li key={node.id}>
              <button type="button" onClick={() => selectNode(node)} title={node.label}>
                {node.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <aside className="atlas-detail" aria-live="polite">
        {selectedNode !== undefined ? (
          <AtlasDetail node={selectedNode} edges={selectedEdges} docState={docState} />
        ) : (
          <p className="atlas-detail-hint">Select a node to see its details.</p>
        )}
      </aside>
    </section>
  )
}

export function AtlasView({ api }: { api: AppApi }) {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error' } | { status: 'loaded'; snapshot: GraphSnapshot }
  >({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    api
      .getGraphSnapshot()
      .then((snapshot) => {
        if (!cancelled) setState({ status: 'loaded', snapshot })
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [api])

  if (state.status === 'loading') return <p className="atlas-status">Loading the atlas.</p>
  if (state.status === 'error') {
    return (
      <p className="atlas-status atlas-status-error" role="alert">
        The atlas could not load.
      </p>
    )
  }
  return <Atlas snapshot={state.snapshot} api={api} />
}
