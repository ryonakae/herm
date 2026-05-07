// Typed events and RPC responses for the tui_gateway JSON-RPC protocol.

import type { Usage } from "../types/message"

// ── Events (server → client) ────────────────────────────────────────

export type GatewayEvent =
  | { type: "gateway.ready"; payload?: { skin?: GatewaySkin } }
  | { type: "gateway.stderr"; payload: { line: string } }
  | { type: "gateway.start_timeout"; payload?: { cwd?: string; python?: string } }
  | { type: "gateway.protocol_error"; payload?: { preview?: string } }
  | { type: "session.info"; payload: SessionInfo }
  | { type: "skin.changed"; payload?: GatewaySkin }
  | { type: "message.start"; payload?: undefined }
  | { type: "message.delta"; payload?: { text?: string; rendered?: string } }
  | { type: "message.complete"; payload?: { text?: string | null; rendered?: string; reasoning?: string; status?: "complete" | "error" | "interrupted"; usage?: Usage } }
  | { type: "thinking.delta"; payload?: { text?: string } }
  | { type: "reasoning.delta"; payload?: { text?: string } }
  | { type: "reasoning.available"; payload?: { text?: string } }
  | { type: "status.update"; payload?: { text?: string; kind?: string } }
  | { type: "tool.start"; payload: { tool_id: string; name?: string; context?: string } }
  | { type: "tool.progress"; payload: { name?: string; preview?: string } }
  | { type: "tool.generating"; payload: { name?: string } }
  | { type: "tool.complete"; payload: { tool_id: string; name?: string; summary?: string; error?: string; inline_diff?: string } }
  | { type: "clarify.request"; payload: { request_id: string; question: string; choices: string[] | null } }
  | { type: "approval.request"; payload: { command: string; description: string } }
  | { type: "sudo.request"; payload: { request_id: string } }
  | { type: "secret.request"; payload: { request_id: string; prompt: string; env_var: string } }
  | { type: "background.complete"; payload: { task_id: string; text: string } }
  | { type: "review.summary"; payload?: { text?: string } }
  | { type: "btw.complete"; payload: { text: string } }
  | { type: "browser.progress"; payload?: { message?: string; level?: "info" | "error" } }
  | { type: "subagent.start"; payload: SubagentPayload }
  | { type: "subagent.thinking"; payload: SubagentPayload }
  | { type: "subagent.tool"; payload: SubagentPayload }
  | { type: "subagent.progress"; payload: SubagentPayload }
  | { type: "subagent.complete"; payload: SubagentPayload }
  | { type: "error"; payload?: { message?: string } }

export type SubagentPayload = {
  task_index: number
  goal: string
  task_count?: number
  status?: "running" | "completed" | "failed" | "interrupted"
  text?: string
  tool_name?: string
  tool_preview?: string
  summary?: string
  duration_seconds?: number
  // Spawn-tree identity (upstream delegate_tool threads these through
  // every subagent.* event). All optional — absence falls back to flat
  // task_index keying.
  subagent_id?: string
  parent_id?: string
  depth?: number
  model?: string
  tool_count?: number
  toolsets?: string[]
  // Rollups on subagent.complete
  input_tokens?: number
  output_tokens?: number
  reasoning_tokens?: number
  api_calls?: number
  cost_usd?: number
  files_read?: string[]
  files_written?: string[]
  output_tail?: Array<{ tool: string; preview: string; is_error?: boolean }>
}

// delegation.status response — list_active_subagents() snapshot plus
// scheduler flags. Records are a copy of the live registry minus the
// agent handle.
export type DelegationRecord = {
  subagent_id: string
  parent_id?: string | null
  depth: number
  goal: string
  model?: string
  started_at?: number
  tool_count?: number
  status?: string
}

export type DelegationStatus = {
  active: DelegationRecord[]
  paused: boolean
  max_spawn_depth: number
  max_concurrent_children: number
}

// spawn_tree.list index entries + spawn_tree.load payload
export type SpawnTreeEntry = {
  path: string
  session_id: string
  label: string
  count: number
  started_at?: number | null
  finished_at: number
}

export type SpawnTreeSnapshot = {
  session_id?: string
  label?: string
  started_at?: number | null
  finished_at?: number
  subagents: SpawnSubagent[]
}

