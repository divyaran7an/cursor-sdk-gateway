import { startCursorGatewayServer } from "./server.js"

const ACTIVE_KEY = Symbol.for("cursor-sdk-gateway.active")
const PATCHED_KEY = Symbol.for("cursor-sdk-gateway.patched")
const ORIGINALS_KEY = Symbol.for("cursor-sdk-gateway.originals")
const WRAPPED_AGENT_KEY = Symbol.for("cursor-sdk-gateway.wrapped-agent")
const WRAPPED_RUN_KEY = Symbol.for("cursor-sdk-gateway.wrapped-run")
const DEFAULT_API_KEY = "cursor-sdk-gateway"

export async function configureCursorGateway(config) {
  const normalized = normalizeConfig(config)
  const existing = globalThis[ACTIVE_KEY]

  if (existing && !existing.closed) {
    if (sameConfig(existing.config, normalized)) return existing.handle
    throw new Error(
      "cursor-sdk-gateway is already configured with different provider settings. Close the existing gateway before reconfiguring."
    )
  }

  const server = await startCursorGatewayServer(normalized)
  const previousBackendUrl = process.env.CURSOR_BACKEND_URL
  const previousCursorApiKey = process.env.CURSOR_API_KEY
  const previousUseHttp1 = process.env.CURSOR_USE_HTTP1
  const previousFetch = globalThis.fetch

  process.env.CURSOR_BACKEND_URL = server.url
  process.env.CURSOR_USE_HTTP1 = "true"
  process.env.CURSOR_API_KEY ??= DEFAULT_API_KEY
  globalThis.fetch = createGatewayFetch(server.url, previousFetch)

  await patchCursorSdk()

  const handle = {
    url: server.url,
    runtime: normalized.runtime,
    async close() {
      const current = globalThis[ACTIVE_KEY]
      if (current?.handle !== handle || current.closed) return
      current.closed = true
      await server.close()
      if (previousBackendUrl === undefined) delete process.env.CURSOR_BACKEND_URL
      else process.env.CURSOR_BACKEND_URL = previousBackendUrl
      if (previousUseHttp1 === undefined) delete process.env.CURSOR_USE_HTTP1
      else process.env.CURSOR_USE_HTTP1 = previousUseHttp1
      if (previousCursorApiKey === undefined && process.env.CURSOR_API_KEY === DEFAULT_API_KEY) {
        delete process.env.CURSOR_API_KEY
      } else if (previousCursorApiKey !== undefined) {
        process.env.CURSOR_API_KEY = previousCursorApiKey
      }
      if (globalThis.fetch && previousFetch) globalThis.fetch = previousFetch
    },
  }

  globalThis[ACTIVE_KEY] = {
    config: normalized,
    handle,
    server,
    closed: false,
  }

  return handle
}

export async function closeCursorGateway() {
  const active = globalThis[ACTIVE_KEY]
  if (!active || active.closed) return
  await active.handle.close()
}

function normalizeConfig(config = {}) {
  const provider = config.provider ?? "ai-gateway"
  const runtime = config.runtime ?? "local-executor"
  if (runtime !== "local-executor") {
    throw new Error("cursor-sdk-gateway only supports runtime \"local-executor\".")
  }

  if (provider === "ai-gateway") {
    if (!config.apiKey) throw new Error("configureCursorGateway requires apiKey for provider \"ai-gateway\".")
    return {
      provider,
      runtime,
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: withoutTrailingSlash(config.baseURL) } : {}),
      headers: config.headers ?? {},
      ...(config.metadataCacheRefreshMillis !== undefined
        ? { metadataCacheRefreshMillis: config.metadataCacheRefreshMillis }
        : {}),
      ...normalizeImageConfig(config),
    }
  }

  if (provider === "openai-compatible") {
    if (!config.apiKey) throw new Error("configureCursorGateway requires apiKey for provider \"openai-compatible\".")
    if (!config.baseURL) throw new Error("configureCursorGateway requires baseURL for provider \"openai-compatible\".")
    return {
      provider,
      runtime,
      apiKey: config.apiKey,
      baseURL: withoutTrailingSlash(config.baseURL),
      headers: config.headers ?? {},
      ...(config.queryParams ? { queryParams: config.queryParams } : {}),
      ...(config.includeUsage !== undefined ? { includeUsage: Boolean(config.includeUsage) } : {}),
      ...normalizeImageConfig(config),
    }
  }

  throw new Error(`Unsupported cursor-sdk-gateway provider: ${provider}`)
}

