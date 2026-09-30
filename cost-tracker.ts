import type { Plugin } from "@opencode-ai/plugin"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

type SessionState = {
  notified: Record<string, boolean>
  baseline: number | null
  lastCost: number
  totalCost: number
  lastModel: string | null
}

type Capture = {
  model: string | null
  cost: number | null
}

const stateRoot = join(process.env.HOME ?? ".", ".local", "state", "opencode", "cost-tracker")
const authFile = join(
  process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? ".", ".local", "share"),
  "opencode",
  "auth.json",
)
const usageUrl = "https://openrouter.ai/api/v1/auth/key"
const chatUrl = "openrouter.ai/api/v1/chat/completions"
const captureTtl = 120_000

const emptyState = (): SessionState => ({
  notified: {},
  baseline: null,
  lastCost: 0,
  totalCost: 0,
  lastModel: null,
})

async function loadState(sessionID: string): Promise<SessionState> {
  try {
    const content = await readFile(join(stateRoot, `${encodeURIComponent(sessionID)}.json`), "utf8")
    const state = JSON.parse(content) as Partial<SessionState>
    return {
      notified: state.notified ?? {},
      baseline: typeof state.baseline === "number" ? state.baseline : null,
      lastCost: Number(state.lastCost) || 0,
      totalCost: Number(state.totalCost) || 0,
      lastModel: typeof state.lastModel === "string" ? state.lastModel : null,
    }
  } catch {
    return emptyState()
  }
}

async function saveState(sessionID: string, state: SessionState) {
  await mkdir(stateRoot, { recursive: true })
  await writeFile(join(stateRoot, `${encodeURIComponent(sessionID)}.json`), JSON.stringify(state))
}

let cachedKey: string | undefined | null = null

async function apiKey(): Promise<string | undefined> {
  if (cachedKey !== null) return cachedKey
  if (process.env.OPENROUTER_API_KEY) {
    cachedKey = process.env.OPENROUTER_API_KEY
    return cachedKey
  }
  try {
    const auth = JSON.parse(await readFile(authFile, "utf8")) as Record<string, { key?: string }>
    cachedKey = auth.openrouter?.key
  } catch {
    cachedKey = undefined
  }
  return cachedKey
}

// OpenRouter's key endpoint returns the cumulative USD spent on the API key.
// It is the fallback when a response cannot be observed directly.
async function keyUsage(): Promise<number | undefined> {
  const key = await apiKey()
  if (!key) return undefined
  try {
    const response = await fetch(usageUrl, { headers: { Authorization: `Bearer ${key}` } })
    if (!response.ok) return undefined
    const body = (await response.json()) as { data?: { usage?: number } }
    const usage = body.data?.usage
    return typeof usage === "number" && Number.isFinite(usage) ? usage : undefined
  } catch {
    return undefined
  }
}

function formatCost(cost: number) {
  return `$${cost >= 0.01 ? cost.toFixed(4) : cost.toFixed(6)}`
}

async function showCost(client: Parameters<Plugin>[0]["client"], state: SessionState) {
  const model = state.lastModel ? ` · ${state.lastModel}` : ""
  await client.tui.showToast({
    body: {
      title: "OpenCode cost",
      message: `${formatCost(state.lastCost)} last · ${formatCost(state.totalCost)} session${model}`,
      variant: "info",
      duration: 5000,
    },
  })
}

async function captureBaseline(sessionID: string, state: SessionState) {
  if (state.baseline !== null) return
  const usage = await keyUsage()
  if (usage === undefined) return
  state.baseline = usage
  await saveState(sessionID, state)
}

async function settle(info: { providerID: string; cost: number }, state: SessionState): Promise<number> {
  if (info.providerID === "openrouter") {
    const usage = await keyUsage()
    if (usage !== undefined) {
      const delta = state.baseline === null ? 0 : usage - state.baseline
      state.baseline = usage
      if (Number.isFinite(delta) && delta >= 0) return delta
    }
  }
  return Number(info.cost) || 0
}

// --- response capture -------------------------------------------------------
// OpenRouter returns the routed model in every response (and an exact
// `usage.cost`), but opencode discards it. A wrapping fetch observes the
// cloned response so the plugin can report both. Injected via the config hook,
// where opencode subsequently wraps it with its timeout-aware fetch.

const captures: { promise: Promise<Capture>; time: number }[] = []

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

async function readCapture(response: Response): Promise<Capture> {
  const contentType = response.headers.get("content-type") ?? ""
  const clone = response.clone()
  let model: string | null = null
  let cost: number | null = null
  try {
    if (contentType.includes("text/event-stream")) {
      const reader = clone.body?.getReader()
      if (!reader) return { model, cost }
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith("data:")) continue
          const payload = trimmed.slice(5).trim()
          if (!payload || payload === "[DONE]") continue
          try {
            const json = JSON.parse(payload) as { model?: unknown; usage?: { cost?: unknown } }
            if (typeof json.model === "string") model = json.model
            if (typeof json.usage?.cost === "number") cost = json.usage.cost
          } catch {}
        }
      }
    } else {
      const json = (await clone.json()) as { model?: unknown; usage?: { cost?: unknown } }
      if (typeof json.model === "string") model = json.model
      if (typeof json.usage?.cost === "number") cost = json.usage.cost
    }
  } catch {}
  return { model, cost }
}

function enqueueCapture(response: Response) {
  captures.push({ promise: readCapture(response), time: Date.now() })
}

function shiftCapture(): Promise<Capture> | undefined {
  const now = Date.now()
  while (captures.length && now - captures[0].time > captureTtl) captures.shift()
  return captures.shift()?.promise
}

async function takeCapture(ms = 1500): Promise<Capture | undefined> {
  const deadline = Date.now() + ms
  for (;;) {
    const pending = shiftCapture()
    if (pending) return pending
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function wrapFetch(inner: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(inner(input, init)).then((response) => {
      if (requestUrl(input).includes(chatUrl)) enqueueCapture(response)
      return response
    })) as typeof fetch
}

export const CostTracker: Plugin = async ({ client }) => {
  return {
    config: async (config) => {
      try {
        const cfg = config as { provider?: Record<string, { options?: Record<string, unknown> }> }
        const providers = (cfg.provider ??= {})
        const openrouter = (providers.openrouter ??= {})
        const options = (openrouter.options ??= {})
        const inner = typeof options.fetch === "function" ? (options.fetch as typeof fetch) : globalThis.fetch
        options.fetch = wrapFetch(inner)
      } catch {}
    },
    event: async ({ event }) => {
      try {
        if (event?.type !== "message.updated") return

        const info = event.properties?.info
        if (!info) return

        if (info.role !== "assistant") {
          if (info.role === "user") await captureBaseline(info.sessionID, await loadState(info.sessionID))
          return
        }

        const state = await loadState(info.sessionID)
        if (state.notified[info.id]) return

        if (!info.time?.completed) {
          await captureBaseline(info.sessionID, state)
          return
        }

        state.notified[info.id] = true
        const capture = await takeCapture()
        const fallback = await settle(info, state)
        const cost = capture?.cost ?? fallback
        state.totalCost += cost
        if (!info.summary) {
          state.lastCost = cost
          state.lastModel = capture?.model ?? null
        }
        await saveState(info.sessionID, state)
        if (!info.summary) await showCost(client, state)
      } catch {}
    },
  }
}

export default CostTracker
