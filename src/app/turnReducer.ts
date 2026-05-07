// Chat turn state — messages, streaming flags. Parts are appended in the
// order the gateway emits them (text → tool → text → …), so rendering can
// iterate `parts` chronologically without regrouping.

import type { Message, Part, TextPart, ToolPart, PromptPart, PromptReq, Usage } from "../types/message"
import { mid, pid } from "../types/message"
import type { SubagentPayload, TranscriptMessage } from "../utils/gateway-types"

export type TurnState = {
  messages: Message[]
  streaming: boolean
  hasContent: boolean
  toolActive: boolean
}

export const initialTurn: TurnState = {
  messages: [],
  streaming: false,
  hasContent: false,
  toolActive: false,
}

export type Action =
  | { kind: "reset" }
  | { kind: "load"; messages: Message[] }
  | { kind: "push"; message: Message }
  | { kind: "user"; text: string }
  | { kind: "system"; text: string }
  | { kind: "message.start" }
  | { kind: "message.delta"; chunk: string }
  | { kind: "message.complete"; text?: string; usage?: Usage }
  | { kind: "tool.start"; id: string; name: string; preview?: string }
  | { kind: "tool.progress"; name?: string; preview?: string }
  | { kind: "tool.generating"; name?: string }
  | { kind: "tool.complete"; id: string; summary?: string; error?: string; inline_diff?: string }
  | { kind: "thinking"; text: string; final: boolean }
  | { kind: "subagent"; event: "start" | "thinking" | "tool" | "progress" | "complete"; payload: SubagentPayload }
  | { kind: "prompt"; id: string; req: PromptReq }
  | { kind: "prompt.answered"; id: string; label: string; ok: boolean }
  | { kind: "error"; text: string }
  | { kind: "interrupt.notice"; text: string }