function normalizeImageConfig(config) {
  if (!config.imageModel && !config.image) return {}
  const image = config.image && typeof config.image === "object" ? config.image : {}
  const imageModel = config.imageModel ?? image.model
  if (!imageModel) return {}

  return {
    imageModel: String(imageModel),
    ...(config.imageSize ?? image.size ? { imageSize: String(config.imageSize ?? image.size) } : {}),
    ...(config.imageAspectRatio ?? image.aspectRatio ? { imageAspectRatio: String(config.imageAspectRatio ?? image.aspectRatio) } : {}),
    ...(config.imageProviderOptions ?? image.providerOptions ? { imageProviderOptions: config.imageProviderOptions ?? image.providerOptions } : {}),
  }
}

function withoutTrailingSlash(value) {
  return value.replace(/\/+$/, "")
}

function sameConfig(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function createGatewayFetch(gatewayUrl, originalFetch) {
  if (typeof originalFetch !== "function") return originalFetch
  const gateway = new URL(gatewayUrl)

  return function cursorGatewayFetch(input, init) {
    const url = requestUrl(input)
    if (!url || !shouldRewriteCursorRequest(url)) return originalFetch(input, init)

    const rewritten = new URL(url.pathname + url.search, gateway)
    if (typeof Request !== "undefined" && input instanceof Request) {
      return originalFetch(new Request(rewritten, input), init)
    }
    return originalFetch(rewritten, init)
  }
}

function requestUrl(input) {
  try {
    if (typeof input === "string" || input instanceof URL) return new URL(input)
    if (typeof Request !== "undefined" && input instanceof Request) return new URL(input.url)
  } catch {
    return undefined
  }
  return undefined
}

function shouldRewriteCursorRequest(url) {
  const host = url.hostname.toLowerCase()
  if (!host.includes("cursor")) return false
  return (
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/agent.v1.") ||
    url.pathname.startsWith("/aiserver.v1.") ||
    url.pathname.startsWith("/v1/")
  )
}

async function patchCursorSdk() {
  const sdk = await import("@cursor/sdk")
  const runtimeSdk = await importFreshCursorSdk().catch(() => sdk)
  const { Agent, Cursor } = sdk
  const RuntimeAgent = runtimeSdk.Agent ?? Agent
  const RuntimeCursor = runtimeSdk.Cursor ?? Cursor

  if (!Agent) return

  const originals = {
    create: RuntimeAgent.create.bind(RuntimeAgent),
    resume: RuntimeAgent.resume?.bind(RuntimeAgent),
    list: RuntimeAgent.list?.bind(RuntimeAgent),
    listRuns: RuntimeAgent.listRuns?.bind(RuntimeAgent),
    getRun: RuntimeAgent.getRun?.bind(RuntimeAgent),
    get: RuntimeAgent.get?.bind(RuntimeAgent),
    archive: RuntimeAgent.archive?.bind(RuntimeAgent),
    unarchive: RuntimeAgent.unarchive?.bind(RuntimeAgent),
    delete: RuntimeAgent.delete?.bind(RuntimeAgent),
  }

  if (Agent[PATCHED_KEY]) {
    Object.assign(Agent[ORIGINALS_KEY], originals)
    return
  }

  Object.defineProperty(Agent, ORIGINALS_KEY, { value: originals })
  Object.defineProperty(Agent, PATCHED_KEY, { value: true })

  Agent.create = async (options = {}) => {
    const active = globalThis[ACTIVE_KEY]
    const next = {
      ...options,
      apiKey: options.apiKey ?? process.env.CURSOR_API_KEY ?? DEFAULT_API_KEY,
    }
    const agent = await originals.create(next)

    if (next.local) {
      active?.server?.registerLocalAgent?.(agent.agentId, {
        cwd: getLocalCwd(next.local.cwd),
      })
      wrapLocalAgent(agent)
    }

    return agent
  }

  if (originals.resume) {
    Agent.resume = async (agentId, options = {}) => {
      const active = globalThis[ACTIVE_KEY]
      const next = {
        ...options,
        apiKey: options.apiKey ?? process.env.CURSOR_API_KEY ?? DEFAULT_API_KEY,
      }
      const agent = await originals.resume(agentId, next)

      active?.server?.registerLocalAgent?.(agent.agentId, {
        cwd: getLocalCwd(next.local?.cwd),
      })
      wrapLocalAgent(agent)

      return agent
    }
  }

  if (originals.list) {
    Agent.list = (options = {}) => originals.list(options)
  }

  if (originals.listRuns) {
    Agent.listRuns = (agentId, options = {}) => originals.listRuns(agentId, options)
  }

  if (originals.getRun) {
    Agent.getRun = (runId, options = {}) => originals.getRun(runId, options)
  }

  if (originals.get) {
    Agent.get = (agentId, options = {}) => originals.get(agentId, options)
  }

  if (originals.archive) {
    Agent.archive = (agentId, options = {}) => originals.archive(agentId, options)
  }

  if (originals.unarchive) {
    Agent.unarchive = (agentId, options = {}) => originals.unarchive(agentId, options)
  }

  if (originals.delete) {
    Agent.delete = (agentId, options = {}) => originals.delete(agentId, options)
  }

  if (Cursor?.models?.list) {
    const originalModelsList = RuntimeCursor.models.list.bind(RuntimeCursor.models)
    Cursor.models.list = (options = {}) => originalModelsList(withApiKey(options))
  }

  if (Cursor?.me) {
    const originalMe = RuntimeCursor.me.bind(RuntimeCursor)
    Cursor.me = (options = {}) => originalMe(withApiKey(options))
  }

  if (Cursor?.repositories?.list) {
    const originalRepositoriesList = RuntimeCursor.repositories.list.bind(RuntimeCursor.repositories)
    Cursor.repositories.list = (options = {}) => originalRepositoriesList(withApiKey(options))
  }
}

async function importFreshCursorSdk() {
  const resolved = import.meta.resolve("@cursor/sdk")
  return import(`${resolved}?cursor-sdk-gateway=${Date.now()}`)
}

function wrapLocalAgent(agent) {
  if (!agent || agent[WRAPPED_AGENT_KEY]) return agent

  const originalSend = agent.send.bind(agent)
  agent.send = async (...args) => wrapLocalRun(await originalSend(...args))

  Object.defineProperty(agent, WRAPPED_AGENT_KEY, { value: true })
  return agent
}

function wrapLocalRun(run) {
  if (!run || run[WRAPPED_RUN_KEY]) return run

  const originalStream = run.stream.bind(run)
  const originalWait = run.wait.bind(run)
  const originalConversation = run.conversation?.bind(run)
  let streamedText = ""

  run.stream = async function* streamWithResultCapture() {
    for await (const event of originalStream()) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text") streamedText += block.text
        }
      }
      yield event
    }
  }

  run.wait = async () => {
    const result = await originalWait()
    if (result.result !== undefined) return result

    const text = streamedText || (originalConversation ? await textFromConversation(originalConversation) : "")
    return text ? { ...result, result: text } : result
  }

  Object.defineProperty(run, WRAPPED_RUN_KEY, { value: true })
  return run
}

async function textFromConversation(conversation) {
  const turns = await conversation().catch(() => [])
  let text = ""

  for (const item of turns) {
    if (item.type !== "agentConversationTurn") continue
    for (const step of item.turn.steps) {
      if (step.type === "assistantMessage") text += step.message.text
    }
  }

  return text
}

function getLocalCwd(cwd) {
  if (Array.isArray(cwd)) return cwd[0] ?? process.cwd()
  return cwd ?? process.cwd()
}

function withApiKey(options) {
  return {
    ...options,
    apiKey: options.apiKey ?? process.env.CURSOR_API_KEY ?? DEFAULT_API_KEY,
  }
}
