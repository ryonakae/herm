import { memo, useMemo, useRef, useState, type RefObject } from "react"
import type { RGBA, MouseEvent } from "@opentui/core"
import type { Message, Part, TextPart, ToolPart, PromptPart } from "../../types/message"
import { ErrorBlock } from "./ErrorBlock"
import { MediaChip, classify, splitContent } from "./MediaChip"
import { CodeBlock } from "./CodeBlock"
import { DiffBlock, isDiff } from "./DiffBlock"
import { PromptCard, type PromptCardHandle } from "./PromptCard"
import { ChafaImage } from "../../ui/ChafaImage"
import { useTheme } from "../../theme"
import { useSkin } from "../../app/skin"
import { mathify } from "../../utils/math-unicode"
import { usePref } from "../../utils/preferences"
import { ThoughtInline } from "./ThoughtInline"

export type { Message }

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${Math.floor(s % 60)}s`
}

function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function extract(msg: Message): string {
  return msg.parts
    .filter((p): p is TextPart => p.type === "text")
    .map(p => p.content)
    .join("")
}

const trunc = (s: string, max: number) => s.length <= max ? s : s.slice(0, max - 1) + "…"

// Collapsible diff chip: shows filename/preview + +N/-M, expands to full
// DiffBlock on click. Lives in the message body so edits land in the
// transcript (not buried in the ThoughtCloud). stopPropagation keeps the
// click from triggering onPick on the parent message.
const InlineDiff = memo(({ tool }: { tool: ToolPart }) => {
  const theme = useTheme().theme
  const [open, setOpen] = useState(false)
  const diff = tool.diff ?? (isDiff(tool.result) ? tool.result : undefined)
  if (!diff) return null
  const lines = diff.split("\n")
  const add = lines.filter(l => /^\+(?!\+\+)/.test(l)).length
  const del = lines.filter(l => /^-(?!--)/.test(l)).length
  return (
    <box flexDirection="column" marginTop={1}
         onMouseDown={(e: MouseEvent) => { e.stopPropagation(); setOpen(o => !o) }}>
      <box height={1}>
        <text>
          <span fg={theme.textMuted}>{open ? "▾ " : "▸ "}</span>
          <span fg={theme.text}>{trunc(tool.preview ?? tool.name, 50)}</span>
          <span fg={theme.textMuted}>  </span>
          <span fg={theme.success}>+{add}</span>
          <span fg={theme.textMuted}> / </span>
          <span fg={theme.error}>-{del}</span>
        </text>
      </box>
      {open ? <box marginTop={1}><DiffBlock text={diff} /></box> : null}
    </box>
  )
})

// OpenTUI has no onClick; synthesize one from down→up at the same cell
// so text-selection drags don't fire it.
function useClick(fn?: () => void) {
  const at = useRef<{ x: number; y: number } | null>(null)
  return {
    onMouseDown: (e: MouseEvent) => { at.current = { x: e.x, y: e.y } },
    onMouseUp: (e: MouseEvent) => {
      const a = at.current
      at.current = null
      if (fn && a && a.x === e.x && a.y === e.y) fn()
    },
  }
}

/** Themed vertical bar next to the body. `side` picks left or right. */
const Gutter = memo(({ color, glyph = "│", side = "left", children }: {
  color: RGBA
  glyph?: string
  side?: "left" | "right"
  children: React.ReactNode
}) => {
  const bar = (
    <box
      width={2}
      flexShrink={0}
      border={[side]}
      borderColor={color}
      customBorderChars={{
        topLeft: glyph, bottomLeft: glyph, vertical: glyph,
        topRight: glyph, bottomRight: glyph, horizontal: "",
        topT: "", bottomT: "", leftT: "", rightT: "", cross: "",
      }}
    />
  )
  return (
    <box flexDirection="row">
      {side === "left" ? bar : null}
      <box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </box>
      {side === "right" ? bar : null}
    </box>
  )
})

export type PromptWire = {
  /** Ref to the single pending prompt card, for key routing. */
  ref: RefObject<PromptCardHandle | null>
  onAnswer: (id: string, label: string, ok: boolean) => void
}

export const MessageItem = memo(({ message, streaming, prompt, onRewind, onPick }: {
  message: Message
  streaming: boolean
  prompt?: PromptWire
  onRewind?: (m: Message) => void
  onPick?: (m: Message) => void
}) => {
  if (message.role === "system") return <SystemMessage message={message} />
  if (message.role === "user") return <UserMessage message={message} onRewind={onRewind} />
  return <AssistantMessage message={message} streaming={streaming} prompt={prompt} onPick={onPick} />
})

const SystemMessage = memo(({ message }: { message: Message }) => {
  const theme = useTheme().theme
  return (
    <box marginBottom={1}>
      <Gutter color={theme.textMuted} glyph="·">
        <box minHeight={1}>
          <text fg={theme.textMuted} wrapMode="word">{extract(message)}</text>
        </box>
      </Gutter>
    </box>
  )
})

const UserMessage = memo(({ message, onRewind }: { message: Message; onRewind?: (m: Message) => void }) => {
  const theme = useTheme().theme
  const [hover, setHover] = useState(false)
  const click = useClick(onRewind && (() => onRewind(message)))
  const segs = useMemo(
    () => message.parts.map(p => p.type === "text" && p.content ? splitContent(p.content) : null),
    [message.parts],
  )
  return (
    <box
      flexDirection="column"
      marginBottom={1}
      backgroundColor={hover ? theme.backgroundElement : undefined}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      {...click}
    >
      <Gutter color={theme.primary} side="left">
        <box minHeight={1} flexDirection="column">
          {message.parts.map((p, i) => {
            const seg = segs[i]
            if (!seg) return null
            const k = (p as TextPart).key ?? i
            return seg.map((s, j) => {
              if ("media" in s) {
                const kind = classify(s.media)
                return kind === "img" ? (
                  <box key={`${k}-m${j}`}><ChafaImage path={s.media} /></box>
                ) : (
                  <box key={`${k}-m${j}`} marginTop={1}><MediaChip path={s.media} /></box>
                )
              }
              if ("code" in s) return (
                <CodeBlock key={`${k}-c${j}`} code={s.code} lang={s.lang} />
              )
              return <text key={`${k}-${j}`} fg={theme.text} wrapMode="word">{s.md}</text>
            })
          })}
        </box>
      </Gutter>
    </box>
  )
})

const AssistantMessage = memo(({ message, streaming, prompt, onPick }: {
  message: Message; streaming: boolean; prompt?: PromptWire; onPick?: (m: Message) => void
}) => {
  const ctx = useTheme()
  const theme = ctx.theme
  const { agentName } = useSkin()
  const inline = usePref("thoughtDisplay") === "inline"
  const [hover, setHover] = useState(false)
  const click = useClick(onPick && (() => onPick(message)))
  const err = !!message.error
  const trail = message.parts.filter((p): p is ToolPart | PromptPart =>
    p.type === "tool" || p.type === "prompt")
  const diffs = trail.filter((p): p is ToolPart =>
    p.type === "tool" && (!!p.diff || isDiff(p.result)))

  // Split once per parts identity so hover (which re-renders this
  // component) doesn't re-scan text. parts identity changes per
  // streaming delta and stabilizes on completion.
  const segs = useMemo(
    () => message.parts.map(p => p.type === "text" && p.content ? splitContent(p.content) : null),
    [message.parts],
  )

  const header = [
    agentName,
    message.usage ? `${tokens(message.usage.input)}→${tokens(message.usage.output)} tok` : null,
    message.duration ? duration(message.duration) : null,
  ].filter(Boolean).join(" · ")

  const part = (p: Part, i: number) => {
    if (p.type === "prompt") {
      // ref only attaches to the pending card (answered cards are
      // inert outcome rows and never receive keys).
      return (
        <box key={`pr-${p.id}`} marginTop={1}
             onMouseDown={(e: MouseEvent) => e.stopPropagation()}>
          <PromptCard part={p}
            ref={!p.answered ? prompt?.ref : undefined}
            onAnswer={prompt?.onAnswer ?? (() => {})} />
        </box>
      )
    }
    const seg = segs[i]
    if (!seg) return null
    const k = (p as TextPart).key ?? i
    const last = streaming && (p as TextPart).streaming
    return seg.map((s, j) => {
      const tail = last && j === seg.length - 1
      if ("media" in s) {
        const kind = classify(s.media)
        return kind === "img" ? (
          <box key={`${k}-m${j}`}><ChafaImage path={s.media} /></box>
        ) : (
          <box key={`${k}-m${j}`} marginTop={1}><MediaChip path={s.media} /></box>
        )
      }
      if ("code" in s) return (
        <CodeBlock key={`${k}-c${j}`} code={s.code} lang={s.lang} streaming={tail} />
      )
      // LaTeX → Unicode. mathify scans for $…$ / \(…\) / $$…$$ / \[…\]
      // spans and rewrites only their interiors via texToUnicode; prose
      // like `browser_navigate` is never touched. Inline-code spans are
      // skipped. Unknown commands inside a span pass through, so partial
      // streaming deltas (e.g. "\al" before "\alpha" arrives) are safe —
      // they simply don't substitute yet.
      return (
        <box key={`${k}-${j}`}>
          <markdown content={mathify(s.md)} fg={theme.markdownText}
            syntaxStyle={ctx.syntaxStyle} streaming={tail} />
        </box>
      )
    })
  }

  return (
    <box flexDirection="column" marginBottom={1}
         backgroundColor={hover ? theme.backgroundElement : undefined}
         onMouseOver={() => setHover(true)}
         onMouseOut={() => setHover(false)}
         {...click}>
      <Gutter color={err ? theme.error : theme.accent} side="right">
        <box height={1} flexDirection="row">
          <box flexGrow={1}><text fg={theme.textMuted}>{header}</text></box>
          {!inline && trail.length ? (
            <box><text fg={theme.textMuted}>
              {trunc(trail.map(p => p.type === "tool" ? p.name : "?").join(" · "), 40)}
            </text></box>
          ) : null}
        </box>
        {inline ? <ThoughtInline parts={message.parts} /> : null}
        {message.parts.map(part)}
        {diffs.map(t => <InlineDiff key={t.id || t.name} tool={t} />)}
        {err ? <ErrorBlock text={message.error!} /> : null}
      </Gutter>
    </box>
  )
})
