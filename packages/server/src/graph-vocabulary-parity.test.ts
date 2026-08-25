// The public graph schemas in app.ts (graphNodeTypeSchema, graphEdgeTypeSchema)
// used to be a hand written literal list that copied @openreverie/memory's
// NodeType/EdgeType. That copy fell out of sync the moment 'commitment' and
// 'waits_on' were added to memory: every /api/graph/snapshot and
// /api/graph/events request for a user with a single commitment then 500ed,
// because writePublicJson validates the server's own outbound response
// against a schema that rejected the very data it was asked to serve.
//
// app.ts now builds graphNodeTypeSchema/graphEdgeTypeSchema directly from
// NODE_TYPES/EDGE_TYPES imported from @openreverie/memory, so there is no
// separate list left to fall out of sync. This test is a regression lock:
// if a future edit reverts app.ts to a hand written literal (for example,
// "for clarity" or during a refactor), this is what catches the drift, since
// nothing else in the server suite compares the schema against the real
// source of truth.
import { EDGE_TYPES, NODE_TYPES } from '@openreverie/memory'
import { describe, expect, it } from 'vitest'
import { graphEdgeTypeSchema, graphNodeTypeSchema } from './app.js'

describe('server graph type schemas stay derived from @openreverie/memory', () => {
  it('graphNodeTypeSchema accepts exactly NODE_TYPES', () => {
    expect([...graphNodeTypeSchema.options].sort()).toEqual([...NODE_TYPES].sort())
  })

  it('graphEdgeTypeSchema accepts exactly EDGE_TYPES', () => {
    expect([...graphEdgeTypeSchema.options].sort()).toEqual([...EDGE_TYPES].sort())
  })
})
