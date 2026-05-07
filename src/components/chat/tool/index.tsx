// Per-tool dispatch — oc's `<Switch>` over part.tool. Each hermes
// tool name maps to either an InlineTool row or a BlockTool card.
//
// Data constraint: the stock tui_gateway emits only
//   tool.start    {name, context: build_tool_preview() string ≤80ch}
//   tool.complete {summary, inline_diff?, error?, duration_s}
// — NOT the raw args JSON or the tool result body. So per-tool
// *bodies* (bash stdout, todo checklist, grep matches) are blocked
// on the wire carrying more (→ docs/UPSTREAM.md). The dispatch and
// frame grammar here are ready for them.

import { memo } from "react"
import type { ToolPart as Part } from "../../../types/message"
import type { DetailMode } from "../../../utils/preferences"
import { InlineTool } from "./frame"
import { isDiff } from "../DiffBlock"
import { Subagent } from "./Subagent"
import { spec } from "./preview"
import { useTheme } from "../../../theme"

const FILE = new Set(["write_file", "patch"])

function short(s: string | undefined, n = 120): string {
  if (!s) return ""
  const one = s.replace(/\s+/g, " ").trim()
  return one.length > n ? one.slice(0, n - 1) + "…" : one
}

function base(path: string): string {
  const clean = path.replace(/\/+$/, "")
  const slash = clean.lastIndexOf("/")
  return slash >= 0 ? clean.slice(slash + 1) : clean
}

const Inline = memo(({ tool, indent }: { tool: Part; indent?: number }) => {
  const s = spec(tool.name)
  const body = tool.preview ? short(tool.preview) : ""
  return (
    <InlineTool part={tool} complete={!!body || tool.status !== "running"} indent={indent}>
      {s.verb ? `${s.verb} ${body}` : body || tool.name}
    </InlineTool>
  )
})

/** Accent-filled pill: `changed <basename>`. The actual diff renders
 *  as an InlineDiff chip in the assistant message body (d39945f), so
 *  the ThoughtCloud row only needs to say *that* a file changed. */
const FileEdit = memo(({ tool, indent }: { tool: Part; indent?: number }) => {
  const theme = useTheme().theme
  // While running (no result yet) or when preview is absent (some
  // providers omit the path), fall through to the generic inline row.
  if (tool.status === "running" || !tool.preview) return <Inline tool={tool} indent={indent} />
  return (
    <InlineTool part={tool} indent={indent}>
      <span bg={theme.accent} fg={theme.background}> changed {short(base(tool.preview), 48)} </span>
    </InlineTool>
  )
})

export const Tool = memo(({ tool, detail = "expanded", indent }: { tool: Part; detail?: DetailMode; indent?: number }) => {
  if (detail === "hidden" && tool.status !== "running") return null
  if (tool.trail || tool.name === "delegate_task") return <Subagent tool={tool} />
  if (FILE.has(tool.name) || tool.diff || isDiff(tool.result)) return <FileEdit tool={tool} indent={indent} />
  return <Inline tool={tool} indent={indent} />
})
