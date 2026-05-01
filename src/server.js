import { promises as fs } from "node:fs"
import http from "node:http"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { createProviderAdapter } from "./providers.js"
import { createCursorExecTools, createWorkspaceTools, cursorToolCallFromPart } from "./tools.js"
import {
  connectEndEnvelope,
  connectEnvelope,
  decodeAgentClientMessage,
  encodeExecServerHookCall,
  encodeExecServerToolCall,
  encodeHeartbeat,
  encodeTextDelta,
  encodeThinkingDelta,
  encodeToolCallCompleted,
  encodeToolCallStarted,
  encodeTurnEnded,
  readConnectMessage,
} from "./local-protocol.js"

const FALLBACK_MODELS = [
  { id: "deepseek/deepseek-v4-flash", displayName: "DeepSeek V4 Flash" },
]
const HOOK_CONFIG_CACHE = new Map()

export async function startCursorGatewayServer(config) {
  const provider = createProviderAdapter(config)
  const state = createState()
  const startedAt = new Date().toISOString()

  const server = http.createServer((req, res) => {
    handleRequest({ req, res, state, provider, startedAt }).catch((error) => {
      sendJson(res, 500, { error: { code: "internal_error", message: error.message } })
    })
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`

  return {
    url,
    registerLocalAgent(agentId, metadata) {
      state.localAgents.set(agentId, metadata)
    },
    getAgentIdForRun(runId) {
      return state.runs.get(runId)?.agentId
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}

function createState() {
  return {
    agents: new Map(),
    runs: new Map(),
    runsByAgent: new Map(),
    localAgents: new Map(),
    localHistories: new Map(),
    backgroundShells: new Map(),
    nextBackgroundShellId: 0,
    lastSeenModelId: undefined,
  }
}

function encodeVarint(value) {
  let n = BigInt(value)
  const out = []
  while (n >= 0x80n) {
    out.push(Number((n & 0x7fn) | 0x80n))
    n >>= 7n
  }
  out.push(Number(n))
  return Buffer.from(out)
}

function encodeTag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType)
}

function encodeStringField(fieldNumber, value) {
  if (value === undefined || value === null) return Buffer.alloc(0)
  const bytes = Buffer.from(String(value))
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(bytes.length), bytes])
}

function encodeBoolField(fieldNumber, value) {
  if (value === undefined || value === null) return Buffer.alloc(0)
  return Buffer.concat([encodeTag(fieldNumber, 0), Buffer.from([value ? 1 : 0])])
}

function encodeMessageField(fieldNumber, bytes) {
  if (!bytes || bytes.length === 0) return Buffer.alloc(0)
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(bytes.length), bytes])
}

function normalizeProviderModel(model) {
  const id = String(model?.id ?? model?.modelId ?? model?.name ?? "deepseek/deepseek-v4-flash")
  const displayName = String(model?.displayName ?? model?.display_name ?? model?.name ?? id)
  const aliases = Array.isArray(model?.aliases) ? model.aliases.map(String) : []
  return { id, displayName, aliases, maxMode: Boolean(model?.maxMode ?? model?.max_mode ?? false) }
}

function encodeModelDetails(model) {
  const normalized = normalizeProviderModel(model)
  const chunks = [
    encodeStringField(1, normalized.id),
    encodeStringField(3, normalized.id),
    encodeStringField(4, normalized.displayName),
    encodeStringField(5, normalized.displayName),
    ...normalized.aliases.map((alias) => encodeStringField(6, alias)),
  ]
  if (normalized.maxMode) chunks.push(encodeBoolField(7, true))
  return Buffer.concat(chunks)
}

function encodeGetUsableModelsResponse(models) {
  return Buffer.concat(models.map((model) => encodeMessageField(1, encodeModelDetails(model))))
}

function encodeGetDefaultModelForCliResponse(model) {
  return encodeMessageField(1, encodeModelDetails(model))
}

function encodeGetAllowedModelIntentsResponse(intents) {
  return Buffer.concat(intents.map((intent) => encodeStringField(1, intent)))
}

function modelJson(model) {
  const normalized = normalizeProviderModel(model)
  return {
    modelId: normalized.id,
    displayModelId: normalized.id,
    displayName: normalized.displayName,
    displayNameShort: normalized.displayName,
    aliases: normalized.aliases,
    maxMode: normalized.maxMode,
  }
}

async function providerModelItems(provider) {
  if (!provider || typeof provider.listModels !== "function") return FALLBACK_MODELS

  try {
    const items = await provider.listModels()
    if (Array.isArray(items) && items.length > 0) return items.map(normalizeProviderModel)
  } catch {
    // Model discovery is best-effort. Agent runs can still use explicit model ids.
  }

  return FALLBACK_MODELS
}

function wantsJson(req) {
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase()
  const accept = String(req.headers.accept ?? "").toLowerCase()
  return contentType.includes("json") || accept.includes("json")
}

function sendConnectUnary(req, res, jsonValue, protoBytes) {
  if (wantsJson(req)) return sendJson(res, 200, jsonValue)
  return sendProto(res, 200, protoBytes)
}

async function handleRequest({ req, res, state, provider, startedAt }) {
  const url = new URL(req.url ?? "/", "http://localhost")
  const method = req.method ?? "GET"

  if (method === "POST" && url.pathname === "/auth/exchange_user_api_key") {
    return sendJson(res, 200, {
      accessToken: "cursor-sdk-gateway-access-token",
      refreshToken: "cursor-sdk-gateway-refresh-token",
      expiresIn: 3600,
    })
  }

  if (method === "POST" && url.pathname === "/agent.v1.AgentService/Run") {
    return streamLocalExecutorRun({ req, res, state, provider })
  }

  if (method === "POST" && url.pathname === "/agent.v1.AgentService/GetUsableModels") {
    const models = await providerModelItems(provider)
    return sendConnectUnary(
      req,
      res,
      { models: models.map(modelJson) },
      encodeGetUsableModelsResponse(models),
    )
  }

  if (method === "POST" && url.pathname === "/agent.v1.AgentService/GetDefaultModelForCli") {
    const models = await providerModelItems(provider)
    const model = models[0] ?? FALLBACK_MODELS[0]
    return sendConnectUnary(
      req,
      res,
      { model: modelJson(model) },
      encodeGetDefaultModelForCliResponse(model),
    )
  }

  if (method === "POST" && url.pathname === "/agent.v1.AgentService/GetAllowedModelIntents") {
    const modelIntents = ["agent", "ask", "edit", "chat", "apply"]
    return sendConnectUnary(
      req,
      res,
      { modelIntents },
      encodeGetAllowedModelIntentsResponse(modelIntents),
    )
  }

  if (method === "POST" && url.pathname.startsWith("/aiserver.v1.DashboardService/")) {
    return sendProto(res, 200, Buffer.alloc(0))
  }

  if (method === "POST" && url.pathname.startsWith("/aiserver.v1.AnalyticsService/")) {
    return sendProto(res, 200, Buffer.alloc(0))
  }

  if (method === "POST" && url.pathname.startsWith("/agent.v1.AgentService/")) {
    return sendProto(res, 200, Buffer.alloc(0))
  }

  if (method === "GET" && url.pathname === "/v1/me") {
    return sendJson(res, 200, {
      apiKeyName: "cursor-sdk-gateway",
      userEmail: "gateway@example.local",
      createdAt: startedAt,
    })
  }

  if (method === "GET" && url.pathname === "/v1/models") {
    try {
      const items = await provider.listModels()
      return sendJson(res, 200, { items: items.length ? items : FALLBACK_MODELS })
    } catch {
      return sendJson(res, 200, { items: FALLBACK_MODELS })
    }
  }

  if (method === "GET" && url.pathname === "/v1/repositories") {
    return sendJson(res, 200, { items: [] })
  }

  if (method === "GET" && url.pathname === "/v1/agents") {
    return sendJson(res, 200, {
      items: Array.from(state.agents.values()).map(publicAgent),
      nextCursor: null,
    })
  }

  if (method === "POST" && url.pathname === "/v1/agents") {
    const body = await readJson(req)
    const prompt = normalizePrompt(body.prompt)
    const agentId = body.agentId ?? `bc-${randomUUID()}`
    const now = isoNow()
    const agent = {
      id: agentId,
      name: body.name ?? prompt.text.slice(0, 80) ?? "Cursor SDK Gateway Agent",
      status: "ACTIVE",
      env: body.env ?? { type: "cloud", name: "cursor-sdk-gateway" },
      repos: body.repos ?? [],
      autoCreatePR: body.autoCreatePR ?? false,
      skipReviewerRequest: body.skipReviewerRequest ?? false,
      url: `http://localhost/agents?id=${agentId}`,
      createdAt: now,
      updatedAt: now,
      latestRunId: undefined,
      model: body.model,
      cwd: body.env?.cwd ?? process.cwd(),
      history: [],
    }
    state.agents.set(agentId, agent)

    const run = createRun(state, agent, { prompt, model: body.model ?? agent.model })
    return sendJson(res, 200, { agent: publicAgent(agent), run: publicRun(run) })
  }

  const artifactMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/artifacts$/)
  if (method === "GET" && artifactMatch) {
    return sendJson(res, 200, { items: [] })
  }

  const artifactDownloadMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/artifacts\/download$/)
  if (method === "GET" && artifactDownloadMatch) {
    return sendJson(res, 404, { error: { code: "artifact_not_found", message: "Artifacts are not available for this gateway run." } })
  }

  const streamMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/runs\/([^/]+)\/stream$/)
  if (method === "GET" && streamMatch) {
    const run = state.runs.get(decodeURIComponent(streamMatch[2]))
    if (!run) return sendJson(res, 404, { error: { code: "run_not_found", message: "Run not found." } })
    return streamRun({ req, res, run, state, provider })
  }

  const cancelMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/runs\/([^/]+)\/cancel$/)
  if (method === "POST" && cancelMatch) {
    const run = state.runs.get(decodeURIComponent(cancelMatch[2]))
    if (!run) return sendJson(res, 404, { error: { code: "run_not_found", message: "Run not found." } })
    run.abortController?.abort()
    run.status = "CANCELLED"
    run.updatedAt = isoNow()
    appendRunEvent(run, "status", { runId: run.id, status: "CANCELLED" })
    appendRunEvent(run, "result", { runId: run.id, status: "CANCELLED", result: run.result ?? "" })
    appendRunEvent(run, "done", {})
    closeRunListeners(run)
    return sendJson(res, 200, { id: run.id })
  }

  const runMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/runs\/([^/]+)$/)
  if (method === "GET" && runMatch) {
    const run = state.runs.get(decodeURIComponent(runMatch[2]))
    if (!run) return sendJson(res, 404, { error: { code: "run_not_found", message: "Run not found." } })
    return sendJson(res, 200, publicRun(run))
  }

  const runsMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/runs$/)
  if (runsMatch) {
    const agentId = decodeURIComponent(runsMatch[1])
    const agent = state.agents.get(agentId)
    if (!agent) return sendJson(res, 404, { error: { code: "agent_not_found", message: "Agent not found." } })

    if (method === "GET") {
      const runs = state.runsByAgent.get(agentId) ?? []
      return sendJson(res, 200, { items: runs.map((id) => publicRun(state.runs.get(id))).filter(Boolean), nextCursor: null })
    }

    if (method === "POST") {
      const body = await readJson(req)
      const prompt = normalizePrompt(body.prompt)
      const model = body.model ?? agent.model
      const run = createRun(state, agent, { prompt, model })
      if (body.model) agent.model = body.model
      return sendJson(res, 200, { run: publicRun(run) })
    }
  }

  const agentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/)
  if (agentMatch) {
    const agentId = decodeURIComponent(agentMatch[1])
    const agent = state.agents.get(agentId)
    if (!agent) return sendJson(res, 404, { error: { code: "agent_not_found", message: "Agent not found." } })

    if (method === "GET") return sendJson(res, 200, publicAgent(agent))
    if (method === "DELETE") {
      state.agents.delete(agentId)
      return sendJson(res, 200, { id: agentId })
    }
  }

  const lifecycleMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/(archive|unarchive)$/)
  if (method === "POST" && lifecycleMatch) {
    const agent = state.agents.get(decodeURIComponent(lifecycleMatch[1]))
    if (!agent) return sendJson(res, 404, { error: { code: "agent_not_found", message: "Agent not found." } })
    agent.status = lifecycleMatch[2] === "archive" ? "ARCHIVED" : "ACTIVE"
    agent.updatedAt = isoNow()
    return sendJson(res, 200, publicAgent(agent))
  }

  return sendJson(res, 404, { error: { code: "not_found", message: `${method} ${url.pathname} is not implemented.` } })
}

