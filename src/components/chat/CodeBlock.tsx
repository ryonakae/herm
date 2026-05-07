// Fenced code block chrome — bg panel, lang label, click-to-copy.
// The body is a <code> renderable so tree-sitter highlighting stays
// identical to what MarkdownRenderable would have produced; the point
// of pulling fences out of the markdown stream is purely to wrap them.

import { memo, useState } from "react"
import { useTheme } from "../../theme"
import { useToast } from "../../ui/toast"
import { copy } from "../../utils/clipboard"

// Info-string → tree-sitter filetype. Only the handful that differ
// from their canonical fence tag; everything else passes through.
const FILETYPE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", rb: "ruby", rs: "rust", sh: "bash", shell: "bash",
  yml: "yaml", md: "markdown",
}

export const CodeBlock = memo((props: { code: string; lang?: string; streaming?: boolean; pad?: number }) => {
  const { theme, syntaxStyle } = useTheme()
  const toast = useToast()
  const [hover, setHover] = useState(false)

  const ft = props.lang ? FILETYPE[props.lang.toLowerCase()] ?? props.lang.toLowerCase() : undefined
  const lines = props.code.split("\n").length
  const pad = props.pad ?? 1

  const onCopy = () => {
    void copy(props.code)
    toast.show({ variant: "success", message: `Copied ${lines} line${lines === 1 ? "" : "s"}` })
  }

  return (
    <box
      flexDirection="column"
      marginTop={1}
      marginBottom={1}
      backgroundColor={theme.backgroundPanel}
    >
      <box
        flexDirection="row" height={1}
        backgroundColor={theme.backgroundElement}
        onMouseDown={onCopy}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        <box flexGrow={1} paddingLeft={pad}>
          <text fg={theme.textMuted}>{props.lang || "text"}</text>
        </box>
        <box paddingRight={pad}>
          <text fg={hover ? theme.accent : theme.textMuted}>
            {hover ? "⧉ copy" : `${lines} ln`}
          </text>
        </box>
      </box>
      <box paddingX={pad} paddingY={1}>
        {ft
          ? <code content={props.code} filetype={ft} syntaxStyle={syntaxStyle}
                  fg={theme.text} wrapMode="none" streaming={props.streaming} />
          : <text fg={theme.text}>{props.code}</text>}
      </box>
    </box>
  )
})
