// ThoughtInline summary — collapsed view of one chronological run of
// reasoning or tool parts. MessageItem places these runs between normal
// transcript text so inline thought follows the actual turn order.
//
// Closed: a one-liner pill (`▸ 2 reasoning` / `▸ 3 tools`).
// Open:   thinking lines or tool rows through the shared <Tool> dispatch.

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
    <box flexDirection="column" marginBottom={1}>
      <box height={1} onMouseDown={toggle}>
        <text>
          <span fg={theme.textMuted}>{open ? "▾ " : "▸ "}</span>
          <span fg={theme.textMuted}>{summary(think, tools)}</span>
        </text>
      </box>
      {open ? (
        <box flexDirection="column" marginTop={1}>
          {items.map((p, i) => {
            const key = p.type === "thinking" ? p.key ?? `th-${i}` : p.id || `t-${i}`
            return (
              <box key={key} flexDirection="column" width="100%" flexShrink={0}>
                {p.type === "thinking" ? (
                  <box minHeight={1} width="100%" flexShrink={0}>
                    <text fg={theme.textMuted} wrapMode="word">{p.content}</text>
                  </box>
                ) : (
                  <box width="100%" flexShrink={0}>
                    <Tool tool={p} detail={detail === "hidden" ? "hidden" : "collapsed"} indent={0} />
                  </box>
                )}
              </box>
            )
          })}
        </box>
      ) : null}
    </box>
  )
})