function streamLocalExecutorRun({ req, res, state, provider }) {
  res.writeHead(200, {
    "content-type": "application/connect+proto",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })

  let buffer = Buffer.alloc(0)
  let started = false
  let runStarted = false
  let execSeq = 0
  const pendingExecs = new Map()
  const abortController = new AbortController()
  const heartbeat = setInterval(() => {
    writeLocalMessage(res, encodeHeartbeat())
  }, 5000)

  req.on("aborted", () => abortController.abort())
  req.on("error", () => abortController.abort())
  res.on("close", () => abortController.abort())

  req.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    let envelope = readConnectMessage(buffer)

    while (envelope) {
      buffer = envelope.rest
      if (envelope.flags === 0) {
        const message = decodeAgentClientMessage(envelope.message)

        if (message.type === "run_request" && !started) {
          started = true
          const runRequest = message.runRequest
          const cwd = state.localAgents.get(runRequest.conversationId)?.cwd ?? process.cwd()
          const generationId = `run-${randomUUID()}`
          const execTool = (toolCall) =>
            executeGatewayTool({
              res,
              pendingExecs,
              nextId: () => ++execSeq,
              cwd,
              conversationId: runRequest.conversationId,
              generationId,
              modelId: runRequest.modelId,
              provider,
              toolCall,
              state,
            })

          runLocalProvider({ res, provider, state, runRequest, abortController, cwd, execTool })
            .catch((error) => {
              if (process.env.CURSOR_SDK_GATEWAY_DEBUG_EXEC) {
                console.error(`[cursor-sdk-gateway] provider run failed: ${error?.stack ?? error?.message ?? String(error)}`)
              }
              writeLocalMessage(res, encodeTextDelta(`\n\ncursor-sdk-gateway error: ${error.message}`))
              writeLocalMessage(res, encodeTurnEnded())
            })
            .finally(() => {
              runStarted = false
              clearInterval(heartbeat)
              for (const pending of pendingExecs.values()) {
                pending.reject(new Error("Cursor local run ended before the tool completed."))
              }
              pendingExecs.clear()
              if (!res.destroyed) {
                res.write(connectEndEnvelope())
                res.end()
              }
            })
          runStarted = true
        } else if (runStarted) {
          handleCursorExecClientMessage(message, pendingExecs)
        }
      }

      envelope = readConnectMessage(buffer)
    }
  })
}