export function turnReducer(state: TurnState, a: Action): TurnState {
  switch (a.kind) {
    case "reset":
      return initialTurn

    case "load":
      return { ...initialTurn, messages: a.messages }

    case "push":
      return { ...state, messages: [...state.messages, a.message] }

    case "user":
      return { ...state, messages: [...state.messages, userMessage(a.text)] }

    case "system":
      return { ...state, messages: [...state.messages, systemMessage(a.text)] }

    case "message.start":
      return { ...state, streaming: true, hasContent: false, toolActive: false }

    case "message.delta":
      return {
        ...state,
        hasContent: true,
        toolActive: false,
        messages: appendText(state.messages, a.chunk),
      }

    case "message.complete":
      return {
        ...state,
        streaming: false,
        hasContent: false,
        toolActive: false,
        messages: finalize(state.messages, a.text, a.usage),
      }

    case "tool.start": {
      // `context` carries the raw tool input; when JSON-shaped we keep it
      // as args so the UI can render KV lines on expand.
      const json = a.preview && /^\s*\{/.test(a.preview)
      const part: ToolPart = {
        type: "tool", id: a.id, name: a.name,
        args: json ? a.preview! : "",
        status: "running", startedAt: Date.now(),
        preview: a.preview,
      }
      return {
        ...state,
        toolActive: true,
        hasContent: false,
        messages: appendPart(state.messages, part, true),
      }
    }

    case "tool.progress":
      return {
        ...state,
        messages: updateRunningTool(state.messages, a.name, p => ({
          ...p, preview: a.preview || p.preview,
        })),
      }

    case "tool.generating":
      return {
        ...state,
        messages: updateRunningTool(state.messages, a.name, p => ({
          ...p, preview: p.preview ?? "generating…",
        })),
      }

    case "tool.complete":
      return {
        ...state,
        toolActive: false,
        messages: updateToolById(state.messages, a.id, p => ({
          ...p,
          status: (a.error ? "error" : "done") as ToolPart["status"],
          duration: p.startedAt ? Date.now() - p.startedAt : undefined,
          preview: a.summary || a.inline_diff || p.preview,
          result: a.error || a.summary,
          diff: a.inline_diff,
        })),
      }

    case "thinking":
      return { ...state, messages: upsertThinking(state.messages, a.text, a.final) }

    case "subagent":
      return { ...state, messages: renderSubagent(state.messages, a.event, a.payload) }

    case "prompt": {
      const part: PromptPart = {
        type: "prompt", id: a.id, variant: a.req.variant, req: a.req,
      }
      // Append to the in-progress assistant turn (prompts arrive
      // mid-stream, between tool calls). Seal any open text so the
      // prompt sits chronologically.
      return {
        ...state,
        messages: appendPart(state.messages, part, true),
      }
    }

    case "prompt.answered":
      return {
        ...state,
        messages: updatePrompt(state.messages, a.id, p => ({
          ...p, answered: { label: a.label, ok: a.ok, at: Date.now() },
        })),
      }

    case "error":
      return {
        ...state,
        streaming: false,
        hasContent: false,
        toolActive: false,
        messages: [...state.messages, systemMessage(`Error: ${a.text}`)],
      }

    case "interrupt.notice": {
      const last = state.messages[state.messages.length - 1]
      const already = last?.role === "system"
        && last.parts[0]?.type === "text"
        && last.parts[0].content.includes(a.text)
      if (already) return state
      return { ...state, messages: [...state.messages, systemMessage(a.text)] }
    }
  }
}

// ── Constructors ────────────────────────────────────────────────────

function userMessage(text: string): Message {
  return {
    id: mid(), role: "user",
    parts: [{ type: "text", content: text, streaming: false }],
    timestamp: Date.now() / 1000,
  }
}

function systemMessage(text: string): Message {
  return {
    id: mid(), role: "system",
    parts: [{ type: "text", content: text, streaming: false }],
    timestamp: Date.now() / 1000,
  }
}

// Flatten a transcript row's `text` to a plain string for the reducer.
// Native-mode image routing stores user turns as an OpenAI content-parts
// list (`[{type:"text",text:…}, {type:"image_url",image_url:{url:…}}, …]`)
// instead of a plain string. ChafaImage needs a path, so a `data:` URL
// can't be reconstructed into a MEDIA: line — but we emit the `withMedia`
// prefix on the wire now (app.tsx:send), so the path sits inside the
// leading {type:"text"} fragment and survives.
function flatten(text: TranscriptMessage["text"]): string {
  if (typeof text === "string") return text
  if (!Array.isArray(text)) return ""
  const out: string[] = []
  for (const p of text) {
    if (p && typeof p === "object" && "type" in p && p.type === "text"
        && "text" in p && typeof p.text === "string") out.push(p.text)
  }
  return out.join("\n")
}

function rowText(r: TranscriptMessage): string {
  return flatten(r.text ?? r.content)
}

export function transcriptToMessages(rows: TranscriptMessage[]): Message[] {
  const out: Message[] = []
  let cur: Message | null = null
  const flush = () => {
    if (cur && cur.parts.length) out.push(cur)
    cur = null
  }
  const open = () => {
    cur ??= assistant([])
    return cur
  }

  for (const r of rows) {
    if (r.role === "user") {
      flush()
      const content = rowText(r)
      if (content) out.push({
        id: mid(), role: "user",
        parts: [{ type: "text", content, streaming: false }],
        timestamp: Date.now() / 1000,
      })
      continue
    }

    if (r.role === "assistant") {
      const parts = assistantParts(r)
      if (!parts.length) continue
      open().parts.push(...parts)
      continue
    }

    if (r.role === "tool") {
      const m = open()
      const idx = toolIndex(m.parts, r.tool_call_id)
      if (idx < 0) continue
      const p = m.parts[idx]
      if (p.type !== "tool") continue
      m.parts[idx] = {
        ...p,
        status: "done",
        result: rowText(r) || r.context,
      }
    }
  }

  flush()
  return out
}

type Call = {
  id?: string
  call_id?: string
  name?: string
  function?: { name?: string; arguments?: string }
}

function assistantParts(r: TranscriptMessage): Part[] {
  const parts: Part[] = []
  const thought = r.reasoning_content || r.reasoning
  if (thought) parts.push({ type: "thinking", key: pid(), content: thought, streaming: false })
  for (const c of calls(r.tool_calls)) parts.push(toolPart(c))
  const content = rowText(r)
  if (content) parts.push({ type: "text", key: pid(), content, streaming: false })
  return parts
}

function calls(raw?: string): Call[] {
  if (!raw) return []
  try {
    const data = JSON.parse(raw) as unknown
    return Array.isArray(data) ? data.filter(isCall) : []
  } catch { return [] }
}

function isCall(v: unknown): v is Call {
  return !!v && typeof v === "object"
}

function toolPart(c: Call): ToolPart {
  const name = c.function?.name || c.name || "tool"
  const args = c.function?.arguments || ""
  return {
    type: "tool",
    id: c.id || c.call_id || pid(),
    name,
    args,
    status: "running",
    preview: preview(args),
  }
}

function preview(args: string): string | undefined {
  if (!args) return undefined
  try {
    const data = JSON.parse(args) as unknown
    if (!data || typeof data !== "object" || Array.isArray(data)) return shortArg(args)
    const obj = data as Record<string, unknown>
    for (const k of ["command", "path", "query", "pattern", "url", "prompt", "text"])
      if (typeof obj[k] === "string" && obj[k]) return shortArg(obj[k])
    const hit = Object.values(obj).find(v => typeof v === "string" && v)
    return typeof hit === "string" ? shortArg(hit) : shortArg(args)
  } catch { return shortArg(args) }
}

function shortArg(s: string): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length > 120 ? one.slice(0, 119) + "…" : one
}

