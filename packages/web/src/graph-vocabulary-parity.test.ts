// graphNodeSchema/graphEdgeSchema in api.ts hand copy the node and edge
// type vocabulary from NodeType/EdgeType in packages/memory/src/graph.ts.
// web never imports a runtime engine package at runtime (server -> core ->
// memory -> providers is the only permitted path there; web talks to
// server over HTTP only), and api.ts's own comment explains why that
// boundary is read to forbid a test-only import too: @openreverie/memory
// is not even a devDependency of this package, and this suite should stay
// buildable and runnable without the engine installed.
//
// Because this file cannot import the real NodeType/EdgeType to compare
// against, EXPECTED_NODE_TYPES and EXPECTED_EDGE_TYPES below are a second,
// hand written mirror, current as of the same commit that fixed the bug
// this guards: a stale copy of these two lists in api.ts used to make the
// Atlas fail closed (parse error) the moment a user's graph contained a
// commitment node or a waits_on edge, because the server's response no
// longer matched what the browser expected to see.
//
// This test cannot detect memory's NodeType/EdgeType changing on their
// own; it only catches api.ts's list drifting from what is written here.
// Whoever adds a member to NodeType/EdgeType in graph.ts must update
// api.ts's arrays AND the two lists below by hand, in the same change.
import { describe, expect, it } from 'vitest'
import { graphEdgeSchema, graphNodeSchema } from './api.js'

// Mirrors NodeType in packages/memory/src/graph.ts.
const EXPECTED_NODE_TYPES = ['realm', 'arc', 'item', 'session', 'person', 'entity', 'commitment']

// Mirrors EdgeType in packages/memory/src/graph.ts.
const EXPECTED_EDGE_TYPES = ['part_of', 'in', 'from', 'involves', 'relates_to', 'waits_on']

describe('web graph type schemas match the hand mirrored memory vocabulary', () => {
  it('graphNodeSchema accepts exactly the hardcoded expected node types', () => {
    const actual = [...graphNodeSchema.shape.type.options].sort()
    expect(actual).toEqual([...EXPECTED_NODE_TYPES].sort())
  })

  it('graphEdgeSchema accepts exactly the hardcoded expected edge types', () => {
    const actual = [...graphEdgeSchema.shape.type.options].sort()
    expect(actual).toEqual([...EXPECTED_EDGE_TYPES].sort())
  })
})
