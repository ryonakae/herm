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
      {
        type: "tool", id: "t3", name: "patch", args: "",
        preview: "  ┊ review diff", status: "done", duration: 34,
        diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
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
    expect(f).toContain("terminal · read_file · patch") // trail badge
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
    expect(f).toContain("▸ 3 tools")
    expect(f).toContain("▸ review diff")
    expect(f).not.toContain("┊ review diff")
    const rows = f.split("\n")
    const first = rows.findIndex(l => l.includes("▸ 1 reasoning"))
    const msg = rows.findIndex(l => l.includes("First message."))
    const tool = rows.findIndex((l, i) => i > msg && l.includes("▸ 3 tools"))
    const next = rows.findIndex((l, i) => i > tool && l.includes("▸ 1 reasoning"))
    const text = rows.findIndex(l => l.includes("Build is green."))
    expect(first).toBeGreaterThan(-1)
    expect(rows[first - 1]?.trim()).toBe("│")
    expect(rows[first + 1]?.trim()).toBe("│")
    expect(msg).toBe(first + 2)
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
    expect(f).toContain("▾ 3 tools")
    expect(f).not.toContain("Thinking")
    expect(f).not.toContain("Tool calls")
    expect(f).toContain("thinking out loud")
    expect(f).toContain("now reviewing output")
    expect(f).toContain("$ bun run build")
    expect(f).toContain("Read src/index.tsx")
    t.destroy()
  })

  test("open tool block leaves one blank row before following text", async () => {
    preferences.set("thoughtDisplay", "inline")
    preferences.set("thoughtInlineDefaultOpen", true)
    const msg: Message[] = [{
      id: "a2", role: "assistant", timestamp: 0, model: "test-model",
      parts: [
        { type: "tool", id: "a", name: "terminal", args: "", preview: "one", status: "done" },
        { type: "tool", id: "b", name: "terminal", args: "", preview: "two", status: "done" },
        { type: "text", content: "After tools.", streaming: false },
      ],
    }]
    const t = await mountNode(
      <box flexDirection="column" width="100%" height="100%">
        <MessageList messages={msg} streaming={false} />
      </box>,
      { width: 120, height: 20 },
    )
    await until(t, () => t.frame().includes("After tools."))
    const rows = t.frame().split("\n")
    const two = rows.findIndex(l => l.includes("$ two"))
    const text = rows.findIndex(l => l.includes("After tools."))
    expect(two).toBeGreaterThan(-1)
    expect(rows[two + 1]?.trim()).toBe("│")
    expect(text).toBe(two + 2)
    t.destroy()
  })
})
