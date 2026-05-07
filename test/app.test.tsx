import { describe, expect, test, spyOn } from "bun:test"
import { act } from "react"
import { mount, until, MockGateway } from "./harness"
import * as prefs from "../src/utils/preferences"
import * as exit from "../src/app/exit"
import { DOUBLE_TAB_MS } from "../src/app/useAppKeys"
import type { GatewayEvent } from "../src/utils/gateway-types"

describe("app", () => {
  test("boots and renders chat tab with status bar", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    const f = t.frame()
    expect(f).toContain("Chat")            // tab bar
    expect(f).toContain("test-model")      // status bar from session.info
    expect(f).toContain("Message Hermes")  // composer placeholder
    // boot() resumes lastSessionId if set by an earlier test, else creates
    expect(t.gw.last("session.create") ?? t.gw.last("session.resume")).toBeDefined()

    t.destroy()
  })

  test("shows compact session metadata when sidebar is hidden", async () => {
    const t = await mount({ width: 100, height: 30 })
    await until(t, () => t.frame().includes("● Ready · default · test-model"))
    const f = t.frame()

    expect(f).toContain("~/d/herm")
    expect(f).not.toContain("profile default")
    expect(f).not.toContain("model test-model")
    expect(f).not.toContain("cwd ")
    expect(f).not.toContain("branch ")
    t.destroy()
  })

  test("hides transient thinking status text under the composer", async () => {
    const t = await mount({ width: 100, height: 30 })
    await until(t, () => t.frame().includes("Ready"))
    t.gw.push({ type: "message.start" })
    t.gw.push({ type: "thinking.delta", payload: { text: "(*´ω｀*) Thinking..." } })
    await t.settle()

    expect(t.frame()).not.toContain("Thinking...")
    expect(t.frame()).not.toContain("Generating...")
    t.destroy()
  })

  test("ctrl+left/right switches tabs", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    // Chat is index 0; ctrl+left should clamp (no Overview anymore)
    act(() => t.keys.pressArrow("left", { ctrl: true }))
    await t.settle()
    expect(t.frame()).toContain("Message Hermes")

    // → Sessions (index 2)
    act(() => { for (let i = 0; i < 2; i++) t.keys.pressArrow("right", { ctrl: true }) })
    // Sandboxed HERMES_HOME has no state.db → empty state
    await until(t, () => t.frame().includes("No sessions"))

    t.destroy()
  })

  test("<leader> <digit> jumps directly to tab N", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    // Tab bar shows index prefixes.
    expect(t.frame()).toMatch(/1 Chat.*2 Context.*3 Sessions/)

    act(() => { t.keys.pressKey("x", { ctrl: true }); t.keys.pressKey("3") })
    await until(t, () => t.frame().includes("No sessions"))

    act(() => { t.keys.pressKey("x", { ctrl: true }); t.keys.pressKey("0") })
    await until(t, () => t.frame().includes("Env / API Keys"))
    // Focus landed on content: arrow moves Env selection, doesn't type.
    act(() => t.keys.pressArrow("down"))
    await t.settle()
    const sel = t.frame().split("\n").find(l => l.includes("▸"))!
    expect(sel).not.toMatch(/LLM Providers/)

    act(() => { t.keys.pressKey("x", { ctrl: true }); t.keys.pressKey("1") })
    await t.settle()
    expect(t.frame()).toContain("Message Hermes")
    t.destroy()
  })

  test("user keybind override that collides surfaces a system-line warning", async () => {
    // agents.kill → 'r' collides with list.refresh (list↔agents overlap).
    prefs.set("keys", { "agents.kill": "r" })
    const t = await mount()
    await until(t, () => t.frame().includes("Keybinding conflict"))
    expect(t.frame()).toMatch(/R → .*list\.refresh.*agents\.kill|R → .*agents\.kill.*list\.refresh/)
    t.destroy()
  })

  test("Ctrl+C: non-empty buffer clears; empty buffer quits (oc parity)", async () => {
    const q = spyOn(exit, "quit").mockImplementation((() => {}) as never)
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("draft text") })
    await t.settle()
    expect(t.frame()).toContain("> draft text")

    act(() => t.keys.pressKey("c", { ctrl: true }))
    await t.settle()
    expect(t.frame()).not.toContain("draft text")
    expect(t.frame()).toContain("Message Hermes")
    expect(q).not.toHaveBeenCalled()

    act(() => t.keys.pressKey("c", { ctrl: true }))
    await t.settle()
    expect(q).toHaveBeenCalledTimes(1)
    // sid arg threaded from session state.
    expect(q.mock.calls[0]?.[1]).toBe("test-sid")

    q.mockRestore()
    t.destroy()
  })

  test("tab.next rebind via preferences.keys is honored end-to-end", async () => {
    prefs.set("keys", { "tab.next": "ctrl+]", "tab.prev": "ctrl+[" })
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    // Default chord no longer switches.
    act(() => t.keys.pressArrow("right", { ctrl: true }))
    await t.settle()
    expect(t.frame()).toContain("Message Hermes")

    // Rebound chord does.
    act(() => { t.keys.pressKey("]", { ctrl: true }); t.keys.pressKey("]", { ctrl: true }) })
    await until(t, () => t.frame().includes("No sessions"))

    act(() => t.keys.pressKey("[", { ctrl: true }))
    await t.settle()
    act(() => t.keys.pressKey("[", { ctrl: true }))
    await t.settle()
    expect(t.frame()).toContain("Message Hermes")

    t.destroy()
  })

  test("<leader>e opens external editor (leader path through the full app)", async () => {
    // Seed $EDITOR so editInEditor doesn't early-return; it will spawn
    // `true` which exits 0 without writing — the temp file keeps its seed.
    const prev = process.env.EDITOR
    process.env.EDITOR = "true"
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("seed text") })
    await t.settle()
    // Ctrl+X arms leader; provider blurs the composer textarea so 'e'
    // reaches useAppKeys' match("editor.open") instead of typing.
    act(() => t.keys.pressKey("x", { ctrl: true }))
    await t.settle()
    await act(async () => { await t.keys.typeText("e") })
    // editInEditor suspends the renderer; settle until it resumes and
    // re-seeds. The composer should NOT contain a stray 'e'.
    await until(t, () => t.frame().includes("> seed text"), 3000)
    expect(t.frame()).not.toContain("seed texte")

    process.env.EDITOR = prev
    t.destroy()
  })

  test("tab nav hands focus to content; keys reach the tab", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    // Ctrl+→ to Env (index 9). Land on content, not the composer.
    act(() => { for (let i = 0; i < 9; i++) t.keys.pressArrow("right", { ctrl: true }) })
    await t.settle()
    await until(t, () => t.frame().includes("Env / API Keys"))
    expect(t.frame()).not.toContain("Env (searching)")

    // Arrow down moves the row cursor (off the first header, onto row 1).
    act(() => t.keys.pressArrow("down"))
    await t.settle()
    const top = t.frame().split("\n").find(l => l.includes("▸"))!
    expect(top).not.toMatch(/LLM Providers/)

    // `/` is an Env keybind — it must reach Env, not the composer's slash
    // popover. If the shell were still bouncing printable chars to input,
    // this would open the popover instead of flipping Env to search mode.
    await act(async () => { await t.keys.typeText("/") })
    await t.settle()
    expect(t.frame()).toContain("Env (searching)")

    t.destroy()
  })

  test("non-Chat: double-Tab focuses composer; single Tab stays", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    act(() => { for (let i = 0; i < 9; i++) t.keys.pressArrow("right", { ctrl: true }) })
    await until(t, () => t.frame().includes("Env / API Keys"))

    // Single Tab: content keeps focus (arrow still moves selection).
    act(() => t.keys.pressTab())
    await t.settle()
    act(() => t.keys.pressArrow("down"))
    await t.settle()
    const sel = t.frame().split("\n").find(l => l.includes("▸"))!
    expect(sel).not.toMatch(/LLM Providers/)

    // Slow second Tab (>400ms) is still "single".
    await Bun.sleep(DOUBLE_TAB_MS + 20)
    act(() => t.keys.pressTab())
    await t.settle()
    await act(async () => { await t.keys.typeText("x") })
    await t.settle()
    // Composer didn't receive the "x" (prefix is `> ` then value).
    expect(t.frame()).not.toMatch(/> x/)
    expect(t.gw.last("prompt.submit")).toBeUndefined()

    // Double-Tab: composer grabs focus — typing now goes into the input.
    await Bun.sleep(DOUBLE_TAB_MS + 20)
    act(() => { t.keys.pressTab(); t.keys.pressTab() })
    await t.settle()
    await act(async () => { await t.keys.typeText("hi env") })
    act(() => t.keys.pressEnter())
    await t.settle()
    expect(t.gw.last("prompt.submit")?.params.text).toBe("hi env")

    t.destroy()
  })

  test("Chat: typing with transcript focused bounces back to composer", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    // Tab moves focus to the transcript, then any letter bounces back.
    act(() => t.keys.pressTab())
    await t.settle()
    await act(async () => { await t.keys.typeText("h") })
    await t.settle()
    await act(async () => { await t.keys.typeText("ey") })
    act(() => t.keys.pressEnter())
    await t.settle()

    // First char flips focus AND lands in the buffer — nothing swallowed.
    expect(t.gw.last("prompt.submit")?.params.text).toBe("hey")

    t.destroy()
  })

  test("sidebar hides below 120 cols", async () => {
    const t = await mount({ width: 160, height: 48 })
    await until(t, () => t.frame().includes("Ready"))
    // Sidebar renders the Profile row as the identity header.
    expect(t.frame()).toMatch(/Profile\s+default/)

    t.resize(100, 48)
    await t.settle(); await t.settle()
    expect(t.frame()).not.toMatch(/Profile\s+default/)

    t.resize(160, 48)
    await t.settle(); await t.settle()
    expect(t.frame()).toMatch(/Profile\s+default/)
    t.destroy()
  })

  test("non-Chat tab: sidebar yields before detail pane (130 cols)", async () => {
    const gw = new MockGateway({ "session.list": () => ({ sessions: [
      { id: "a", title: "X", preview: "", message_count: 1, started_at: 1700000000, source: "tui" },
    ]}) })
    const t = await mount({ gw, width: 130, height: 40 })
    await until(t, () => t.frame().includes("Ready"))
    // Chat tab: sidebar visible at 130.
    expect(t.frame()).toMatch(/Profile\s+default/)

    act(() => { t.keys.pressKey("x", { ctrl: true }); t.keys.pressKey("3") })
    await until(t, () => t.frame().includes("Sessions (1)"))
    // Sidebar dropped, detail pane kept.
    expect(t.frame()).not.toMatch(/Profile\s+default/)
    expect(t.frame()).toContain("Session Detail")
    t.destroy()
  })

  test("gateway stream renders into transcript", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    const feed: GatewayEvent[] = [
      { type: "message.start" },
      { type: "message.delta", payload: { text: "stream chunk one" } },
      { type: "message.complete", payload: { text: "stream chunk one", usage: { input: 3, output: 5, total: 8 } } },
    ]
    act(() => { for (const ev of feed) t.gw.push(ev) })
    // markdown renders async (tree-sitter) — poll until it lands
    await until(t, () => t.frame().includes("stream chunk one"), 3000)

    const f = t.frame()
    expect(f).toContain("│")        // assistant gutter bar
    expect(f).toContain("3→5 tok")  // usage in header

    t.destroy()
  })

  test("typing + Enter sends prompt.submit and echoes user message", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("hello gateway") })
    await t.settle()
    expect(t.frame()).toContain("hello gateway")  // visible in input

    act(() => t.keys.pressEnter())
    await t.settle()

    const call = t.gw.last("prompt.submit")
    expect(call?.params.text).toBe("hello gateway")
    // User messages render inside a left-side gutter.
    expect(t.frame()).toMatch(/│  hello gateway/)

    t.destroy()
  })

  test("approval.request renders inline in transcript; 1 → once, Esc → deny", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    // Need an assistant turn for the prompt part to attach to.
    await act(async () => { await t.keys.typeText("go") })
    act(() => t.keys.pressEnter())
    act(() => t.gw.push({ type: "message.start" }))
    act(() => t.gw.push({
      type: "approval.request",
      payload: { command: "rm -rf /", description: "delete everything" },
    }))
    await until(t, () => t.frame().includes("Permission required"))

    // Card is in the transcript, not a dialog: no backdrop box.
    expect(t.frame()).toContain("$ rm -rf /")
    expect(t.frame()).toContain("┃")

    // '1' → Allow once on the wire, card collapses (cloud reopens
    // as the agent resumes, occluding the outcome row — assert via
    // wire + pending-gone, not frame text).
    await act(async () => { await t.keys.typeText("1") })
    await until(t, () => t.gw.last("approval.respond")?.params.choice === "once")
    await until(t, () => !t.frame().includes("Permission required"))

    // Second approval in the same turn → fresh card; Esc denies it.
    act(() => t.gw.push({
      type: "approval.request",
      payload: { command: "cat /etc/shadow", description: "" },
    }))
    await until(t, () => t.frame().includes("Permission required"))
    act(() => t.keys.pressEscape())
    await until(t, () => t.gw.last("approval.respond")?.params.choice === "deny")
    await until(t, () => !t.frame().includes("Permission required"))

    // Close the cloud; both outcome rows persist in the transcript.
    act(() => t.gw.push({ type: "message.complete", payload: { text: "", usage: { input: 0, output: 0, total: 0 } } }))
    await until(t, () => t.frame().includes("✓ Allow once"))
    expect(t.frame()).toContain("✗ Deny")

    t.destroy()
  })

  test("inline prompt Esc does not arm interrupt; tab-nav still works (no backdrop)", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    // Enter streaming, then an approval arrives.
    await act(async () => { await t.keys.typeText("go") })
    act(() => t.keys.pressEnter())
    act(() => t.gw.push({ type: "message.start" }))
    await until(t, () => t.frame().includes("Type to queue"))
    act(() => t.gw.push({
      type: "approval.request",
      payload: { command: "rm x", description: "" },
    }))
    await until(t, () => t.frame().includes("Permission required"))

    // Unlike the old dialog, tab-nav is NOT blocked — the prompt is
    // in the transcript, not an overlay. But it snaps back to Chat
    // on arrival and that's where the card lives.
    expect(t.frame()).toContain("1 Chat")

    // Esc denies the prompt and does NOT arm interrupt (card.feed
    // consumed it and stopPropagation'd).
    act(() => t.keys.pressEscape())
    await until(t, () => !t.frame().includes("Permission required"))
    expect(t.gw.last("approval.respond")?.params.choice).toBe("deny")
    expect(t.gw.last("session.interrupt")).toBeUndefined()

    // Now the prompt is gone; next two Escapes arm + fire normally.
    act(() => t.keys.pressEscape())
    await t.settle()
    expect(t.gw.last("session.interrupt")).toBeUndefined()
    act(() => t.keys.pressEscape())
    await until(t, () => t.gw.last("session.interrupt") !== undefined)

    t.destroy()
  })

  test("clarify.request with choices; number-key picks; outcome persists", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    await act(async () => { await t.keys.typeText("go") })
    act(() => t.keys.pressEnter())
    act(() => t.gw.push({ type: "message.start" }))
    act(() => t.gw.push({
      type: "clarify.request",
      payload: { request_id: "c1", question: "which one?", choices: ["red", "blue"] },
    }))
    await until(t, () => t.frame().includes("which one?"))
    expect(t.frame()).toContain("1. red")
    expect(t.frame()).toContain("2. blue")

    await act(async () => { await t.keys.typeText("2") })
    await until(t, () => t.gw.last("clarify.respond") !== undefined)
    expect(t.gw.last("clarify.respond")?.params).toMatchObject({ request_id: "c1", answer: "blue" })
    // Outcome persists after turn ends.
    act(() => t.gw.push({ type: "message.complete", payload: { text: "ok", usage: { input: 0, output: 0, total: 0 } } }))
    await until(t, () => t.frame().includes("chose: blue"))
    t.destroy()
  })

  test("secret.request defocuses composer; masked input never echoes", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    await act(async () => { await t.keys.typeText("go") })
    act(() => t.keys.pressEnter())
    act(() => t.gw.push({ type: "message.start" }))
    act(() => t.gw.push({
      type: "secret.request",
      payload: { request_id: "s1", prompt: "enter key", env_var: "API_KEY" },
    }))
    await until(t, () => t.frame().includes("Secret: API_KEY"))

    // Type a secret — it must NOT appear in the frame; bullets do.
    for (const c of "hunter2") await act(async () => { await t.keys.typeText(c) })
    await t.settle()
    expect(t.frame()).not.toContain("hunter2")
    expect(t.frame()).toContain("•••••••")

    act(() => t.keys.pressEnter())
    await until(t, () => t.gw.last("secret.respond") !== undefined)
    expect(t.gw.last("secret.respond")?.params).toMatchObject({ request_id: "s1", value: "hunter2" })
    act(() => t.gw.push({ type: "message.complete", payload: { text: "", usage: { input: 0, output: 0, total: 0 } } }))
    await until(t, () => t.frame().includes("(provided)"))
    // Composer refocuses once the masked prompt clears.
    expect(t.frame()).toContain("Message Hermes")
    t.destroy()
  })

  test("slash popover opens on '/' and Enter dispatches local command", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/model", "Switch model"]] }),
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/") })
    await t.settle()
    expect(t.frame()).toContain("/clear")  // local command in popover

    await act(async () => { await t.keys.typeText("cle") })
    await t.settle()
    act(() => t.keys.pressEnter())
    await t.settle()

    // /clear is local — no gateway call, transcript cleared, popover closed
    expect(t.gw.last("slash.exec")).toBeUndefined()
    expect(t.frame()).not.toContain("/clear")

    t.destroy()
  })

  test("/title <arg> sets via session.title RPC", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/title my overnight run") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Title: my overnight run")) // system line

    expect(t.gw.last("session.title")?.params.title).toBe("my overnight run")
    expect(t.gw.last("prompt.submit")).toBeUndefined() // intercepted
    t.destroy()
  })

  test("send() routes arg-bearing slash via resolve(): unique prefix, gateway arg, ambiguous, miss", async () => {
    const t = await mount({ handlers: {
      "commands.catalog": () => ({
        pairs: [["/reasoning", "set reasoning"], ["/personality", "switch"], ["/persona", "fake"]],
        sub: {}, canon: {}, categories: [],
      }),
      "slash.exec": p => ({ output: `ran ${p.command}` }),
    }})
    await until(t, () => t.frame().includes("Ready"))

    // unique prefix → canonical gateway dispatch with arg
    await act(async () => { await t.keys.typeText("/reaso high") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.gw.last("slash.exec") !== undefined)
    expect(t.gw.last("slash.exec")?.params.command).toBe("/reasoning high")
    expect(t.gw.last("prompt.submit")).toBeUndefined()

    // ambiguous → system line, no dispatch
    await act(async () => { await t.keys.typeText("/person x") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("ambiguous:"))
    expect(t.frame()).toContain("/persona")
    expect(t.frame()).toContain("/personality")

    // miss → falls through to prompt.submit verbatim (path-like arg)
    await act(async () => { await t.keys.typeText("/etc/hosts please") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.gw.last("prompt.submit") !== undefined)
    expect(t.gw.last("prompt.submit")?.params.text).toBe("/etc/hosts please")
    t.destroy()
  })

  test("gateway catalog commands appear in popover; filter matches bare name", async () => {
    // Regression: gateway sends slash-prefixed names + {name,pairs} categories;
    // old parser stored "/model" verbatim → filter("mo") never matched and
    // category enrichment was a no-op (wrong key shape).
    const gw = new MockGateway({
      "commands.catalog": () => ({
        pairs: [["/model", "Switch model"], ["/retry", "Retry last"]],
        categories: [{ name: "Configuration", pairs: [["/model", "Switch model"]] }],
        canon: { "/m": "/model" },
        sub: { "/model": ["list"] },
      }),
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/") })
    await until(t, () => t.frame().includes("/clear"))

    // filter by prefix — would fail if names still carried leading "/"
    await act(async () => { await t.keys.typeText("mo") })
    await until(t, () => t.frame().includes("/model"))
    expect(t.frame()).toContain("Configuration") // category header from pairs shape
    expect(t.frame()).not.toContain("/retry")
    expect(t.frame()).not.toContain("/clear")
    t.destroy()
  })

  test("popover survives tab round-trip (z-order regression)", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/") })
    await until(t, () => t.frame().includes("/clear"))

    act(() => t.keys.pressArrow("right", { ctrl: true }))
    await t.settle()
    act(() => t.keys.pressArrow("left", { ctrl: true }))
    await t.settle(); await t.settle()

    // Content tab remounted after Composer in the parent's paint order;
    // without zIndex on the composer container it overdraws the absolute
    // popover. Popover must still be visible.
    expect(t.frame()).toContain("/clear")
    t.destroy()
  })

  test("failed MCP servers surface as system line on ready", async () => {
    const gw = new MockGateway()
    const t = await mount({ gw })
    // gateway.ready already fired in start(); push a session.info with servers
    act(() => gw.push({
      type: "session.info",
      payload: {
        model: "test-model", session_id: "test-sid", tools: {}, skills: {},
        mcp_servers: [
          { name: "goodsrv", transport: "stdio", tools: 5, connected: true },
          { name: "badsrv", transport: "http", tools: 0, connected: false, error: "ECONNREFUSED" },
        ],
      },
    }))
    await until(t, () => t.frame().includes("MCP:"))
    const f = t.frame()
    expect(f).toContain("1 server(s) failed")
    expect(f).toContain("badsrv (ECONNREFUSED)")
    expect(f).not.toContain("goodsrv (") // good one not listed in failure line
    // sidebar MCP section appears (collapsed) with hint
    expect(f).toContain("▸ MCP")
    expect(f).toContain("1/2 up")
    t.destroy()
  })

  test("gateway slash matching a tab name jumps to that tab", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/skills", "Manage skills"], ["/model", "Switch model"]] }),
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/skills") })
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Skills ("))
    // intercepted as tab jump — never hit the slash worker
    expect(t.gw.last("slash.exec")).toBeUndefined()
    expect(t.gw.last("prompt.submit")).toBeUndefined()
    t.destroy()
  })

  test("sidebar shows Profile row", async () => {
    const t = await mount({ width: 160 })
    await until(t, () => t.frame().includes("Hermes"))
    // preload.ts sets HERMES_HOME to a sandbox that isn't under profiles/
    expect(t.frame()).toMatch(/Profile\s+default/)
    t.destroy()
  })

  // d2o.3: <leader>b toggles sidebar visibility independent of width.
  test("<leader>b toggles the sidebar", async () => {
    const t = await mount({ width: 160 })
    await until(t, () => t.frame().includes("Ready"))
    expect(t.frame()).toMatch(/Profile\s+default/)

    // Arm leader, then 'b' → hide
    act(() => t.keys.pressKey("x", { ctrl: true }))
    await t.settle()
    await act(async () => { await t.keys.typeText("b") })
    await t.settle()
    expect(t.frame()).not.toMatch(/Profile\s+default/)

    // Again → show
    act(() => t.keys.pressKey("x", { ctrl: true }))
    await t.settle()
    await act(async () => { await t.keys.typeText("b") })
    await t.settle()
    expect(t.frame()).toMatch(/Profile\s+default/)
    t.destroy()
  })

  test("agent messages show 'Hermes' as default speaker (not 'assistant')", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    act(() => {
      t.gw.push({ type: "message.start" })
      t.gw.push({ type: "message.delta", payload: { text: "hi there" } })
      t.gw.push({ type: "message.complete", payload: { text: "hi there", status: "complete" } })
    })
    await t.settle()

    const f = t.frame()
    expect(f).toContain("Hermes")
    // The agent row header must not fall back to the literal "assistant".
    // (substring search is safe: no other UI text contains that word.)
    expect(f).not.toMatch(/\bassistant\b/)

    t.destroy()
  })

  test("skin.changed → branding.agent_name replaces 'Hermes' in agent headers", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    act(() => t.gw.push({
      type: "skin.changed",
      payload: { name: "ares", branding: { agent_name: "Ares" } },
    }))
    await t.settle()

    act(() => {
      t.gw.push({ type: "message.start" })
      t.gw.push({ type: "message.delta", payload: { text: "to arms" } })
      t.gw.push({ type: "message.complete", payload: { text: "to arms", status: "complete" } })
    })
    await t.settle()

    expect(t.frame()).toContain("Ares")
    t.destroy()
  })

  test("/save toasts the file path via session.save RPC", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/save", "Save conversation"]] }),
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/save") })
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Saved → /tmp/conv.json"))
    expect(t.gw.last("session.save")).toBeDefined()
    expect(t.gw.last("slash.exec")).toBeUndefined()
    t.destroy()
  })

  test("click user message → action menu → Rewind → N×session.undo → composer seeded", async () => {
    // History after rewind: server-authoritative via session.history.
    const hist = (n: number) => Array.from({ length: n }, (_, i) => ({
      role: i % 2 ? "assistant" : "user", text: `turn${Math.floor(i / 2)}`,
    }))
    let left = 4
    const gw = new MockGateway({
      "session.undo": () => { left = Math.max(0, left - 2); return { removed: 2 } },
      "session.history": () => ({ count: left, messages: hist(left) }),
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    // Two full turns in the transcript.
    for (const msg of ["first q", "second q"]) {
      await act(async () => { await t.keys.typeText(msg) })
      act(() => t.keys.pressEnter())
      await t.settle()
      act(() => {
        gw.push({ type: "message.start" })
        gw.push({ type: "message.complete", payload: { text: `re: ${msg}`, usage: { input: 1, output: 1, total: 2 } } })
      })
      await until(t, () => t.frame().includes(`re: ${msg}`))
    }

    // Click the first user message → action menu. It's under the cloud
    // overlay in a short transcript, so scroll it into view first.
    const row = () => {
      const rows = t.frame().split("\n")
      return rows.findIndex(l => l.includes("first q") && !l.includes("re:") && !l.includes("┇"))
    }
    await act(async () => {
      for (let i = 0; i < 30 && row() < 0; i++) await t.mouse.scroll(20, 20, "up")
    })
    await until(t, () => row() > 0)
    await act(async () => { await t.mouse.click(4, row()) })
    await until(t, () => t.frame().includes("Message Actions"))
    expect(t.frame()).toContain("Rewind here")
    expect(t.frame()).toContain("Fork here")

    // Select Rewind here (↓ from Copy).
    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressEnter())
    // rewind() is async (N×undo + history fetch) — poll for the seed
    await until(t, () => t.frame().includes("> first q"))

    const undos = t.gw.calls.filter(c => c.method === "session.undo").length
    expect(undos).toBe(2)
    expect(t.gw.last("session.history")).toBeDefined()
    expect(t.frame()).not.toContain("second q")
    expect(t.frame()).not.toContain("Message Actions")
    t.destroy()
  })

  test("action menu → Fork → session.branch + undo-in-branch + switch", async () => {
    const gw = new MockGateway({
      "session.branch": () => ({ session_id: "branch-sid", title: "branch 1" }),
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    // One turn so there's something to fork from.
    await act(async () => { await t.keys.typeText("seed q") })
    act(() => t.keys.pressEnter())
    await t.settle()
    act(() => {
      gw.push({ type: "message.start" })
      gw.push({ type: "message.complete", payload: { text: "re: seed q", usage: { input: 1, output: 1, total: 2 } } })
    })
    await until(t, () => t.frame().includes("re: seed q"))

    const rows = t.frame().split("\n")
    const y = rows.findIndex(l => l.includes("seed q") && !l.includes("re:") && !l.includes("┇"))
    await act(async () => { await t.mouse.click(4, y) })
    await until(t, () => t.frame().includes("Message Actions"))

    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("forked → branch 1"))

    expect(t.gw.last("session.branch")).toBeDefined()
    // Undo targets the BRANCH session, not the original.
    const u = t.gw.calls.find(c => c.method === "session.undo")
    expect(u?.params.session_id).toBe("branch-sid")
    // Switched into it.
    expect(t.gw.last("session.resume")?.params.session_id).toBe("branch-sid")
    // Composer seeded.
    expect(t.frame()).toContain("> seed q")
    t.destroy()
  })

  test("queue: Enter while streaming stacks; drains one per idle; <leader>u flushes", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    // Turn 1 starts.
    await act(async () => { await t.keys.typeText("first") })
    act(() => t.keys.pressEnter())
    await t.settle()
    act(() => t.gw.push({ type: "message.start" }))
    await until(t, () => t.frame().includes("Type to queue"))
    expect(t.frame()).not.toContain("send queued now")

    // Queue two follow-ups while streaming.
    for (const msg of ["follow up a", "follow up b"]) {
      await act(async () => { await t.keys.typeText(msg) })
      act(() => t.keys.pressEnter())
      await t.settle()
    }
    await until(t, () => t.frame().includes("⏸ 2. follow up b"))
    expect(t.gw.calls.filter(c => c.method === "prompt.submit").length).toBe(1)
    // Hint appears once something is queued.
    expect(t.frame()).toContain("Ctrl+X U to send queued now")

    // Turn 1 completes → exactly one queued item drains.
    act(() => t.gw.push({ type: "message.complete", payload: { text: "r1", usage: { input: 1, output: 1, total: 2 } } }))
    await until(t, () => t.gw.calls.filter(c => c.method === "prompt.submit").length === 2)
    expect(t.gw.last("prompt.submit")?.params.text).toBe("follow up a")
    act(() => t.gw.push({ type: "message.start" }))
    await until(t, () => t.frame().includes("⏸ 1. follow up b"))
    expect(t.frame()).not.toContain("⏸ 2.")        // one chip left
    expect(t.gw.calls.filter(c => c.method === "prompt.submit").length).toBe(2)

    // <leader>u flushes: interrupt fires, drain effect submits head on
    // the following message.complete.
    act(() => t.keys.pressKey("x", { ctrl: true }))
    await t.settle()
    await act(async () => { await t.keys.typeText("u") })
    await until(t, () => t.gw.calls.some(c => c.method === "session.interrupt"))
    act(() => t.gw.push({ type: "message.complete", payload: { text: "r2", usage: { input: 1, output: 1, total: 2 } } }))
    await until(t, () => t.gw.calls.filter(c => c.method === "prompt.submit").length === 3)
    expect(t.gw.last("prompt.submit")?.params.text).toBe("follow up b")
    act(() => t.gw.push({ type: "message.start" }))
    await until(t, () => !t.frame().includes("⏸ 1."))
    expect(t.frame()).not.toContain("send queued now")

    // Ctrl+U is still the textarea's kill-to-line-start (distinct from <leader>u).
    await act(async () => { await t.keys.typeText("scratch") })
    act(() => t.keys.pressKey("u", { ctrl: true }))
    await t.settle()
    expect(t.frame()).not.toContain("> scratch")

    // Turn 3 completes with empty queue → no further submit.
    act(() => t.gw.push({ type: "message.complete", payload: { text: "r3", usage: { input: 1, output: 1, total: 2 } } }))
    await until(t, () => t.frame().includes("Ready"))
    expect(t.gw.calls.filter(c => c.method === "prompt.submit").length).toBe(3)
    t.destroy()
  })

  test("/usage opens KV dialog populated from session.usage", async () => {
    const gw = new MockGateway({
      "session.usage": () => ({
        model: "test-model", calls: 7, input: 1234, output: 567, total: 1801,
        cache_read: 0, cache_write: 0, cost_usd: 0.0412, cost_status: "estimated",
        context_used: 4200, context_max: 200_000, context_percent: 2,
      }),
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/usage") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("API calls"))

    const f = t.frame()
    expect(f).toContain("Usage")
    expect(f).toContain("7")          // calls
    expect(f).toContain("1.2k")       // input fmt
    expect(f).toContain("$0.04")      // cost
    expect(f).toContain("2%")         // context percent
    expect(f).toContain("estimated")  // cost_status note
    expect(t.gw.last("slash.exec")).toBeUndefined() // intercepted locally

    act(() => t.keys.pressEscape())
    await until(t, () => !t.frame().includes("API calls"))
    t.destroy()
  })

  test("/status dialog reads from cached SessionInfo", async () => {
    const gw = new MockGateway()
    const t = await mount({ gw })
    act(() => gw.push({
      type: "session.info",
      payload: {
        model: "test-model", session_id: "sid-abc", version: "9.9.9",
        cwd: "/workspace", tools: { web: ["a", "b"], file: ["c"] }, skills: {},
      },
    }))
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/status") })
    act(() => t.keys.pressEnter())
    // Predicate must be dialog-only — "Version" also appears in the
    // popover row ("Version, model, paths"), which can already be in
    // the frame at this point if act() outran the 16.67ms render gate,
    // making until() return without settling.
    await until(t, () => t.frame().includes("sid-abc"))

    const f = t.frame()
    expect(f).toContain("9.9.9")
    expect(f).toContain("sid-abc")
    expect(f).toContain("/workspace")
    expect(f).toContain("3 in 2 toolsets")
    t.destroy()
  })

  test("/history opens transcript dialog from session.history RPC", async () => {
    const gw = new MockGateway({
      "session.history": () => ({
        count: 3,
        messages: [
          { role: "user", text: "write a haiku about debugging" },
          { role: "tool", name: "terminal", context: "ls -la" },
          { role: "assistant", text: "silent stack\nunfolds" },
        ],
      }),
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/history") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Session History"))

    const f = t.frame()
    expect(f).toContain("3 messages")
    expect(f).toContain("▸ You")
    expect(f).toContain("write a haiku about debugging")
    expect(f).toContain("⚙ terminal")
    expect(f).toContain("ls -la")
    expect(f).toContain("◂ Agent")
    expect(f).toContain("silent stack unfolds")   // newlines collapsed
    expect(t.gw.last("slash.exec")).toBeUndefined() // intercepted locally

    act(() => t.keys.pressEscape())
    await t.settle()
    expect(t.frame()).not.toContain("Session History")
    t.destroy()
  })

  test("failed turn (status=error, text=null) renders error in transcript", async () => {
    // Reproduces the wire trace from a model 404: message.start →
    // lifecycle status.update → message.complete {status:error, text:null}.
    // Before the fix this ended the turn with zero visible output.
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    const feed: GatewayEvent[] = [
      { type: "message.start" },
      { type: "status.update", payload: { kind: "lifecycle", text: "HTTP 404: 404 page not found" } },
      { type: "message.complete", payload: { text: null, status: "error", usage: { input: 0, output: 0, total: 0 } } },
    ]
    act(() => { for (const ev of feed) t.gw.push(ev) })
    await t.settle()

    const f = t.frame()
    expect(f).toContain("HTTP 404")          // lifecycle status persisted as system line
    expect(f).toContain("Error:")            // message.complete status=error → error action
    expect(f).toContain("request failed")

    t.destroy()
  })

  test("send() expands {!cmd} via shell.exec before prompt.submit", async () => {
    const t = await mount({ handlers: {
      "shell.exec": p => ({ stdout: `OUT<${p.command}>`, stderr: "", code: 0 }),
    }})
    await until(t, () => t.frame().includes("Ready"))
    await act(async () => { await t.keys.typeText("branch is {!git rev-parse} ok") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.gw.last("prompt.submit") !== undefined)
    expect(t.gw.last("shell.exec")?.params.command).toBe("git rev-parse")
    expect(t.gw.last("prompt.submit")?.params.text).toBe("branch is OUT<git rev-parse> ok")
    // Transcript shows the expanded form, not the raw template.
    expect(t.frame()).not.toContain("{!git")
    t.destroy()
  })

  test("interrupt: post-Esc stream events are dropped; complete passes; next send reopens gate", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    act(() => t.gw.push({ type: "message.start" }))
    act(() => t.gw.push({ type: "message.delta", payload: { text: "alpha " } }))
    await until(t, () => t.frame().includes("Type to queue"))

    act(() => t.keys.pressEscape()); await t.settle()
    act(() => t.keys.pressEscape())
    await until(t, () => t.gw.last("session.interrupt") !== undefined)

    // In-pipe stale deltas + a late tool.start arrive after the latch.
    act(() => {
      t.gw.push({ type: "message.delta", payload: { text: "STALE-DELTA " } })
      t.gw.push({ type: "tool.start", payload: { tool_id: "x", name: "zz_stale_tool", context: "STALE-TOOL" } })
      t.gw.push({ type: "reasoning.delta", payload: { text: "STALE-THINK" } })
      t.gw.push({ type: "message.complete", payload: { text: "alpha ", status: "interrupted", usage: { input: 1, output: 1, total: 2 } } })
    })
    // Cloud unmounts once streaming stops — transcript now visible.
    await until(t, () => t.frame().includes("Ready") && t.frame().includes("alpha"))

    const f = t.frame()
    expect(f).not.toContain("STALE-DELTA")
    expect(f).not.toContain("STALE-TOOL")
    expect(f).not.toContain("STALE-THINK")
    expect(f).not.toContain("zz_stale_tool")   // tool part never created
    expect(f).toContain("alpha")
    // `*[interrupted]*` → markdown strips `*` and `[]`; bare word under
    // the assistant right-side gutter (content on the left, bar on the right).
    expect(f).toMatch(/interrupted\s+│/)

    // Latch survives completion: the worker thread's stream-retry except
    // handler emits lifecycle "Reconnecting…" after message.complete; a
    // lost clear_interrupt race can fire a whole orphan stream. All gated.
    act(() => {
      t.gw.push({ type: "status.update", payload: { kind: "lifecycle", text: "⚠️ Connection dropped. Reconnecting…" } })
      t.gw.push({ type: "message.start" })
      t.gw.push({ type: "tool.start", payload: { tool_id: "g", name: "zz_ghost_tool", context: "" } })
    })
    await t.settle()
    expect(t.frame()).not.toContain("Reconnecting")
    expect(t.frame()).not.toContain("zz_ghost_tool")
    expect(t.frame()).not.toContain("Generating")  // message.start was dropped

    // Next user send reopens the gate: this turn's tool.start renders.
    // Tool parts surface in the cloud with a humanised label.
    await act(async () => { await t.keys.typeText("go") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.gw.last("prompt.submit") !== undefined)
    act(() => t.gw.push({ type: "message.start" }))
    act(() => t.gw.push({ type: "tool.start", payload: { tool_id: "y", name: "read_file", context: "" } }))
    await until(t, () => t.frame().includes("Reading file"))
    t.destroy()
  })
})