async function runLocalProvider({ res, provider, state, runRequest, abortController, cwd, execTool }) {
  const modelId = runRequest.modelId ?? state.lastSeenModelId
  if (!modelId) throw new Error("No model id found in Cursor local run request.")
  if (runRequest.modelId) state.lastSeenModelId = runRequest.modelId

  const text = runRequest.text ?? ""
  const historyKey = runRequest.conversationId ?? cwd ?? "default"
  const history = state.localHistories.get(historyKey) ?? []
  const messages = [...history, { role: "user", content: text }]
  const exec = (name, args, callId) =>
    execTool({ name, args, callId })
  let assistantText = ""

  let mcpTools = runRequest.mcpTools ?? []
  if (mcpTools.length === 0) {
    const state = await exec("mcp_state", {}, `mcp-state-${randomUUID()}`).catch(() => undefined)
    if (Array.isArray(state?.tools)) mcpTools = state.tools
  }

  const tools = createCursorExecTools(exec, { mcpTools })

  for await (const part of provider.stream({ modelId, messages, signal: abortController.signal, tools })) {
    if (abortController.signal.aborted) break

    if (part.type === "text") {
      assistantText += part.text
      writeLocalMessage(res, encodeTextDelta(part.text))
    }

    if (part.type === "thinking") {
      writeLocalMessage(res, encodeThinkingDelta(part.text))
    }

    if (part.type === "tool-call" && part.executeLocal) {
      await execTool({ name: part.name, args: part.args ?? {}, callId: part.callId })
    }

    if (part.type === "tool-result") {
      // Tool results are already fed back into AI SDK-managed providers.
      // Cursor lifecycle events come from the local executor path.
    }
  }

  if (!abortController.signal.aborted) {
    appendLocalHistory(state, historyKey, text, assistantText)
  }
  writeLocalMessage(res, encodeTurnEnded())
}

function appendLocalHistory(state, key, userText, assistantText) {
  if (!key) return
  const history = state.localHistories.get(key) ?? []
  if (userText) history.push({ role: "user", content: userText })
  if (assistantText) history.push({ role: "assistant", content: assistantText })
  state.localHistories.set(key, history.slice(-20))
}

function writeLocalMessage(res, message) {
  if (res.destroyed) return
  res.write(connectEnvelope(message))
}

async function executeGatewayTool({
  res,
  pendingExecs,
  nextId,
  cwd,
  conversationId,
  generationId,
  modelId,
  provider,
  toolCall,
  state,
}) {
  const startedAt = Date.now()
  const name = normalizeGatewayToolName(toolCall.name)
  const callId = toolCall.callId ?? `tool-${randomUUID()}`
  let args = prepareCursorExecArgs(name, toolCall.args ?? {}, cwd)
  const runHooksInGateway = await hasHookConfig(cwd)

  try {
    if (runHooksInGateway) {
      const preHook = await executeCursorHookSafely({
        res,
        pendingExecs,
        nextId,
        hookType: "preToolUse",
        payload: {
          toolName: name,
          toolInput: args,
          toolUseId: callId,
          cwd,
          conversationId,
          generationId,
          model: modelId,
        },
      })

      if (preHook?.updatedInput) args = parseHookUpdatedInput(preHook.updatedInput, args)
      if (preHook?.permission && isBlockingHookPermission(preHook.permission)) {
        throw new Error(preHook.userMessage ?? preHook.agentMessage ?? `Tool call blocked by hook: ${name}`)
      }
    }

    const result = isGatewayHarnessTool(name)
      ? await executeHarnessToolWithEvents({ res, cwd, provider, name, args, callId, signal: toolCall.signal })
      : isManagedBackgroundTool(name)
        ? await executeManagedBackgroundTool({ state, name, args, cwd })
      : await executeCursorTool({
          res,
          pendingExecs,
          nextId,
          cwd,
          toolCall: { ...toolCall, name, args, callId },
        })

    if (runHooksInGateway) {
      await executeCursorHookSafely({
        res,
        pendingExecs,
        nextId,
        hookType: "postToolUse",
        payload: {
          toolName: name,
          toolInput: args,
          toolOutput: stringifyHookToolOutput(result),
          durationMs: Date.now() - startedAt,
          toolUseId: callId,
          cwd,
          conversationId,
          generationId,
          model: modelId,
        },
      })
    }

    return result
  } catch (error) {
    if (runHooksInGateway) {
      await executeCursorHookSafely({
        res,
        pendingExecs,
        nextId,
        hookType: "postToolUseFailure",
        payload: {
          toolName: name,
          toolInput: args,
          errorMessage: error?.message ?? String(error),
          failureType: "error",
          durationMs: Date.now() - startedAt,
          toolUseId: callId,
          isInterrupt: false,
          cwd,
          conversationId,
          generationId,
          model: modelId,
        },
      })
    }
    throw error
  }
}

