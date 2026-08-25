// The one canonical wording for what a tool is doing, shared by every
// surface that narrates tool calls to the person (the terminal CLI today,
// the web UI separately). A tool call has two moments worth narrating: it
// started, and it finished, so every entry carries both a running form
// (plain gerund: "Searching memory") and a done form (plain past tense:
// "Searched memory") rather than one label reused for both.
//
// This lives in core, next to toolDefinitions(), because core already owns
// the single source of tool names. A surface that only prints a label
// derived from the tool name (rather than calling the tool itself) has no
// business hand-maintaining its own copy of that name list.
export interface ToolLabel {
  readonly running: string
  readonly done: string
}

// One honest, specific label per tool, so the person watching knows what
// reverie is actually doing rather than one generic label for everything.
// The four listing tools (list_arcs, list_realms, list_people,
// list_entities) each get their own wording on purpose: an earlier version
// of the CLI table folded all four into "checking memory", and that was an
// explicit complaint.
const TOOL_LABELS: Record<string, ToolLabel> = {
  remember: { running: 'Remembering', done: 'Remembered' },
  search_memory: { running: 'Searching memory', done: 'Searched memory' },
  graph_query: { running: 'Tracing connections', done: 'Traced connections' },
  read_document: { running: 'Reading back', done: 'Read that back' },
  read_transcript: {
    running: 'Reading a past conversation',
    done: 'Read a past conversation',
  },
  list_arcs: { running: 'Reviewing your storylines', done: 'Reviewed your storylines' },
  list_realms: { running: 'Reviewing your life areas', done: 'Reviewed your life areas' },
  list_people: { running: 'Looking over people', done: 'Looked over people' },
  list_entities: { running: 'Looking over things', done: 'Looked over things' },
  set_mode: { running: 'Switching mode', done: 'Switched mode' },
  update_profile: { running: 'Updating your profile', done: 'Updated your profile' },
  declare_journal_method: {
    running: 'Setting the journal format',
    done: 'Set the journal format',
  },
  update_journaling_protocol: {
    running: 'Updating your journal setup',
    done: 'Updated your journal setup',
  },
  dream_feedback: { running: 'Noting your reaction', done: 'Noted your reaction' },
}

// A tool this table has never heard of (a future addition, or a stale
// build a surface is still running against) still gets a plain, truthful
// label instead of silence, an empty chip, or a crash. Same spirit as the
// CLI's old `using: ${name}` fallback: name the raw tool, do not pretend
// to know what it does.
function fallbackLabel(name: string): ToolLabel {
  return { running: `Using: ${name}`, done: `Used: ${name}` }
}

export function toolLabel(name: string): ToolLabel {
  return TOOL_LABELS[name] ?? fallbackLabel(name)
}