function toolIndex(parts: Part[], id?: string): number {
  if (id) {
    const idx = parts.findIndex(p => p.type === "tool" && p.id === id)
    if (idx >= 0) return idx
  }
  for (let i = parts.length - 1; i >= 0; i--)
    if (parts[i].type === "tool" && (parts[i] as ToolPart).status === "running") return i
  return -1
}

// ── Internals ───────────────────────────────────────────────────────

function assistant(parts: Part[]): Message {
  return { id: mid(), role: "assistant", parts, timestamp: Date.now() / 1000 }
}

function withLastAssistant(
  messages: Message[],
  fn: (m: Message) => Message,
  otherwise: () => Message,
): Message[] {
  const last = messages[messages.length - 1]
  if (last?.role === "assistant") return [...messages.slice(0, -1), fn(last)]
  return [...messages, otherwise()]
}

/** Seal the trailing streaming text part so the next chunk starts fresh. */
function seal(parts: Part[]): Part[] {
  const last = parts[parts.length - 1]
  if (last?.type === "text" && last.streaming)
    return [...parts.slice(0, -1), { ...last, streaming: false }]
  return parts
}

/** Append a chunk to the trailing streaming text part, or open a new one. */
function appendText(messages: Message[], chunk: string): Message[] {
  return withLastAssistant(
    messages,
    m => {
      const last = m.parts[m.parts.length - 1]
      if (last?.type === "text" && last.streaming) {
        const part: TextPart = { ...last, content: last.content + chunk }
        return { ...m, parts: [...m.parts.slice(0, -1), part] }
      }
      return { ...m, parts: [...m.parts, { type: "text", key: pid(), content: chunk, streaming: true }] }
    },
    () => assistant([{ type: "text", key: pid(), content: chunk, streaming: true }]),
  )
}

/** Append a non-text part, optionally sealing any open text stream first. */
function appendPart(messages: Message[], part: Part, close: boolean): Message[] {
  return withLastAssistant(
    messages,
    m => ({ ...m, parts: [...(close ? seal(m.parts) : m.parts), part] }),
    () => assistant([part]),
  )
}

function finalize(messages: Message[], final?: string, usage?: Usage): Message[] {
  const last = messages[messages.length - 1]
  if (last?.role === "assistant") {
    const tail = last.parts[last.parts.length - 1]
    const parts = tail?.type === "text" && tail.streaming
      ? [...last.parts.slice(0, -1), { ...tail, content: final || tail.content, streaming: false }]
      : final && final !== joinText(last.parts)
        ? [...last.parts, { type: "text" as const, content: final, streaming: false }]
        : seal(last.parts)
    return [...messages.slice(0, -1), { ...last, parts, usage }]
  }
  if (!final) return messages
  return [...messages, { ...assistant([{ type: "text", content: final, streaming: false }]), usage }]
}