function isManagedBackgroundTool(name) {
  return name === "background_shell" || name === "write_shell_stdin"
}

async function executeManagedBackgroundTool({ state, name, args, cwd }) {
  if (name === "background_shell") {
    const workingDirectory = args.workingDirectory
      ? resolve(String(args.workingDirectory))
      : resolve(cwd ?? process.cwd())
    const command = String(args.command ?? "")
    if (!command.trim()) throw new Error("background_shell requires a command.")

    const child = spawn(command, {
      cwd: workingDirectory,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    })
    const shellId = ++state.nextBackgroundShellId
    const record = {
      child,
      command,
      workingDirectory,
      stdout: "",
      stderr: "",
      startedAt: Date.now(),
    }

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => { record.stdout += chunk })
    child.stderr?.on("data", (chunk) => { record.stderr += chunk })
    child.once("close", (exitCode) => {
      record.exitCode = exitCode
      record.closedAt = Date.now()
      setTimeout(() => state.backgroundShells.delete(shellId), 60_000).unref?.()
    })
    child.once("error", (error) => {
      record.error = error
    })

    state.backgroundShells.set(shellId, record)

    return {
      status: "success",
      shellId,
      command,
      workingDirectory,
      pid: child.pid,
    }
  }

  if (name === "write_shell_stdin") {
    const shellId = Number(args.shellId ?? args.shell_id ?? 0)
    const record = state.backgroundShells.get(shellId)
    if (!record) throw new Error(`Shell not found: ${shellId}`)
    if (!record.child.stdin?.writable) throw new Error(`Shell stdin is not writable: ${shellId}`)

    const terminalFileLengthBeforeInputWritten = record.stdout.length + record.stderr.length
    await new Promise((resolvePromise, rejectPromise) => {
      record.child.stdin.write(String(args.chars ?? ""), (error) => {
        if (error) rejectPromise(error)
        else resolvePromise()
      })
    })

    return {
      status: "success",
      shellId,
      terminalFileLengthBeforeInputWritten,
    }
  }

  throw new Error(`Unsupported managed background tool: ${name}`)
}

function executeCursorTool({ res, pendingExecs, nextId, cwd, toolCall }) {
  const id = nextId()
  const execId = toolCall.callId ?? `tool-${id}`
  const args = prepareCursorExecArgs(toolCall.name, toolCall.args, cwd)
  const message = encodeExecServerToolCall({
    id,
    execId,
    name: toolCall.name,
    args,
  })

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingExecs.delete(id)
      reject(new Error(`Cursor local executor timed out for tool: ${toolCall.name}`))
    }, 120_000)

    pendingExecs.set(id, {
      result: undefined,
      resolve: (value) => {
        clearTimeout(timeout)
        try {
          writeLocalMessage(res, encodeToolCallCompleted({
            callId: execId,
            modelCallId: execId,
            name: toolCall.name,
            args,
            result: value,
          }))
        } catch {
          // Some low-level exec resources do not have a public ToolCall oneof in the current SDK.
        }
        resolve(value?.result ?? value)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    })

    try {
      writeLocalMessage(res, encodeToolCallStarted({
        callId: execId,
        modelCallId: execId,
        name: toolCall.name,
        args,
      }))
    } catch {
      // Keep execution authoritative even if the public lifecycle event cannot be represented.
    }
    writeLocalMessage(res, message)
  })
}

async function executeCursorHookSafely({ res, pendingExecs, nextId, hookType, payload }) {
  if (!(await hasHookConfig(payload.cwd))) {
    if (process.env.CURSOR_SDK_GATEWAY_DEBUG_HOOKS) {
      console.error(`[cursor-sdk-gateway] no hook config for ${payload.cwd}`)
    }
    return undefined
  }
  if (process.env.CURSOR_SDK_GATEWAY_DEBUG_HOOKS) {
    console.error(`[cursor-sdk-gateway] executing hook ${hookType} for ${payload.cwd}`)
  }
  return executeLocalCursorHook({ hookType, payload }).catch((error) => {
    if (process.env.CURSOR_SDK_GATEWAY_DEBUG_HOOKS) {
      console.error(`[cursor-sdk-gateway] hook ${hookType} failed: ${error?.message ?? String(error)}`)
    }
    return undefined
  })
}

function executeCursorHook({ res, pendingExecs, nextId, hookType, payload }) {
  const id = nextId()
  const execId = `hook-${id}`
  const message = encodeExecServerHookCall({ id, execId, hookType, payload })

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingExecs.delete(id)
      reject(new Error(`Cursor local executor timed out for hook: ${hookType}`))
    }, 30_000)

    pendingExecs.set(id, {
      result: undefined,
      resolve: (value) => {
        clearTimeout(timeout)
        resolve(value?.result ?? value)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    })

    writeLocalMessage(res, message)
  })
}

async function executeHarnessToolWithEvents({ res, cwd, provider, name, args, callId, signal }) {
  writeLocalMessage(res, encodeToolCallStarted({
    callId,
    modelCallId: callId,
    name,
    args,
  }))

  try {
    const result = await executeHarnessTool({ cwd, provider, name, args, signal })
    writeLocalMessage(res, encodeToolCallCompleted({
      callId,
      modelCallId: callId,
      name,
      args,
      result: { result },
    }))
    return result
  } catch (error) {
    const result = { status: "error", message: error?.message ?? String(error) }
    writeLocalMessage(res, encodeToolCallCompleted({
      callId,
      modelCallId: callId,
      name,
      args,
      result: { result },
    }))
    throw error
  }
}

async function executeHarnessTool({ cwd, provider, name, args, signal }) {
  if (name === "glob") return executeGlobTool(cwd, args)
  if (name === "semSearch") return executeSemSearchTool(cwd, args)
  if (name === "readLints") return executeReadLintsTool(cwd, args)
  if (name === "createPlan") return executeCreatePlanTool(args)
  if (name === "updateTodos") return executeUpdateTodosTool(args)
  if (name === "generateImage") return executeGenerateImageTool({ cwd, provider, args, signal })
  throw new Error(`Unsupported gateway harness tool: ${name}`)
}

