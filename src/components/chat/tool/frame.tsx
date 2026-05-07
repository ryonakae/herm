// InlineTool — the single shape every tool renders into in the
// ThoughtCloud. Diffs that warrant a body render as InlineDiff chips
// in the assistant message body (MessageItem), not here.

import { memo, useState, type ReactNode } from "react"
import type { RGBA } from "@opentui/core"
import type { ToolPart } from "../../../types/message"
import { useTheme } from "../../../theme"
import { useSpinnerGlyph } from "../../../ui/spinner"
import { spec } from "./preview"

function ms(d?: number): string {
  if (d == null) return ""
  if (d < 1000) return `${Math.round(d)}ms`
  if (d < 60000) return `${(d / 1000).toFixed(1)}s`
  return `${Math.floor(d / 60000)}m${Math.round((d % 60000) / 1000)}s`
}

type InlineProps = {
  part: ToolPart
  /** Content for the collapsed row; usually preview text. */
  children: ReactNode
  /** True once enough input exists to show `children` instead of pending. */
  complete?: boolean
  iconColor?: RGBA
  indent?: number
  onClick?: () => void
}

export const InlineTool = memo((p: InlineProps) => {
  const theme = useTheme().theme
  const [hover, setHover] = useState(false)
  const s = spec(p.part.name)
  const running = p.part.status === "running"
  const failed = p.part.status === "error"
  const spin = useSpinnerGlyph(running)

  const fg = failed ? theme.error
    : hover && p.onClick ? theme.text
    : running ? theme.text
    : theme.textMuted

  return (
    <box
      flexDirection="column"
      paddingLeft={p.indent ?? 3}
      onMouseOver={p.onClick ? () => setHover(true) : undefined}
      onMouseOut={p.onClick ? () => setHover(false) : undefined}
      onMouseDown={p.onClick}
    >
      <box height={1}>
        <text>
          <span fg={running ? theme.warning : p.iconColor ?? fg}>{running ? spin : s.icon} </span>
          {p.complete ?? true
            ? <span fg={fg}>{p.children}</span>
            : <span fg={fg}>~ {s.pending}</span>}
          {p.part.duration != null
            ? <span fg={theme.textMuted}>  {ms(p.part.duration)}</span>
            : null}
        </text>
      </box>
      {failed && p.part.result ? (
        <box minHeight={1} paddingLeft={2}>
          <text fg={theme.error} wrapMode="word">{p.part.result}</text>
        </box>
      ) : null}
    </box>
  )
})