function joinText(parts: Part[]): string {
  return parts.filter(p => p.type === "text").map(p => p.content).join("")
}

function updateRunningTool(
  messages: Message[],
  name: string | undefined,
  fn: (p: ToolPart) => ToolPart,
): Message[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== "assistant") return messages
  for (let i = last.parts.length - 1; i >= 0; i--) {
    const p = last.parts[i]
    if (p.type !== "tool" || p.status !== "running") continue
    if (name && p.name !== name) continue
    const parts = [...last.parts]
    parts[i] = fn(p)
    return [...messages.slice(0, -1), { ...last, parts }]
  }
  return messages
}

function updateToolById(messages: Message[], id: string, fn: (p: ToolPart) => ToolPart): Message[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== "assistant") return messages
  const parts = last.parts.map(p => p.type === "tool" && p.id === id ? fn(p) : p)
  return [...messages.slice(0, -1), { ...last, parts }]
}

/** Prompts can be answered after the assistant turn has moved on
 *  (user scrolled away, agent kept streaming). Search all messages,
 *  not just the tail. */
function updatePrompt(messages: Message[], id: string, fn: (p: PromptPart) => PromptPart): Message[] {
  return messages.map(m => {
    if (m.role !== "assistant") return m
    if (!m.parts.some(p => p.type === "prompt" && p.id === id)) return m
    return { ...m, parts: m.parts.map(p => p.type === "prompt" && p.id === id ? fn(p) : p) }
  })
}

function upsertThinking(messages: Message[], text: string, final: boolean): Message[] {
  return withLastAssistant(
    messages,
    m => {
      const idx = m.parts.length - 1
      const prev = m.parts[idx]
      if (prev?.type === "thinking") {
        // `final` (reasoning.available) is a fallback for providers
        // that don't stream deltas — keep the accumulated buffer if we
        // have one. Matches Ink turnController.recordReasoningAvailable.
        const content = final ? prev.content.trim() || text : prev.content + text
        const parts = [...m.parts]
        parts[idx] = { ...prev, content, streaming: !final }
        return { ...m, parts }
      }
      if (final && m.parts.some(p => p.type === "thinking")) return m
      return { ...m, parts: [...m.parts, { type: "thinking" as const, key: pid(), content: text, streaming: !final }] }
    },
    () => assistant([{ type: "thinking", key: pid(), content: text, streaming: !final }]),
  )
}

function renderSubagent(
  messages: Message[],
  event: "start" | "thinking" | "tool" | "progress" | "complete",
  p: SubagentPayload,
): Message[] {
  // Prefer the stable subagent_id threaded by delegate_tool; fall back
  // to task_index for older gateways. task_index alone collides when
  // orchestrator children spawn their own batch (same index, new depth).
  const id = p.subagent_id ? `sub-${p.subagent_id}` : `sub-${p.task_index}`

  if (event === "start") {
    const part: ToolPart = {
      type: "tool", id, name: "delegate_task", args: "",
      status: "running", startedAt: Date.now(),
      preview: p.goal, goal: p.goal, depth: p.depth ?? 0, trail: [],
    }
    return appendPart(messages, part, true)
  }

  if (event === "tool" && p.tool_name) {
    return updateToolById(messages, id, t => ({
      ...t,
      trail: [...(t.trail ?? []), { name: p.tool_name!, preview: p.tool_preview }],
      preview: p.tool_preview ? `${p.tool_name}: ${p.tool_preview}` : p.tool_name,
    }))
  }

  if (event === "complete") {
    const tokens = (p.input_tokens ?? 0) + (p.output_tokens ?? 0)
    const extra = tokens ? ` · ${(tokens / 1000).toFixed(1)}k tok` : ""
    return updateToolById(messages, id, t => ({
      ...t,
      status: (p.status === "failed" ? "error" : "done") as ToolPart["status"],
      duration: p.duration_seconds ? p.duration_seconds * 1000 : (t.startedAt ? Date.now() - t.startedAt : undefined),
      result: p.summary ? p.summary + extra : undefined,
      preview: t.goal ?? t.preview,
    }))
  }

  // thinking / progress — surface transient text on the row.
  return updateToolById(messages, id, t => ({ ...t, preview: p.text ?? t.preview }))
}