async function executeGlobTool(cwd, args = {}) {
  const workspace = resolve(cwd)
  const targetDirectory = args.targetDirectory ?? "."
  const root = safeResolveWorkspace(workspace, targetDirectory)
  const pattern = String(args.globPattern ?? args.pattern ?? args.glob ?? "*")
  const regex = globPatternToRegExp(pattern)
  const files = await collectWorkspaceFiles(root, { maxFiles: 20_000 })
  const matches = []

  for (const file of files) {
    const fromRoot = normalizePath(relative(root, file))
    const fromWorkspace = normalizePath(relative(workspace, file))
    const base = fromRoot.split("/").pop() ?? fromRoot
    if (regex.test(fromRoot) || regex.test(fromWorkspace) || regex.test(base)) {
      matches.push(fromWorkspace)
    }
  }

  matches.sort()
  const limit = 10_000
  const visible = matches.slice(0, limit)
  return {
    status: "success",
    path: normalizePath(relative(workspace, root)) || ".",
    files: visible,
    totalFiles: matches.length,
    clientTruncated: matches.length > limit,
    ripgrepTruncated: false,
  }
}

async function executeSemSearchTool(cwd, args = {}) {
  const workspace = resolve(cwd)
  const query = String(args.query ?? "").trim()
  if (!query) return { status: "success", results: "No query provided.", codeResults: [] }

  const targetDirectories = Array.isArray(args.targetDirectories) && args.targetDirectories.length
    ? args.targetDirectories
    : ["."]
  const files = []
  for (const directory of targetDirectories) {
    const root = safeResolveWorkspace(workspace, directory)
    files.push(...await collectWorkspaceFiles(root, { maxFiles: 4_000 }))
  }

  const uniqueFiles = Array.from(new Set(files))
  const terms = query.toLowerCase().split(/[^a-z0-9_$.-]+/i).filter((term) => term.length > 1)
  const scored = []

  for (const file of uniqueFiles) {
    if (!isLikelySearchableFile(file)) continue
    let content
    try {
      content = await fs.readFile(file, "utf8")
    } catch {
      continue
    }
    if (content.includes("\u0000")) continue

    const lowerPath = normalizePath(relative(workspace, file)).toLowerCase()
    const lower = content.toLowerCase()
    let score = lower.includes(query.toLowerCase()) ? 10 : 0
    for (const term of terms) {
      if (lower.includes(term)) score += 2
      if (lowerPath.includes(term)) score += 3
    }
    if (score <= 0) continue

    scored.push({
      file,
      path: normalizePath(relative(workspace, file)),
      score,
      snippets: searchSnippets(content, query, terms),
    })
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  const top = scored.slice(0, 30)
  const lines = [`Found ${top.length} result${top.length === 1 ? "" : "s"} for "${query}".`]
  for (const item of top) {
    lines.push("", item.path)
    for (const snippet of item.snippets.slice(0, 3)) {
      lines.push(`  ${snippet.line}: ${snippet.text}`)
    }
  }

  return {
    status: "success",
    results: lines.join("\n"),
    codeResults: [],
  }
}

async function executeReadLintsTool(cwd, args = {}) {
  const workspace = resolve(cwd)
  const paths = Array.isArray(args.paths)
    ? args.paths.map(String)
    : [String(args.path ?? "")].filter(Boolean)
  const fileDiagnostics = []

  for (const path of paths) {
    safeResolveWorkspace(workspace, path)
    fileDiagnostics.push({
      path,
      diagnostics: [],
      diagnosticsCount: 0,
    })
  }

  return {
    status: "success",
    value: {
      fileDiagnostics,
      totalFiles: fileDiagnostics.length,
      totalDiagnostics: 0,
    },
  }
}

function executeCreatePlanTool(args = {}) {
  return {
    status: "success",
    value: {},
    plan: String(args.plan ?? ""),
  }
}

function executeUpdateTodosTool(args = {}) {
  const todos = Array.isArray(args.todos)
    ? args.todos.map((todo) => ({
        content: String(todo?.content ?? ""),
        status: normalizeTodoStatus(todo?.status),
      }))
    : []

  return {
    status: "success",
    value: {
      todos,
      totalCount: todos.length,
    },
  }
}

async function executeGenerateImageTool({ cwd, provider, args = {}, signal }) {
  if (!provider || typeof provider.generateImage !== "function") {
    return {
      status: "error",
      error: {
        message: "generateImage requires configureCursorGateway({ imageModel }) or image.model.",
      },
    }
  }

  try {
    const generated = await provider.generateImage({
      prompt: String(args.description ?? ""),
      signal,
    })
    const mediaType = generated.mediaType ?? "image/png"
    const outputPath = String(args.filePath ?? `generated-image.${extensionForMediaType(mediaType)}`)
    const target = safeResolveWorkspace(resolve(cwd), outputPath)
    await fs.mkdir(dirname(target), { recursive: true })
    await fs.writeFile(target, Buffer.from(generated.base64, "base64"))

    return {
      status: "success",
      value: {
        filePath: outputPath,
        imageData: generated.base64,
      },
    }
  } catch (error) {
    return {
      status: "error",
      error: {
        message: error?.message ?? String(error),
      },
    }
  }
}

function prepareCursorExecArgs(name, args = {}, cwd) {
  const toolName = normalizeGatewayToolName(name)
  if ((toolName === "shell" || toolName === "shell_stream" || toolName === "background_shell") && cwd) {
    const workingDirectory = args.workingDirectory ?? args.cwd ?? cwd
    return {
      ...args,
      workingDirectory: isAbsolute(String(workingDirectory))
        ? String(workingDirectory)
        : resolve(cwd, String(workingDirectory)),
    }
  }

  return args
}

function normalizeGatewayToolName(name) {
  if (name === "write_file") return "write"
  if (name === "read_file") return "read"
  if (name === "list_dir") return "ls"
  if (name === "bash" || name === "run_command") return "shell"
  if (name === "remove") return "delete"
  if (name === "web_fetch") return "fetch"
  if (name === "recordScreen") return "record_screen"
  if (name === "computerUse") return "computer_use"
  if (name === "writeShellStdin") return "write_shell_stdin"
  if (name === "listMcpResources") return "list_mcp_resources"
  if (name === "readMcpResource") return "read_mcp_resource"
  if (name === "mcpState") return "mcp_state"
  if (name === "backgroundShell") return "background_shell"
  if (name === "forceBackgroundShell") return "force_background_shell"
  if (name === "forceBackgroundSubagent") return "force_background_subagent"
  if (name === "subagentAwait") return "subagent_await"
  if (name === "sem_search" || name === "semantic_search") return "semSearch"
  if (name === "read_lints") return "readLints"
  if (name === "generate_image") return "generateImage"
  if (name === "create_plan") return "createPlan"
  if (name === "update_todos") return "updateTodos"
  return name ?? "unknown"
}

function isGatewayHarnessTool(name) {
  return name === "glob" ||
    name === "semSearch" ||
    name === "readLints" ||
    name === "createPlan" ||
    name === "updateTodos" ||
    name === "generateImage"
}

function normalizeTodoStatus(status) {
  if (status === "in_progress" || status === "in-progress" || status === "inProgress") return "inProgress"
  if (status === "completed" || status === "complete" || status === "done") return "completed"
  if (status === "cancelled" || status === "canceled") return "cancelled"
  return "pending"
}

function extensionForMediaType(mediaType) {
  if (mediaType === "image/jpeg") return "jpg"
  if (mediaType === "image/webp") return "webp"
  if (mediaType === "image/gif") return "gif"
  return "png"
}

function isBlockingHookPermission(permission) {
  const value = String(permission).toLowerCase()
  return value.includes("deny") || value.includes("block")
}

function parseHookUpdatedInput(updatedInput, fallback) {
  if (updatedInput && typeof updatedInput === "object" && !Array.isArray(updatedInput)) return updatedInput
  if (typeof updatedInput !== "string" || !updatedInput.trim()) return fallback
  try {
    const parsed = JSON.parse(updatedInput)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function stringifyHookToolOutput(value) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function safeResolveWorkspace(workspace, path = ".") {
  const resolved = isAbsolute(String(path)) ? resolve(String(path)) : resolve(workspace, String(path))
  const relativePath = relative(workspace, resolved)
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) return resolved
  throw new Error(`Path escapes workspace: ${path}`)
}

async function collectWorkspaceFiles(root, { maxFiles }) {
  const files = []
  const stack = [root]

  while (stack.length && files.length < maxFiles) {
    const current = stack.pop()
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (shouldSkipEntry(entry.name)) continue
      const path = resolve(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
      } else if (entry.isFile()) {
        files.push(path)
        if (files.length >= maxFiles) break
      }
    }
  }

  return files
}

function shouldSkipEntry(name) {
  return [
    ".git",
    "node_modules",
    ".next",
    ".turbo",
    ".cache",
    "dist",
    "build",
    "coverage",
  ].includes(name)
}

function globPatternToRegExp(pattern) {
  const normalized = normalizePath(pattern || "*")
  let source = "^"

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    const next = normalized[index + 1]

    if (char === "*") {
      if (next === "*") {
        const after = normalized[index + 2]
        if (after === "/") {
          source += "(?:.*\\/)?"
          index += 2
        } else {
          source += ".*"
          index += 1
        }
      } else {
        source += "[^/]*"
      }
      continue
    }

    if (char === "?") {
      source += "[^/]"
      continue
    }

    if (char === "{") {
      const close = normalized.indexOf("}", index + 1)
      if (close !== -1) {
        const body = normalized.slice(index + 1, close)
        source += `(?:${body.split(",").map(escapeRegExp).join("|")})`
        index = close
        continue
      }
    }

    source += escapeRegExp(char)
  }

  source += "$"
  return new RegExp(source)
}

