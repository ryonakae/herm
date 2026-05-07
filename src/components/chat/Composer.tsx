// Composer — owns the chat input buffer, slash popover, ghost completion
// and prompt history. The shell (app.tsx) drives keyboard routing through
// the imperative handle so there is exactly one global useKeyboard.

import { forwardRef, memo, useImperativeHandle, useRef, useState, useCallback, useMemo, useEffect } from "react"
import type { TextareaRenderable, PasteEvent } from "@opentui/core"
import { decodePasteBytes } from "@opentui/core"
import { useTheme } from "../../theme"
import { useKeys, toBindings } from "../../keys"
import { useGateway } from "../../app/gateway"
import type { ImageAttachResponse, DropDetectResponse } from "../../utils/gateway-types"
import { looksLikePath } from "../../utils/drop"
import type { SlashCommand } from "../../commands/slash"
import { useSlashPopover } from "../../app/useSlashPopover"
import { useAtRefPopover } from "../../app/useAtRefPopover"
import { useInputHistory } from "../../app/useInputHistory"
import { SlashPopover } from "./SlashPopover"
import { AtRefPopover } from "./AtRefPopover"
import { ChafaImage } from "../../ui/ChafaImage"
import { trunc } from "../../ui/fmt"

export type ComposerHandle = {
  value: () => string
  set: (v: string) => void
  /** Insert text at the cursor (verbatim, multi-line ok). */
  insert: (text: string) => void
  /** Logical line count of the current buffer. */
  lines: () => number
  /** True iff the buffer is empty (no text, no whitespace-only). */
  isEmpty: () => boolean
  popOpen: () => boolean
  popNav: (d: -1 | 1) => void
  popAccept: () => void
  popCancel: () => void
  /** Returns false when not applicable (multi-line buffer → caller lets textarea own ↑/↓). */
  historyUp: () => boolean
  historyDown: () => boolean
}

type Props = {
  focused: boolean
  ready: boolean
  streaming: boolean
  meta?: string
  queue?: ReadonlyArray<string>
  attachments?: ReadonlyArray<ImageAttachResponse>
  cmds: ReadonlyArray<SlashCommand>
  onSend: (text: string) => void
  onSlash: (cmd: SlashCommand) => void
  onAttach?: (r: ImageAttachResponse) => void
  onEnqueue?: (text: string) => void
  onDequeue?: (i: number) => void
  /** Enter pressed with an empty buffer. Return true to consume. */
  onEmptyEnter?: () => boolean
  /** Fires on the empty↔non-empty edge of the input buffer. */
  onDirty?: (dirty: boolean) => void
}

const MAX_ROWS = 6

