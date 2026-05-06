import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { GatewayClient } from "../src/utils/gateway-client"

const orig = Bun.spawn
const cwd = process.cwd()
const env = {
  HERMES_CWD: process.env.HERMES_CWD,
  TERMINAL_CWD: process.env.TERMINAL_CWD,
}

type Call = {
  cmd: unknown
  opts: { cwd?: string; env?: Record<string, string> }
}

type Stub = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  stdin: { write: (data: string | Uint8Array) => number }
  exited: Promise<number>
  exitCode: number | null
  kill: () => void
}

function stream(text = "") {
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      if (text) ctrl.enqueue(new TextEncoder().encode(text))
      ctrl.close()
    },
  })
}

function mock() {
  const calls: Call[] = []
  ;(Bun as unknown as { spawn: (cmd: unknown, opts: Call["opts"]) => Stub }).spawn = (cmd, opts) => {
    calls.push({ cmd, opts })
    return {
      stdout: stream(),
      stderr: stream(),
      stdin: { write: () => 0 },
      exited: new Promise<number>(() => {}),
      exitCode: null,
      kill: () => {},
    }
  }
  return calls
}

function cleanup(client?: GatewayClient) {
  client?.kill()
  const timer = (client as unknown as { timer?: ReturnType<typeof setTimeout> | null } | undefined)?.timer
  if (timer) clearTimeout(timer)
}

afterEach(() => {
  cleanup()
  ;(Bun as unknown as { spawn: typeof orig }).spawn = orig
  process.chdir(cwd)
  if (env.HERMES_CWD === undefined) delete process.env.HERMES_CWD
  else process.env.HERMES_CWD = env.HERMES_CWD
  if (env.TERMINAL_CWD === undefined) delete process.env.TERMINAL_CWD
  else process.env.TERMINAL_CWD = env.TERMINAL_CWD
})

describe("GatewayClient cwd", () => {
  test("starts tui_gateway in the launch directory by default", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "herm-cwd-")))
    delete process.env.HERMES_CWD
    process.env.TERMINAL_CWD = "/stale"
    process.chdir(dir)
    const calls = mock()
    const client = new GatewayClient()

    client.start()

    expect(calls[0].opts.cwd).toBe(dir)
    expect(calls[0].opts.env?.TERMINAL_CWD).toBe(dir)
    cleanup(client)
  })

  test("honors HERMES_CWD as an explicit override", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "herm-cwd-")))
    const override = realpathSync(mkdtempSync(join(tmpdir(), "herm-override-")))
    process.env.HERMES_CWD = override
    process.chdir(dir)
    const calls = mock()
    const client = new GatewayClient()

    client.start()

    expect(calls[0].opts.cwd).toBe(override)
    expect(calls[0].opts.env?.TERMINAL_CWD).toBe(override)
    cleanup(client)
  })
})