function searchSnippets(content, query, terms) {
  const queryLower = query.toLowerCase()
  const lines = content.split(/\r?\n/)
  const snippets = []

  for (let index = 0; index < lines.length && snippets.length < 5; index += 1) {
    const lower = lines[index].toLowerCase()
    if (lower.includes(queryLower) || terms.some((term) => lower.includes(term))) {
      snippets.push({
        line: index + 1,
        text: lines[index].trim().slice(0, 220),
      })
    }
  }

  return snippets.length ? snippets : [{ line: 1, text: lines[0]?.trim().slice(0, 220) ?? "" }]
}

function isLikelySearchableFile(path) {
  const normalized = normalizePath(path)
  if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|tgz|mp4|mov|mp3|woff2?|ttf|otf)$/i.test(normalized)) return false
  return true
}

function normalizePath(path) {
  return String(path).split(sep).join("/")
}

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
}

async function hasHookConfig(cwd) {
  const workspace = resolve(cwd ?? process.cwd())
  const key = `${workspace}:${process.env.HOME ?? ""}`
  if (HOOK_CONFIG_CACHE.has(key)) return HOOK_CONFIG_CACHE.get(key)

  for (const candidate of hookConfigCandidates(workspace)) {
    try {
      await fs.access(candidate)
      HOOK_CONFIG_CACHE.set(key, true)
      return true
    } catch {
      // Keep looking.
    }
  }

  if (await hasManagedHooks()) {
    HOOK_CONFIG_CACHE.set(key, true)
    return true
  }

  HOOK_CONFIG_CACHE.set(key, false)
  return false
}

function hookConfigCandidates(workspace) {
  return [
    resolve(workspace, ".cursor/hooks.json"),
    ...(process.env.HOME ? [resolve(process.env.HOME, ".cursor/hooks.json")] : []),
    ...(process.platform === "darwin" ? ["/Library/Application Support/Cursor/hooks.json"] : []),
    ...(process.platform === "linux" ? ["/etc/cursor/hooks.json"] : []),
    ...(process.platform === "win32" ? ["C:\\ProgramData\\Cursor\\hooks.json"] : []),
  ]
}

async function executeLocalCursorHook({ hookType, payload }) {
  const workspace = resolve(payload.cwd ?? process.cwd())
  const config = await readFirstHookConfig(workspace)
  const scripts = config?.hooks?.[hookType]
  if (!Array.isArray(scripts) || scripts.length === 0) return undefined

  const input = cursorHookInput(hookType, payload)
  const toolName = hookMatcherToolName(hookType, input)
  let merged

  for (const script of scripts) {
    if (!script || typeof script !== "object") continue
    if (!hookMatcherAllows(script.matcher, toolName)) continue
    if (script.type === "prompt") continue
    if (typeof script.command !== "string" || !script.command.trim()) continue

    const response = await runCommandHook(script, input, workspace)
    if (response && typeof response === "object") {
      merged = { ...(merged ?? {}), ...normalizeHookResponse(response) }
    }
  }

  return merged
}

