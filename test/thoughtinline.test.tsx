import { afterEach, describe, expect, test } from "bun:test"
import { mountNode, until } from "./harness"
import { MessageList } from "../src/components/chat/MessageList"
import * as preferences from "../src/utils/preferences"
import type { Message } from "../src/types/message"

const turn: Message[] = [
  {
    id: "u1", role: "user", timestamp: 0,
    parts: [{ type: "text", content: "explain & build", streaming: false }],
  },
  {
    id: "a1", role: "assistant", timestamp: 0, model: "test-model",
    parts: [
      { type: "thinking", content: "thinking out loud about the build", streaming: false, key: "th-1" },
      { type: "text", content: "First message.\n", streaming: false },
      {
        type: "tool", id: "t1", name: "terminal", args: "",
        preview: "bun run build", status: "done", duration: 87,
      },
      {
        type: "tool", id: "t2", name: "read_file", args: "",
        preview: "src/index.tsx", status: "done", duration: 12,
      },
      { type: "thinking", content: "now reviewing output", streaming: false, key: "th-2" },
      { type: "text", content: "Build is green.", streaming: false },
    ],
  },
]

afterEach(() => {
  preferences.set("thoughtDisplay", undefined)
  preferences.set("thoughtInlineDefaultOpen", undefined)
})

describe("MessageList / thoughtDisplay", () => {
  test("off (default): trail badge shows, no summary line", async () => {
    const t = await mountNode(
      <box flexDirection="column" width="100%" height="100%">
        <MessageList messages={turn} streaming={false} />
      </box>,
      { width: 120, height: 30 },
    )
    await until(t, () => t.frame().includes("Build is green."))
    const f = t.frame()
    expect(f).toContain("terminal · read_file") // trail badge
    expect(f).not.toContain("reasoning")        // summary line absent
    expect(f).not.toContain("thinking out loud")
    t.destroy()
  })

  test("on, closed by default: inline runs stay chronological and bodies hidden", async () => {
    preferences.set("thoughtDisplay", "inline")
    const t = await mountNode(
      <box flexDirection="column" width="100%" height="100%">
        <MessageList messages={turn} streaming={false} />
      </box>,
      { width: 120, height: 30 },
    )
    await until(t, () => t.frame().includes("Build is green."))
    const f = t.frame()
    expect(f).toContain("▸ 1 reasoning")
    expect(f).toContain("▸ 2 tools")
    const rows = f.split("\n")
    const first = rows.findIndex(l => l.includes("▸ 1 reasoning"))
    const msg = rows.findIndex(l => l.includes("First message."))
    const tool = rows.findIndex((l, i) => i > msg && l.includes("▸ 2 tools"))
    const next = rows.findIndex((l, i) => i > tool && l.includes("▸ 1 reasoning"))
    const text = rows.findIndex(l => l.includes("Build is green."))
    expect(first).toBeGreaterThan(-1)
    expect(msg).toBeGreaterThan(first)
    expect(tool).toBeGreaterThan(msg)
    expect(next).toBeGreaterThan(tool)
    expect(text).toBeGreaterThan(next)
    expect(f).not.toContain("terminal · read_file") // trail badge suppressed
    expect(f).not.toContain("thinking out loud")    // closed
    t.destroy()
  })

  test("on with defaultOpen: each chronological run opens independently", async () => {
    preferences.set("thoughtDisplay", "inline")
    preferences.set("thoughtInlineDefaultOpen", true)
    const t = await mountNode(
      <box flexDirection="column" width="100%" height="100%">
        <MessageList messages={turn} streaming={false} />
      </box>,
      { width: 120, height: 30 },
    )
    await until(t, () => t.frame().includes("Build is green."))
    const f = t.frame()
    expect(f).toContain("▾ 1 reasoning")
    expect(f).toContain("▾ 2 tools")
    expect(f).toContain("thinking out loud")
    expect(f).toContain("now reviewing output")
    expect(f).toContain("$ bun run build")
    expect(f).toContain("Read src/index.tsx")
    t.destroy()
  })
})
