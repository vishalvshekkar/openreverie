import { describe, expect, it } from 'vitest'
import { toolLabel } from './tool-labels.js'
import { toolDefinitions } from './tools.js'

describe('toolLabel', () => {
  it('maps each known tool to its honest, specific running and done forms', () => {
    expect(toolLabel('remember')).toEqual({ running: 'Remembering', done: 'Remembered' })
    expect(toolLabel('search_memory')).toEqual({
      running: 'Searching memory',
      done: 'Searched memory',
    })
    expect(toolLabel('graph_query')).toEqual({
      running: 'Tracing connections',
      done: 'Traced connections',
    })
    expect(toolLabel('read_document')).toEqual({
      running: 'Reading back',
      done: 'Read that back',
    })
    expect(toolLabel('read_transcript')).toEqual({
      running: 'Reading a past conversation',
      done: 'Read a past conversation',
    })
    expect(toolLabel('list_arcs')).toEqual({
      running: 'Reviewing your storylines',
      done: 'Reviewed your storylines',
    })
    expect(toolLabel('list_realms')).toEqual({
      running: 'Reviewing your life areas',
      done: 'Reviewed your life areas',
    })
    expect(toolLabel('list_people')).toEqual({
      running: 'Looking over people',
      done: 'Looked over people',
    })
    expect(toolLabel('list_entities')).toEqual({
      running: 'Looking over things',
      done: 'Looked over things',
    })
    expect(toolLabel('set_mode')).toEqual({ running: 'Switching mode', done: 'Switched mode' })
    expect(toolLabel('update_profile')).toEqual({
      running: 'Updating your profile',
      done: 'Updated your profile',
    })
    expect(toolLabel('declare_journal_method')).toEqual({
      running: 'Setting the journal format',
      done: 'Set the journal format',
    })
    expect(toolLabel('update_journaling_protocol')).toEqual({
      running: 'Updating your journal setup',
      done: 'Updated your journal setup',
    })
    expect(toolLabel('dream_feedback')).toEqual({
      running: 'Noting your reaction',
      done: 'Noted your reaction',
    })
  })

  it('falls back to a plain, truthful running/done pair for an unknown tool', () => {
    expect(toolLabel('some_future_tool')).toEqual({
      running: 'Using: some_future_tool',
      done: 'Used: some_future_tool',
    })
  })

  // forget is parked, not shipped: it has no label of its own and falls
  // back to the same plain, truthful default as any other unlisted tool.
  it('has no label of its own for forget, since the feature is parked', () => {
    expect(toolLabel('forget')).toEqual({
      running: 'Using: forget',
      done: 'Used: forget',
    })
  })

  // The gap this guards: a hand-maintained label table sitting next to a
  // tool list that grows in a different file. The CLI's own TOOL_NOTICES
  // table already suffered exactly this drift once, when toolDefinitions()
  // grew from eight tools to thirteen and five names fell through to the
  // generic fallback unnoticed. This test derives the expected names from
  // toolDefinitions() itself, never a hardcoded list, and checks BOTH the
  // running and the done form, so neither can silently regress to the
  // fallback as the tool list grows.
  it('has a specific running and done label for every tool the agent can actually call', () => {
    for (const tool of toolDefinitions()) {
      const label = toolLabel(tool.name)
      expect(label.running).not.toBe(`Using: ${tool.name}`)
      expect(label.done).not.toBe(`Used: ${tool.name}`)
    }
  })
})