async function readFirstHookConfig(workspace) {
  for (const candidate of hookConfigCandidates(workspace)) {
    try {
      return JSON.parse(await fs.readFile(candidate, "utf8"))
    } catch {
      // Keep looking.
    }
  }
  return undefined
}

function cursorHookInput(hookType, payload) {
  if (hookType === "preToolUse") {
    return {
      conversation_id: payload.conversationId ?? "",
      generation_id: payload.generationId ?? "",
      model: payload.model ?? "",
      tool_name: payload.toolName ?? "",
      tool_input: payload.toolInput ?? {},
      tool_use_id: payload.toolUseId ?? "",
      cwd: payload.cwd ?? "",
    }
  }

  if (hookType === "postToolUse") {
    return {
      conversation_id: payload.conversationId ?? "",
      generation_id: payload.generationId ?? "",
      model: payload.model ?? "",
      tool_name: payload.toolName ?? "",
      tool_input: payload.toolInput ?? {},
      tool_output: payload.toolOutput ?? "",
      duration_ms: payload.durationMs ?? 0,
      tool_use_id: payload.toolUseId ?? "",
      cwd: payload.cwd ?? "",
    }
  }

  if (hookType === "postToolUseFailure") {
    return {
      conversation_id: payload.conversationId ?? "",
      generation_id: payload.generationId ?? "",
      model: payload.model ?? "",
      tool_name: payload.toolName ?? "",
      tool_input: payload.toolInput ?? {},
      error_message: payload.errorMessage ?? "",
      failure_type: payload.failureType ?? "error",
      duration_ms: payload.durationMs ?? 0,
      tool_use_id: payload.toolUseId ?? "",
      is_interrupt: Boolean(payload.isInterrupt),
      cwd: payload.cwd ?? "",
    }
  }

  return payload
}

function hookMatcherToolName(hookType, input) {
  if (hookType === "preToolUse" || hookType === "postToolUse" || hookType === "postToolUseFailure") {
    return input.tool_name
  }
  return undefined
}

function hookMatcherAllows(matcher, toolName) {
  if (!matcher || matcher === "*") return true
  if (toolName === undefined) return true
  try {
    return new RegExp(String(matcher)).test(String(toolName))
  } catch {
    return true
  }
}

function runCommandHook(script, input, cwd) {
  const timeoutMs = Number.isFinite(script.timeout) ? Math.max(1, Number(script.timeout)) * 1000 : 60_000

  return new Promise((resolve, reject) => {
    const child = spawn(script.command, {
      cwd,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const timeout = setTimeout(() => {
      child.kill("SIGTERM")
      finish(new Error(`Hook timed out after ${timeoutMs}ms: ${script.command}`))
    }, timeoutMs)

    const finish = (error, code = 0) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) {
        if (script.failClosed) reject(error)
        else resolve(undefined)
        return
      }
      if (code !== 0) {
        const failure = new Error(stderr.trim() || `Hook exited with code ${code}: ${script.command}`)
        if (script.failClosed) reject(failure)
        else resolve(undefined)
        return
      }
      resolve(parseHookStdout(stdout))
    }

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", (error) => finish(error))
    child.on("close", (code) => finish(undefined, code ?? 0))
    child.stdin.end(`${JSON.stringify(input)}\n`)
  })
}

function parseHookStdout(stdout) {
  const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index])
    } catch {
      // Keep looking for a JSON line.
    }
  }
  return undefined
}

function normalizeHookResponse(response) {
  return {
    ...(response.permission !== undefined ? { permission: response.permission } : {}),
    ...(response.user_message !== undefined ? { userMessage: response.user_message } : {}),
    ...(response.userMessage !== undefined ? { userMessage: response.userMessage } : {}),
    ...(response.agent_message !== undefined ? { agentMessage: response.agent_message } : {}),
    ...(response.agentMessage !== undefined ? { agentMessage: response.agentMessage } : {}),
    ...(response.updated_input !== undefined ? { updatedInput: response.updated_input } : {}),
    ...(response.updatedInput !== undefined ? { updatedInput: response.updatedInput } : {}),
    ...(response.additional_context !== undefined ? { additionalContext: response.additional_context } : {}),
    ...(response.additionalContext !== undefined ? { additionalContext: response.additionalContext } : {}),
  }
}

async function hasManagedHooks() {
  if (!process.env.HOME) return false
  const managedRoot = resolve(process.env.HOME, ".cursor/managed")
  let entries

  try {
    entries = await fs.readdir(managedRoot, { withFileTypes: true })
  } catch {
    return false
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      await fs.access(resolve(managedRoot, entry.name, "hooks"))
      return true
    } catch {
      // Keep looking.
    }
  }

  return false
}

function handleCursorExecClientMessage(message, pendingExecs) {
  if (message.type === "exec_result") {
    if (process.env.CURSOR_SDK_GATEWAY_DEBUG_EXEC) {
      console.error(`[cursor-sdk-gateway] exec ${message.id} result ${message.name}: ${JSON.stringify(message.result)}`)
    }
    const pending = pendingExecs.get(message.id)
    if (pending) pending.result = message
    return
  }

  if (message.type === "exec_stream_close") {
    const pending = pendingExecs.get(message.id)
    if (!pending) return
    pendingExecs.delete(message.id)
    pending.resolve(pending.result ?? { status: "success" })
    return
  }

  if (message.type === "exec_throw") {
    if (process.env.CURSOR_SDK_GATEWAY_DEBUG_EXEC) {
      console.error(`[cursor-sdk-gateway] exec ${message.id} threw: ${message.error}`)
    }
    const pending = pendingExecs.get(message.id)
    if (!pending) return
    pendingExecs.delete(message.id)
    pending.reject(new Error(message.error))
  }
}

function createRun(state, agent, { prompt, model }) {
  const now = isoNow()
  const run = {
    id: `run-${randomUUID()}`,
    agentId: agent.id,
    status: "CREATING",
    createdAt: now,
    updatedAt: now,
    prompt,
    model,
    result: undefined,
    durationMs: undefined,
    git: { branches: [] },
    started: false,
    eventSeq: 0,
    events: [],
    listeners: new Set(),
    abortController: new AbortController(),
    toolCalls: new Map(),
  }

  state.runs.set(run.id, run)
  const runs = state.runsByAgent.get(agent.id) ?? []
  runs.unshift(run.id)
  state.runsByAgent.set(agent.id, runs)
  agent.latestRunId = run.id
  agent.updatedAt = now
  return run
}