function fmt(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export const Composer = memo(forwardRef<ComposerHandle, Props>((props, ref) => {
  const theme = useTheme().theme
  const gw = useGateway()
  const keys = useKeys()
  const ta = useRef<TextareaRenderable | null>(null)
  // Mirror of the textarea buffer. The renderable is the source of truth;
  // this drives React-side derivations (popover matching, row count, hints).
  const [input, setInput] = useState("")

  // Slash and @-ref popovers key off the first line only — both grammars
  // are single-line prefixes, and a newline is a hard boundary.
  const head = useMemo(() => {
    const i = input.indexOf("\n")
    return i < 0 ? input : input.slice(0, i)
  }, [input])

  const pop = useSlashPopover(head, props.cmds)
  const at = useAtRefPopover(head)

  const write = useCallback((v: string) => {
    ta.current?.setText(v)
    ta.current?.gotoBufferEnd()
    setInput(v)
  }, [])

  const hist = useInputHistory(input, write)

  // Merged over the renderable's default map (which has bare return →
  // newline), so input.submit's `return` entry overrides it and the
  // newline alternates add on top. Recomputes only when a user rebinds.
  const bindings = useMemo(() => [
    ...toBindings(keys.chord("input.submit"), "submit"),
    ...toBindings(keys.chord("input.newline"), "newline"),
  ], [keys])

  // Hold latest pop/props in a ref so the imperative handle is stable.
  const live = useRef({ pop, at, props, input })
  live.current = { pop, at, props, input }

  // Notify parent only on the empty↔non-empty edge so the splash
  // continue-prompt can hide the moment typing starts.
  const wasDirty = useRef(false)
  useEffect(() => {
    const dirty = input.trim().length > 0
    if (dirty === wasDirty.current) return
    wasDirty.current = dirty
    live.current.props.onDirty?.(dirty)
  }, [input])

  // Selecting a popover entry: subcommand synthetics (name contains a
  // space) complete the input for further typing; real commands dispatch.
  const select = (c: SlashCommand) => {
    if (c.name.includes(" ")) { write(`/${c.name} `); return }
    write("")
    live.current.props.onSlash(c)
  }

  const atAccept = (idx?: number) => {
    const next = live.current.at.accept(live.current.input, idx)
    if (next !== null) write(next)
  }

  // Paste routing, in priority order:
  //  1. Single-line paste that *looks* like a local path → ask the gateway.
  //     input.detect_drop is authoritative (stats the file, handles file://,
  //     quoting, escaped spaces, ~/ expansion, WSL drive rewriting). Image
  //     hits append to session["attached_images"] server-side; herm mirrors
  //     the chip and inserts only the trailing remainder text, not the
  //     `[User attached image: …]` placeholder (that's for blind clients).
  //     Non-image hits (pdf/txt/…) insert the `[User attached file: …]`
  //     wrapper so the agent sees the path. Any miss falls through.
  //  2. ≥5 lines → gateway writes a temp file and hands back a
  //     `[Pasted #N …]` placeholder (hermes CLI convention; expanded
  //     server-side in prompt.submit).
  //  3. Otherwise insert verbatim minus trailing newlines — terminals append
  //     one on bracketed paste and `echo`/`cat` output copied from a shell
  //     always carries one, so a naive 1-line paste would otherwise push the
  //     cursor to a blank second row. A paste that is *only* newlines is let
  //     through unchanged (intentional line break).
  const paste = useCallback((e: PasteEvent) => {
    e.preventDefault()
    const raw = decodePasteBytes(e.bytes).replace(/\r\n?/g, "\n")
    const text = /[^\n]/.test(raw) ? raw.replace(/\n+$/, "") : raw
    const verbatim = () => ta.current?.insertText(text)
    if (looksLikePath(text)) {
      gw.request<DropDetectResponse>("input.detect_drop", { text })
        .then(r => {
          if (!r.matched) return verbatim()
          if (r.is_image) {
            const { path, count, name, width, height, token_estimate } = r
            live.current.props.onAttach?.({ attached: true, path, count, name, width, height, token_estimate })
            if (!r.text.startsWith("[User attached")) ta.current?.insertText(r.text + " ")
            return
          }
          ta.current?.insertText(r.text + " ")
        })
        .catch(verbatim)
      return
    }
    if (text.split("\n").length < 5) return verbatim()
    gw.request<{ placeholder: string }>("paste.collapse", { text })
      .then(r => ta.current?.insertText(r.placeholder + " "))
      .catch(verbatim)
  }, [gw])

  const submit = () => {
    // Popover accept runs first — slash commands and @-ref completion
    // stay live while streaming so /steer, /stop, tab jumps, and queued
    // /cmd prompts all resolve against the catalog.
    const a = live.current.at
    if (a.open) return atAccept()
    const p = live.current.pop
    if (p.open) {
      const c = p.popover?.[p.cursor]
      if (c) select(c)
      return
    }
    const text = live.current.input.trim()
    if (live.current.props.streaming) {
      if (!text || !live.current.props.ready) return
      hist.push(text)
      write("")
      live.current.props.onEnqueue?.(text)
      return
    }
    const hasAtt = (live.current.props.attachments?.length ?? 0) > 0
    if (!text && !hasAtt) { live.current.props.onEmptyEnter?.(); return }
    if (!live.current.props.ready) return
    if (text) hist.push(text)
    write("")
    live.current.props.onSend(text)
  }

  const multi = () => live.current.input.includes("\n")

  useImperativeHandle(ref, () => ({
    value: () => live.current.input,
    set: write,
    insert: (text) => ta.current?.insertText(text),
    lines: () => (ta.current?.lineCount ?? 1),
    isEmpty: () => live.current.input.trim().length === 0,
    popOpen: () => live.current.pop.open || live.current.at.open,
    popNav: (d) => {
      const a = live.current.at
      if (a.open) return a.setCursor(c => Math.max(0, Math.min(a.items.length - 1, c + d)))
      const max = (live.current.pop.popover?.length ?? 1) - 1
      pop.setCursor(c => Math.max(0, Math.min(max, c + d)))
    },
    popAccept: () => {
      const a = live.current.at
      if (a.open) return atAccept()
      const p = live.current.pop
      const c = p.popover?.[p.cursor]
      if (c) write(`/${c.name}${c.name.includes(" ") ? " " : ""}`)
    },
    popCancel: () => {
      const a = live.current.at
      if (a.open) return a.dismiss()
      write("")
    },
    historyUp: () => { if (multi()) return false; hist.up(); return true },
    historyDown: () => { if (multi()) return false; hist.down(); return true },
  }), [hist.up, hist.down, pop.setCursor, write])

  const label = !props.ready ? "Connecting..."
    : props.streaming ? ""
    : "Ready"
  const dot = props.ready ? (props.streaming ? theme.warning : theme.success) : theme.error

  // Logical-line row count (wrap-induced growth ignored; yoga sizes the
  // textarea, this only positions the absolute popover above the border).
  const rows = Math.min(MAX_ROWS, Math.max(1, input.split("\n").length))
  const lift = rows + 3

  return (
    <box flexDirection="column" position="relative">
      {props.focused && pop.open ? (
        <box position="absolute" bottom={lift} left={0} right={0}>
          <SlashPopover
            commands={pop.popover!}
            cursor={pop.cursor}
            onCursor={pop.setCursor}
            onSelect={select}
          />
        </box>
      ) : props.focused && at.open ? (
        <box position="absolute" bottom={lift} left={0} right={0}>
          <AtRefPopover
            items={at.items}
            cursor={at.cursor}
            onCursor={at.setCursor}
            onSelect={atAccept}
          />
        </box>
      ) : null}

      {(props.queue?.length ?? 0) > 0 ? (
        <box flexDirection="column" paddingX={1} paddingBottom={1}>
          {props.queue!.map((q, i) => (
            <box key={i} height={1} onMouseDown={() => props.onDequeue?.(i)}>
              <text>
                <span fg={theme.borderSubtle}>{i === 0 ? "╭" : "│"} </span>
                <span fg={theme.textMuted}>⏸ {i + 1}. {trunc(q, 60)}</span>
              </text>
            </box>
          ))}
        </box>
      ) : null}

      {(props.attachments?.length ?? 0) > 0 ? (
        <box flexDirection="column" paddingX={1} paddingBottom={1} gap={1}>
          {props.attachments!.map(a => a.path
            ? <ChafaImage key={`p-${a.path}`} path={a.path} width={60} />
            : null)}
        </box>
      ) : null}

      {(props.attachments?.length ?? 0) > 0 ? (
        <box flexDirection="row" flexWrap="wrap" gap={1} paddingX={1} paddingBottom={1}>
          {props.attachments!.map((a, i) => (
            <text key={a.path ?? i}>
              <span bg={theme.accent} fg={theme.background}> img </span>
              <span bg={theme.backgroundElement} fg={theme.textMuted}> {a.name ?? `image ${i + 1}`} </span>
              {a.width && a.height
                ? <span bg={theme.backgroundElement} fg={theme.textMuted}>{a.width}×{a.height} </span>
                : null}
              {a.token_estimate
                ? <span bg={theme.backgroundElement} fg={theme.textMuted}>~{fmt(a.token_estimate)}t </span>
                : null}
              <span fg={theme.textMuted}>  </span>
              <span fg={theme.textMuted}>⌫ to detach</span>
            </text>
          ))}
        </box>
      ) : null}

      <box
        border
        borderStyle="single"
        borderColor={props.focused ? theme.borderActive : theme.border}
        flexDirection="row"
        position="relative"
      >
        <box width={1}><text fg={theme.primary}>{">"}</text></box>
        <box width={1} />
        <textarea
          ref={ta}
          onContentChange={() => setInput(ta.current?.plainText ?? "")}
          onSubmit={submit}
          onPaste={paste}
          keyBindings={bindings}
          wrapMode="word"
          minHeight={1}
          maxHeight={MAX_ROWS}
          placeholder={props.streaming ? "Type to queue... (Enter queues, click chip to edit)" : "Message Hermes... (/ for commands, Shift+Enter for newline)"}
          focused={props.focused}
          textColor={theme.text}
          focusedTextColor={theme.text}
          placeholderColor={theme.textMuted}
          cursorColor={theme.text}
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
          flexGrow={1}
        />
        {pop.ghost && props.focused && rows === 1 ? (
          <box position="absolute" top={0} left={2 + input.length} height={1}>
            <text fg={theme.textMuted}>{pop.ghost}</text>
          </box>
        ) : null}
      </box>

      <box height={1} flexDirection="row" paddingX={1}>
        <box flexShrink={1}>
          <text>
            <span fg={dot}>● </span>
            <span fg={theme.textMuted}>{label}</span>
            {props.meta ? <span fg={theme.textMuted}>{` · ${props.meta}`}</span> : null}
          </text>
        </box>
        <box flexGrow={1} />
        {props.streaming && (props.queue?.length ?? 0) > 0 ? (
          <box flexShrink={0}><text fg={theme.textMuted}>{keys.print("queue.flush")} to send queued now</text></box>
        ) : null}
      </box>
    </box>
  )
}))