// Persisted per-subagent record — the shape we save, and the shape
// spawn_tree.load round-trips. A completed SubagentPayload superset.
export type SpawnSubagent = {
  subagent_id: string
  parent_id?: string | null
  depth: number
  goal: string
  model?: string
  started_at: number
  finished_at?: number
  tool_count: number
  status: "running" | "completed" | "failed" | "interrupted"
  input_tokens?: number
  output_tokens?: number
  cost_usd?: number
  trail?: Array<{ name: string; preview?: string }>
}

export type GatewaySkin = {
  name?: string
  colors?: Record<string, string>
  branding?: Record<string, string>
  banner_hero?: string
  banner_logo?: string
  tool_prefix?: string
  help_header?: string
}

export type McpServer = {
  name: string
  transport: string
  tools: number
  connected: boolean
  error?: string
}

export type SessionInfo = {
  model?: string
  cwd?: string
  session_id?: string
  tools?: Record<string, string[]>
  skills?: Record<string, string[]>
  version?: string
  /**
   * Wire usage payload for the current session. Server builds this via
   * `_get_usage(agent)` (tui_gateway/server.py:826), which extends the
   * base Usage with ctx/compression fields when a ContextCompressor is
   * attached — so `compressions`/`context_used`/`context_max`/
   * `context_percent` may be present. Intersection type keeps both
   * shapes satisfied.
   */
  usage?: Usage & {
    context_used?: number
    context_max?: number
    context_percent?: number
    compressions?: number
  }
  context_max?: number
  context_used?: number
  credential_warning?: string
  mcp_servers?: McpServer[]
  /** hermes-agent version string (e.g. "1.14.2-dev+abc123") */
  release_date?: string
  /** commits behind origin/main; null = unknown, 0 = up to date */
  update_behind?: number | null
  /** platform-appropriate update invocation */
  update_command?: string
}

// ── RPC responses ───────────────────────────────────────────────────

export type SessionCreateResponse = {
  session_id: string
  info?: SessionInfo & { credential_warning?: string }
}

export type SessionResumeResponse = {
  session_id: string
  resumed?: string
  messages: TranscriptMessage[]
  message_count?: number
  info?: SessionInfo
}

export type SessionListItem = {
  id: string
  title: string
  preview: string
  message_count: number
  started_at: number
  source?: string
}

export type SessionListResponse = {
  sessions?: SessionListItem[]
}

export type SessionUsageResponse = {
  model?: string
  calls?: number
  input?: number
  output?: number
  total?: number
  cache_read?: number
  cache_write?: number
  cost_usd?: number
  cost_status?: "estimated" | "exact"
  context_used?: number
  context_max?: number
  context_percent?: number
  compressions?: number
}

/** Content part inside a multimodal user turn — upstream stores the raw
 *  OpenAI content list for native-mode image routing. We only care about
 *  flattening the text fragments back into a string for render. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: string }

export type TranscriptMessage = {
  role: "user" | "assistant" | "system" | "tool"
  /** Either a plain string (text-mode, assistant, system) or a list of
   *  OpenAI content parts (native-mode user turns with attached images). */
  text?: string | ContentPart[]
  /** Raw DB column name, present on some gateway/session paths. */
  content?: string | ContentPart[]
  name?: string
  context?: string
  tool_call_id?: string
  tool_calls?: string
  reasoning?: string
  reasoning_content?: string
  reasoning_details?: string
  codex_reasoning_items?: string
  codex_message_items?: string
}

export type CommandsCatalogResponse = {
  categories?: Array<{ name: string; pairs?: [string, string][] }>
  pairs?: [string, string][]
  canon?: Record<string, string>
  sub?: Record<string, string[]>
  skill_count?: number
  warning?: string
}

export type ConfigSetResponse = {
  value?: string
  info?: SessionInfo
  warning?: string
  history_reset?: boolean
}

export type ModelOptionsResponse = {
  provider?: string
  model?: string
  providers?: {
    slug: string
    name: string
    models?: string[]
    total_models?: number
    is_current?: boolean
    warning?: string
  }[]
}

export type ImageAttachResponse = {
  attached: boolean
  path?: string
  count?: number
  name?: string
  width?: number
  height?: number
  token_estimate?: number
  message?: string
}

export type DropDetectResponse =
  | { matched: false }
  | ({ matched: true; is_image: true; text: string } & Omit<ImageAttachResponse, "attached" | "message">)
  | { matched: true; is_image: false; path: string; name: string; text: string }
