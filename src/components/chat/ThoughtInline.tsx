// ThoughtInline summary — collapsed view of an assistant turn's
// reasoning + tool trail. Lives at the top of the MessageItem body when
// the user opts into `thoughtDisplay: "inline"`. ThoughtCloud is suppressed in
// that mode so this is the only surface for thinking/tool parts.
//
// Closed: a one-liner pill (`▸ 2 reasoning · 3 tools`).
// Open:   the same flat list ThoughtCloud renders — thinking lines
//         spilled inline, each tool through the shared <Tool> dispatch.

import { memo, useState } from "react"
import type { MouseEvent } from "@opentui/core"
import type { Part, ThinkingPart, ToolPart } from "../../types/message"
import { Tool } from "./tool"
import { usePref } from "../../utils/preferences"
import { useTheme } from "../../theme"

function summary(think: number, tools: number): string {
  const bits: string[] = []
  if (think) bits.push(`${think} reasoning`)
  if (tools) bits.push(`${tools} tool${tools === 1 ? "" : "s"}`)
  return bits.join(" · ")
}

export const ThoughtInline = memo(({ parts }: { parts: Part[] }) => {
  const theme = useTheme().theme
  const detail = usePref("toolDetails") ?? "expanded"
  const initial = usePref("thoughtInlineDefaultOpen") ?? false
  const [open, setOpen] = useState(initial)

  const items = parts.filter(
    (p): p is ThinkingPart | ToolPart => p.type === "thinking" || p.type === "tool",
  )
  if (!items.length) return null

  const think = items.filter((p): p is ThinkingPart => p.type === "thinking").length
  const tools = items.filter((p): p is ToolPart => p.type === "tool").length

  const toggle = (e: MouseEvent) => {
    e.stopPropagation()
    setOpen(o => !o)
  }

  return (
    <box flexDirection="column" marginTop={1} marginBottom={1}>
      <box height={1} onMouseDown={toggle}>
        <text>
          <span fg={theme.textMuted}>{open ? "▾ " : "▸ "}</span>
          <span fg={theme.textMuted}>{summary(think, tools)}</span>
        </text>
      </box>
      {open ? (
        <box flexDirection="column" marginTop={1}>
          {items.map((p, i) =>
            p.type === "thinking"
              ? <box key={p.key ?? `th-${i}`} minHeight={1} width="100%" flexShrink={0}>
                  <text fg={theme.textMuted} wrapMode="word">{p.content}</text>
                </box>
              : <box key={p.id || `t-${i}`} width="100%" flexShrink={0}>
                  <Tool tool={p} detail={detail === "hidden" ? "hidden" : "collapsed"} />
                </box>,
          )}
        </box>
      ) : null}
    </box>
  )
})
