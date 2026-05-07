/**
 * Local TUI preferences — persisted to ~/.config/herm/tui.json
 *
 * Compatible with OpenCode's tui.json schema pattern:
 *   - JSON file in XDG config dir
 *   - Optional fields with sensible defaults
 *   - Deep-merged from multiple sources (global → project)
 *   - Read once at startup, written on change
 *
 * Herm-specific extensions (beyond OpenCode compat):
 *   - lastSessionId: resume previous session on startup
 */

import { join } from "path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { useSyncExternalStore } from "react"

// ─── Schema ──────────────────────────────────────────────────────────

export type DetailMode = "hidden" | "collapsed" | "expanded"
export type ThoughtDisplay = "cloud" | "inline"

interface TuiPreferences {
  /** JSON schema reference (for editor autocomplete) */
  $schema?: string
  /** Theme name — must match a built-in or custom theme */
  theme?: string
  /** Mouse capture enabled */
  mouse?: boolean
  /** Target render FPS */
  targetFps?: number

  // ─── Herm extensions ─────────────────────────────────────────────
  /** Last active session ID — stub-reuse check on fresh launch */
  lastSessionId?: string
  /** Path to a .eikon avatar file for the sidebar */
  eikonPath?: string
  /** Spinner/avatar frame animations (off → static glyphs) */
  animations?: boolean
  /** Thought-cloud tool trail verbosity */
  toolDetails?: DetailMode
  /** Where reasoning + tool calls are displayed. */
  thoughtDisplay?: ThoughtDisplay
  /** Initial open state of the per-turn ThoughtInline summary. */
  thoughtInlineDefaultOpen?: boolean
  /** User keybinding overrides (ActionId → chord string) */
  keys?: Record<string, string>
  /** Clock style for time-of-day formatters */
  timeFormat?: "12h" | "24h"
  /** List-column timestamps: "2h ago" vs "14:32" / "May 1" */
  timeStyle?: "relative" | "absolute"
  /** Action when a session's goal flips to status=done.
   *  "toast"   — toast only (default)
   *  "suspend" — 10s-countdown confirm, then `systemctl suspend`
   *  any other string — 10s-countdown confirm, then run it via sh */
  onGoalDone?: string
}

const DEFAULTS: Required<Pick<TuiPreferences, "mouse" | "targetFps">> = {
  mouse: true,
  targetFps: 30,
}

// ─── Paths ───────────────────────────────────────────────────────────

import { configDir } from "./paths"

function configFile() { return join(configDir(), "tui.json") }

// ─── Load ────────────────────────────────────────────────────────────

let cached: TuiPreferences | null = null

/** Test-only: drop the cached snapshot so the next load() re-reads disk. */
export function reset(): void {
  cached = null
}

/** Re-read tui.json from the current configDir() and notify usePref()
 *  subscribers. Profile switch calls this after HERMES_HOME rebinds so
 *  theme/eikon/keys follow the new profile. */
export function reload(): void {
  cached = null
  for (const l of listeners) l()
}

/**
 * Load preferences from disk. Returns cached copy on subsequent calls.
 * Never throws — returns defaults on missing/corrupt file.
 */
export function load(): TuiPreferences {
  if (cached) return cached

  const CONFIG_FILE = configFile()
  try {
    if (!existsSync(CONFIG_FILE)) {
      const prefs = { ...DEFAULTS }
      cached = prefs
      return prefs
    }
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))
    const prefs = { ...DEFAULTS, ...raw }
    cached = prefs
    return prefs
  } catch {
    const prefs = { ...DEFAULTS }
    cached = prefs
    return prefs
  }
}

// ─── Save ────────────────────────────────────────────────────────────

/**
 * Persist current preferences to disk.
 * Merges provided partial into existing prefs before writing.
 */
function save(partial?: Partial<TuiPreferences>): void {
  const current = load()
  if (partial) Object.assign(current, partial)
  cached = current

  try {
    const CONFIG_DIR = configDir()
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true })
    }
    // Write with sorted keys for stable diffs
    const json = JSON.stringify(current, null, 2) + "\n"
    writeFileSync(configFile(), json, "utf-8")
  } catch (err) {
    // Silently fail — preferences are non-critical
    if (process.env.PERF) {
      console.error("[preferences] failed to save:", err)
    }
  }
}

// ─── Convenience ─────────────────────────────────────────────────────

/** Get a single preference value */
export function get<K extends keyof TuiPreferences>(key: K): TuiPreferences[K] {
  return load()[key]
}

/** Set a single preference value and persist */
export function set<K extends keyof TuiPreferences>(key: K, value: TuiPreferences[K]): void {
  save({ [key]: value } as Partial<TuiPreferences>)
  for (const l of listeners) l()
}

/** Apply startup-only preference overrides without writing tui.json. */
export function apply(partial: Partial<TuiPreferences>): void {
  Object.assign(load(), partial)
}

// ─── Reactive ────────────────────────────────────────────────────────

const listeners = new Set<() => void>()

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/**
 * Subscribe a component to a preference key. Re-renders on set().
 * Writes go through the imperative `set(key, value)` — this hook is
 * read-only by design so writes always persist through one path.
 */
export function usePref<K extends keyof TuiPreferences>(key: K): TuiPreferences[K] {
  return useSyncExternalStore(subscribe, () => load()[key])
}
