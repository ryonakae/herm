import { describe, expect, test } from "bun:test"
import { turnReducer, initialTurn, transcriptToMessages, type Action, type TurnState } from "../src/app/turnReducer"
import type { Part, ToolPart } from "../src/types/message"

function run(actions: Action[]): TurnState {
  return actions.reduce(turnReducer, initialTurn)
}

function last(s: TurnState) { return s.messages[s.messages.length - 1] }
function kinds(parts: Part[]) { return parts.map(p => p.type) }

describe("turnReducer", () => {
  test("delta accumulates into one streaming text part", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "message.delta", chunk: "hel" },
      { kind: "message.delta", chunk: "lo" },
    ])
    expect(s.streaming).toBe(true)
    const m = last(s)
    expect(m.role).toBe("assistant")
    expect(m.parts).toHaveLength(1)
    expect(m.parts[0]).toMatchObject({ type: "text", content: "hello", streaming: true })
  })

  test("tool.start seals open text; text→tool→text yields three parts in order", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "message.delta", chunk: "before " },
      { kind: "tool.start", id: "t1", name: "read_file" },
      { kind: "tool.complete", id: "t1", summary: "ok" },
      { kind: "message.delta", chunk: "after" },
    ])
    const parts = last(s).parts
    expect(kinds(parts)).toEqual(["text", "tool", "text"])
    expect(parts[0]).toMatchObject({ content: "before ", streaming: false })
    expect(parts[1]).toMatchObject({ id: "t1", status: "done", preview: "ok" })
    expect(parts[2]).toMatchObject({ content: "after", streaming: true })
  })

  test("complete seals trailing stream and attaches usage", () => {
    const usage = { input: 10, output: 5, total: 15 }
    const s = run([
      { kind: "message.start" },
      { kind: "message.delta", chunk: "hi" },
      { kind: "message.complete", usage },
    ])
    expect(s.streaming).toBe(false)
    const m = last(s)
    expect(m.usage).toEqual(usage)
    expect(m.parts[0]).toMatchObject({ content: "hi", streaming: false })
  })

  test("complete with no prior delta creates assistant from final text", () => {
    const s = run([
      { kind: "user", text: "q" },
      { kind: "message.start" },
      { kind: "message.complete", text: "answer" },
    ])
    expect(last(s).role).toBe("assistant")
    expect(last(s).parts[0]).toMatchObject({ type: "text", content: "answer", streaming: false })
  })

  test("tool.progress updates most-recently-started running tool", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "tool.start", id: "a", name: "terminal" },
      { kind: "tool.start", id: "b", name: "terminal" },
      { kind: "tool.progress", name: "terminal", preview: "running b" },
    ])
    const tools = last(s).parts.filter((p): p is ToolPart => p.type === "tool")
    expect(tools[0].preview).toBeUndefined()
    expect(tools[1].preview).toBe("running b")
  })

  test("tool.complete error → status=error", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "tool.start", id: "t1", name: "x" },
      { kind: "tool.complete", id: "t1", error: "boom" },
    ])
    expect((last(s).parts[0] as ToolPart).status).toBe("error")
  })

  test("thinking deltas win; reasoning.available is fallback-only", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "thinking", text: "hmm ", final: false },
      { kind: "thinking", text: "more", final: false },
      { kind: "thinking", text: "summary", final: true },
    ])
    expect(last(s).parts[0]).toMatchObject({ type: "thinking", content: "hmm more", streaming: false })
  })

  test("reasoning.available used when no deltas streamed", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "thinking", text: "recovered from last_reasoning", final: true },
    ])
    expect(last(s).parts[0]).toMatchObject({ type: "thinking", content: "recovered from last_reasoning", streaming: false })
  })

  test("thinking after a tool starts a later thinking part", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "thinking", text: "first", final: false },
      { kind: "tool.start", id: "t1", name: "read_file" },
      { kind: "tool.complete", id: "t1", summary: "ok" },
      { kind: "thinking", text: "second", final: false },
    ])
    expect(kinds(last(s).parts)).toEqual(["thinking", "tool", "thinking"])
    expect(last(s).parts[0]).toMatchObject({ type: "thinking", content: "first" })
    expect(last(s).parts[2]).toMatchObject({ type: "thinking", content: "second" })
  })

  test("interrupt.notice dedupes consecutive identical notices", () => {
    const s = run([
      { kind: "interrupt.notice", text: "press esc" },
      { kind: "interrupt.notice", text: "press esc" },
    ])
    expect(s.messages).toHaveLength(1)
  })

  test("error aborts streaming and appends system message", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "message.delta", chunk: "partial" },
      { kind: "error", text: "gateway died" },
    ])
    expect(s.streaming).toBe(false)
    expect(last(s).role).toBe("system")
    const p = last(s).parts[0]
    expect(p.type === "text" && p.content).toContain("gateway died")
  })

  test("reset clears everything", () => {
    const s = run([
      { kind: "user", text: "x" },
      { kind: "message.delta", chunk: "y" },
      { kind: "reset" },
    ])
    expect(s).toEqual(initialTurn)
  })
})