function streamRun({ req, res, run, state, provider }) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-cursor-stream-retention-seconds": "300",
  })

  for (const event of run.events) writeSse(res, event)

  if (isTerminal(run.status) && run.events.some((event) => event.event === "done")) {
    res.end()
    return
  }

  const listener = (event) => writeSse(res, event)
  run.listeners.add(listener)
  req.on("close", () => run.listeners.delete(listener))

  if (!run.started) startRun({ run, state, provider })
}

async function startRun({ run, state, provider }) {
  run.started = true
  run.status = "RUNNING"
  run.updatedAt = isoNow()
  const startedAt = Date.now()
  const agent = state.agents.get(run.agentId)
  let fullText = ""

  appendRunEvent(run, "status", { runId: run.id, status: "RUNNING" })
  appendRunEvent(run, "interaction_update", { type: "user-message-appended", userMessage: { text: run.prompt.text } })

  try {
    if (!run.model?.id) throw new Error("No model id provided. Pass model: { id: \"provider/model\" } to Agent.create() or agent.send().")

    const messages = [...(agent?.history ?? []), { role: "user", content: run.prompt.text }]
    const tools = createWorkspaceTools(agent?.cwd ?? process.cwd())

    for await (const part of provider.stream({ modelId: run.model.id, messages, signal: run.abortController.signal, tools })) {
      if (part.type === "text") {
        fullText += part.text
        appendRunEvent(run, "interaction_update", { type: "text-delta", text: part.text })
        appendRunEvent(run, "assistant", { text: part.text })
      }

      if (part.type === "thinking") {
        appendRunEvent(run, "interaction_update", { type: "thinking-delta", text: part.text })
        appendRunEvent(run, "thinking", { text: part.text })
      }

      if (part.type === "tool-call") {
        const toolCall = cursorToolCallFromPart(part)
        run.toolCalls.set(part.callId, {
          name: part.name,
          args: part.args,
        })
        appendRunEvent(run, "tool_call", {
          callId: part.callId,
          name: part.name,
          status: "running",
          args: part.args,
        })
        appendRunEvent(run, "interaction_update", {
          type: "tool-call-started",
          callId: part.callId,
          modelCallId: part.callId,
          toolCall,
        })
      }

      if (part.type === "tool-result") {
        const startedToolCall = run.toolCalls.get(part.callId)
        const completedPart = {
          ...part,
          name: startedToolCall?.name ?? part.name,
          args: startedToolCall?.args ?? part.args,
        }
        const toolCall = cursorToolCallFromPart(completedPart, part.result)
        appendRunEvent(run, "tool_call", {
          callId: part.callId,
          name: completedPart.name,
          status: "completed",
          result: part.result,
        })
        appendRunEvent(run, "interaction_update", {
          type: "tool-call-completed",
          callId: part.callId,
          modelCallId: part.callId,
          toolCall,
        })
      }
    }

    run.status = "FINISHED"
    run.result = fullText.trim()
    run.durationMs = Date.now() - startedAt
    run.updatedAt = isoNow()
    agent?.history.push({ role: "user", content: run.prompt.text }, { role: "assistant", content: run.result })

    appendRunEvent(run, "interaction_update", { type: "turn-ended" })
    appendRunEvent(run, "result", {
      runId: run.id,
      status: "FINISHED",
      result: run.result,
      durationMs: run.durationMs,
      git: run.git,
    })
    appendRunEvent(run, "done", {})
  } catch (error) {
    if (run.abortController.signal.aborted) {
      run.status = "CANCELLED"
      run.result = fullText.trim()
      run.updatedAt = isoNow()
      appendRunEvent(run, "result", { runId: run.id, status: "CANCELLED", result: run.result })
      appendRunEvent(run, "done", {})
      closeRunListeners(run)
      return
    }

    const message = error?.message ?? String(error)
    run.status = "ERROR"
    run.result = message
    run.durationMs = Date.now() - startedAt
    run.updatedAt = isoNow()
    appendRunEvent(run, "status", { runId: run.id, status: "ERROR", message })
    appendRunEvent(run, "result", { runId: run.id, status: "ERROR", result: message, durationMs: run.durationMs })
    appendRunEvent(run, "done", {})
  } finally {
    closeRunListeners(run)
  }
}

function appendRunEvent(run, event, data) {
  const item = { id: String(++run.eventSeq), event, data }
  run.events.push(item)
  for (const listener of run.listeners) listener(item)
}

function closeRunListeners(run) {
  for (const listener of run.listeners) listener({ id: String(++run.eventSeq), event: "done", data: {} })
  run.listeners.clear()
}

function writeSse(res, item) {
  res.write(`id: ${item.id}\n`)
  res.write(`event: ${item.event}\n`)
  res.write(`data: ${JSON.stringify(item.data ?? {})}\n\n`)
}

function publicAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    env: agent.env,
    repos: agent.repos,
    autoCreatePR: agent.autoCreatePR,
    skipReviewerRequest: agent.skipReviewerRequest,
    url: agent.url,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    latestRunId: agent.latestRunId,
  }
}

function publicRun(run) {
  return {
    id: run.id,
    agentId: run.agentId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.result !== undefined ? { result: run.result } : {}),
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
    ...(run.git ? { git: run.git } : {}),
    ...(run.model ? { model: run.model } : {}),
  }
}

function normalizePrompt(prompt) {
  if (typeof prompt === "string") return { text: prompt }
  return {
    text: prompt?.text ?? "",
    ...(Array.isArray(prompt?.images) ? { images: prompt.images } : {}),
  }
}

function isTerminal(status) {
  return status === "FINISHED" || status === "ERROR" || status === "CANCELLED"
}

async function readJson(req) {
  const raw = await new Promise((resolve, reject) => {
    let body = ""
    req.setEncoding("utf8")
    req.on("data", (chunk) => { body += chunk })
    req.on("end", () => resolve(body))
    req.on("error", reject)
  })
  return raw ? JSON.parse(raw) : {}
}

function sendJson(res, status, value) {
  if (res.headersSent) return
  res.writeHead(status, {
    "content-type": "application/json",
    "x-request-id": `csg_${randomUUID()}`,
  })
  res.end(JSON.stringify(value))
}

function sendProto(res, status, bytes = Buffer.alloc(0)) {
  if (res.headersSent) return
  res.writeHead(status, {
    "content-type": "application/proto",
    "x-request-id": `csg_${randomUUID()}`,
  })
  res.end(bytes)
}

function isoNow() {
  return new Date().toISOString()
}