describe("transcriptToMessages", () => {
  test("string content → text part verbatim", () => {
    const ms = transcriptToMessages([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ])
    expect(ms).toHaveLength(2)
    expect(ms[0].parts[0]).toMatchObject({ type: "text", content: "hi" })
    expect(ms[1].parts[0]).toMatchObject({ type: "text", content: "hello" })
  })

  test("native-mode parts-list user turn → text fragments joined", () => {
    // What hermes-agent's native image routing writes to state.db (minus
    // the image_url entries which are base64 data URLs — no path to
    // recover). The leading {type:text} fragment is what we emit as
    // `withMedia` on the wire, so MEDIA: paths survive the round-trip.
    const ms = transcriptToMessages([{
      role: "user",
      text: [
        { type: "text", text: "MEDIA:/tmp/shot.png\ndescribe this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR…" } },
      ],
    }])
    expect(ms).toHaveLength(1)
    expect(ms[0].parts[0]).toMatchObject({
      type: "text",
      content: "MEDIA:/tmp/shot.png\ndescribe this",
    })
  })

  test("parts-list with no text fragment → row dropped, not rendered as [object]", () => {
    const ms = transcriptToMessages([
      { role: "user", text: [{ type: "image_url", image_url: { url: "data:…" } }] },
      { role: "assistant", text: "see above" },
    ])
    // Only the assistant survives — the user row flattens to empty and
    // is filtered out rather than rendering "[object Object]" or crashing.
    expect(ms).toHaveLength(1)
    expect(ms[0].role).toBe("assistant")
  })

  test("multiple text fragments join on newlines", () => {
    const ms = transcriptToMessages([{
      role: "user",
      text: [
        { type: "text", text: "first" },
        { type: "image_url", image_url: { url: "data:…" } },
        { type: "text", text: "second" },
      ],
    }])
    expect(ms[0].parts[0]).toMatchObject({ content: "first\nsecond" })
  })

  test("tool + system rows without matching assistant call are ignored", () => {
    const ms = transcriptToMessages([
      { role: "system", text: "sys" },
      { role: "tool", name: "read_file", context: "/etc/hosts" },
      { role: "user", text: "hi" },
    ])
    expect(ms).toHaveLength(1)
    expect(ms[0].role).toBe("user")
  })

  test("assistant tool_calls + tool rows restore tool parts on resume", () => {
    const ms = transcriptToMessages([
      { role: "user", text: "build it" },
      {
        role: "assistant",
        tool_calls: JSON.stringify([{
          id: "call-1",
          function: { name: "terminal", arguments: JSON.stringify({ command: "bun run build", timeout: 120 }) },
        }]),
      },
      { role: "tool", tool_call_id: "call-1", text: "{\"output\":\"ok\"}" },
      { role: "assistant", text: "done" },
    ])
    expect(ms).toHaveLength(2)
    expect(ms[1].role).toBe("assistant")
    expect(ms[1].parts).toHaveLength(2)
    expect(ms[1].parts[0]).toMatchObject({
      type: "tool", id: "call-1", name: "terminal", status: "done", preview: "bun run build",
      result: "{\"output\":\"ok\"}",
    })
    expect(ms[1].parts[1]).toMatchObject({ type: "text", content: "done" })
  })

  test("plaintext reasoning restores a thinking part before text", () => {
    const ms = transcriptToMessages([{
      role: "assistant",
      reasoning_content: "I should inspect first.",
      text: "I checked it.",
    }])
    expect(ms).toHaveLength(1)
    expect(ms[0].parts[0]).toMatchObject({
      type: "thinking", content: "I should inspect first.", streaming: false,
    })
    expect(ms[0].parts[1]).toMatchObject({ type: "text", content: "I checked it." })
  })

  test("raw content column is accepted when text is absent", () => {
    const ms = transcriptToMessages([
      { role: "user", content: "hi from db" },
      { role: "assistant", content: "hello from db" },
    ])
    expect(ms[0].parts[0]).toMatchObject({ type: "text", content: "hi from db" })
    expect(ms[1].parts[0]).toMatchObject({ type: "text", content: "hello from db" })
  })
})
