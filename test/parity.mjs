import { createServer } from "node:http"
import { once } from "node:events"
import { promises as fs } from "node:fs"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { configureCursorGateway, closeCursorGateway } from "../src/index.js"

const root = resolve("demo-runs", `smoke-${Date.now()}`)
await fs.rm(root, { recursive: true, force: true })
await fs.mkdir(root, { recursive: true })

const provider = await startMockOpenAICompatibleProvider()
const gateway = await configureCursorGateway({
  provider: "openai-compatible",
  baseURL: `${provider.url}/v1`,
  apiKey: "test-key",
  imageModel: "test/image",
})

const { Agent } = await import("@cursor/sdk")

try {
  await testConversationHistory(Agent, provider)
  await testLocalTools(Agent, provider)
  await testHarnessTools(Agent, provider)
  await testPublicToolParity(Agent, provider)
  await testMcp(Agent, provider)
  await testHooks(Agent, provider)
  await testBackgroundShell(Agent, provider)
  await testSubagents(Agent, provider)

  console.log(JSON.stringify({ ok: true, root }, null, 2))
} finally {
  await closeCursorGateway().catch(() => {})
  await gateway.close().catch(() => {})
  await provider.close().catch(() => {})
}

async function testConversationHistory(Agent, provider) {
  const cwd = await workspace("conversation-history")
  provider.setScenario("conversation-history", [
    (body) => {
      assert(conversationText(body).includes("Remember the phrase gateway-memory-42"), "first prompt missing")
      return streamText(undefined, "I will remember gateway-memory-42.")
    },
    (body) => {
      const text = conversationText(body)
      assert(text.includes("Remember the phrase gateway-memory-42"), `previous user message missing: ${text}`)
      assert(text.includes("I will remember gateway-memory-42."), `previous assistant message missing: ${text}`)
      return streamText(undefined, "gateway-memory-42")
    },
  ])

  const agent = await Agent.create({ model: { id: "test/model" }, local: { cwd } })
  try {
    const first = await collectRun(await agent.send("Remember the phrase gateway-memory-42."))
    assert(first.result.status === "finished", `conversation first status ${first.result.status}`)

    const second = await collectRun(await agent.send("What phrase did I ask you to remember?"))
    assert(second.result.status === "finished", `conversation second status ${second.result.status}`)
    assert(String(second.result.result ?? "").includes("gateway-memory-42"), `conversation result mismatch: ${second.result.result}`)
  } finally {
    await agent[Symbol.asyncDispose]()
  }
}

async function testLocalTools(Agent, provider) {
  const cwd = await workspace("local-tools")
  provider.setScenario("local-tools", [
    toolResponse("write-1", "write", { path: "notes/alpha.txt", fileText: "alpha needle\n", returnFileContentAfterWrite: true }),
    toolResponse("read-1", "read", { path: "notes/alpha.txt" }),
    toolResponse("grep-1", "grep", { pattern: "needle", path: "notes", headLimit: 5 }),
    toolResponse("shell-1", "shell", { command: "printf shell-ok", workingDirectory: cwd, description: "smoke test shell" }),
    toolResponse("delete-1", "delete", { path: "notes/alpha.txt" }),
    textResponse("local tools done"),
  ])

  const { events, result } = await runAgent(Agent, cwd, "local-tools")
  assert(result.status === "finished", `local-tools status ${result.status}`)
  assert(events.some((event) => event.type === "tool_call" && ["write", "edit"].includes(event.name) && event.status === "completed"), `write/edit completed event missing: ${toolEventSummary(events)}`)
  assert(events.some((event) => event.type === "tool_call" && event.name === "shell" && event.status === "completed"), `shell completed event missing: ${toolEventSummary(events)}`)
  assert(!existsSync(join(cwd, "notes/alpha.txt")), "delete did not remove notes/alpha.txt")
}

async function testHarnessTools(Agent, provider) {
  const cwd = await workspace("harness-tools")
  await fs.writeFile(join(cwd, "src-file.ts"), "export const gatewayNeedle = 'semantic needle';\n", "utf8")
  provider.setScenario("harness-tools", [
    toolResponse("glob-1", "glob", { globPattern: "*.ts", targetDirectory: "." }),
    toolResponse("sem-1", "semSearch", { query: "gatewayNeedle", targetDirectories: ["."], explanation: "smoke test" }),
    textResponse("harness tools done"),
  ])

  const { events, result } = await runAgent(Agent, cwd, "harness-tools")
  assert(result.status === "finished", `harness-tools status ${result.status}`)
  assert(events.some((event) => event.type === "tool_call" && event.name === "glob" && event.status === "completed"), `glob completed event missing: ${toolEventSummary(events)}`)
  assert(events.some((event) => event.type === "tool_call" && event.name === "semSearch" && event.status === "completed"), `semSearch completed event missing: ${toolEventSummary(events)}`)
}

async function testPublicToolParity(Agent, provider) {
  const cwd = await workspace("public-tool-parity")
  await fs.writeFile(join(cwd, "lint-target.ts"), "export const parity = true;\n", "utf8")
  provider.setScenario("public-tool-parity", [
    toolResponse("lints-1", "readLints", { paths: ["lint-target.ts"] }),
    toolResponse("plan-1", "createPlan", { plan: "Check public Cursor tool compatibility." }),
    toolResponse("todos-1", "updateTodos", {
      todos: [
        { content: "check public tool names", status: "inProgress" },
        { content: "finish parity smoke", status: "completed" },
      ],
    }),
    toolResponse("image-1", "generateImage", { description: "A tiny gateway smoke test image.", filePath: "image.png" }),
    textResponse("public tool parity done"),
  ])

  const { events, result } = await runAgent(Agent, cwd, "public-tool-parity")
  assert(result.status === "finished", `public-tool-parity status ${result.status}`)
  for (const name of ["readLints", "createPlan", "updateTodos", "generateImage"]) {
    assert(events.some((event) => event.type === "tool_call" && event.name === name && event.status === "completed"), `${name} completed event missing: ${toolEventSummary(events)}`)
  }
  await fs.access(join(cwd, "image.png"))
}

async function testMcp(Agent, provider) {
  const cwd = await workspace("mcp")
  const logPath = join(cwd, "mcp-calls.jsonl")
  const serverPath = join(cwd, "mcp-server.mjs")
  await fs.writeFile(serverPath, mcpServerSource(logPath), "utf8")

  provider.setScenario("mcp", [
    (body) => {
      const toolName = modelToolNames(body).find((name) => name.includes("echo"))
      assert(toolName, `dynamic MCP echo tool was not exposed: ${modelToolNames(body).join(",")}`)
      return streamTool("mcp-1", toolName, { text: "hello" })
    },
    textResponse("mcp done"),
  ])

  const agent = await Agent.create({
    model: { id: "test/model" },
    local: { cwd },
    mcpServers: {
      demo: {
        type: "stdio",
        command: process.execPath,
        args: [serverPath],
        cwd,
      },
    },
  })

  const { events, result } = await collectRun(await agent.send("mcp"))
  await agent[Symbol.asyncDispose]()

  assert(result.status === "finished", `mcp status ${result.status}`)
  assert(events.some((event) => event.type === "tool_call" && event.name === "mcp" && event.status === "completed"), `mcp completed event missing: ${toolEventSummary(events)}`)
  const log = await fs.readFile(logPath, "utf8")
  assert(log.includes('"method":"tools/call"'), "MCP server did not receive tools/call")
}

async function testHooks(Agent, provider) {
  const cwd = await workspace("hooks")
  await fs.mkdir(join(cwd, ".cursor"), { recursive: true })
  const hookPath = join(cwd, "hook.mjs")
  await fs.writeFile(hookPath, hookSource(join(cwd, "hook-log.jsonl")), "utf8")
  await fs.writeFile(join(cwd, ".cursor/hooks.json"), JSON.stringify({
    version: 1,
    hooks: {
      preToolUse: [{ matcher: ".*", command: `${shellQuote(process.execPath)} ${shellQuote(hookPath)} pre` }],
      postToolUse: [{ matcher: ".*", command: `${shellQuote(process.execPath)} ${shellQuote(hookPath)} post` }],
      afterFileEdit: [{ matcher: ".*", command: `${shellQuote(process.execPath)} ${shellQuote(hookPath)} afterFileEdit` }],
    },
  }, null, 2), "utf8")

  provider.setScenario("hooks", [
    toolResponse("glob-hook", "glob", { globPattern: "*.txt", targetDirectory: "." }),
    textResponse("hooks done"),
  ])

  const agent = await Agent.create({
    model: { id: "test/model" },
    local: { cwd, settingSources: ["project"] },
  })

  const { events, result } = await collectRun(await agent.send("hooks"))
  await agent[Symbol.asyncDispose]()

  assert(result.status === "finished", `hooks status ${result.status}`)
  assert(events.some((event) => event.type === "tool_call" && event.name === "glob" && event.status === "completed"), `hook glob completed event missing: ${toolEventSummary(events)}`)
  const log = await fs.readFile(join(cwd, "hook-log.jsonl"), "utf8")
  assert(log.includes('"label":"pre"'), `preToolUse hook did not execute: ${log}`)
  assert(log.includes('"label":"post"'), `postToolUse hook did not execute: ${log}`)
}

async function testBackgroundShell(Agent, provider) {
  const cwd = await workspace("background-shell")
  const command = "sh -c 'IFS= read -r line; printf \"%s\\n\" \"$line\" > bg-stdin.txt'"

  provider.setScenario("background-shell", [
    toolResponse("bg-1", "background_shell", { command, workingDirectory: cwd, enableWriteShellStdinTool: true, description: "capture stdin" }),
    (body) => {
      const bgResult = toolResultFor(body, "bg-1")
      assert(bgResult?.shellId, `missing background shell id: ${JSON.stringify(body.messages)}`)
      return streamTool("stdin-1", "write_shell_stdin", { shellId: bgResult.shellId, chars: "hello-bg\n" })
    },
    (body) => {
      const stdinResult = toolResultFor(body, "stdin-1")
      assert(stdinResult?.status === "success", `write_shell_stdin failed: ${JSON.stringify(stdinResult)}`)
      return streamText(undefined, "background shell done")
    },
  ])

  const { result } = await runAgent(Agent, cwd, "background-shell")
  assert(result.status === "finished", `background-shell status ${result.status}`)
  await waitFor(async () => (await fs.readFile(join(cwd, "bg-stdin.txt"), "utf8")) === "hello-bg\n", "background stdin file was not written")
}

async function testSubagents(Agent, provider) {
  const cwd = await workspace("subagents")
  provider.setScenario("subagents", [
    toolResponse("task-1", "task", {
      description: "write subagent file",
      prompt: "Create subagent.txt with exact text subagent-ok.",
      subagentType: "demo-writer",
      modelId: "test/model",
    }),
    toolResponse("sub-write", "write", { path: "subagent.txt", fileText: "subagent-ok\n" }),
    textResponse("subagent complete"),
    textResponse("parent complete"),
  ])

  const agent = await Agent.create({
    model: { id: "test/model" },
    local: { cwd },
    agents: {
      "demo-writer": {
        description: "Writes exactly the requested file.",
        prompt: "You write files exactly as requested.",
        model: "inherit",
      },
    },
  })

  const { events, result } = await collectRun(await agent.send("subagents"))
  await agent[Symbol.asyncDispose]()

  assert(result.status === "finished", `subagents status ${result.status}: ${result.result ?? ""}; events=${toolEventSummary(events)}; all=${JSON.stringify(events)}`)
  assert(events.some((event) => event.type === "tool_call" && event.name === "task" && event.status === "completed"), `task completed event missing: ${toolEventSummary(events)}`)
  const file = await fs.readFile(join(cwd, "subagent.txt"), "utf8")
  assert(file === "subagent-ok\n", "subagent did not write expected file")
}

async function runAgent(Agent, cwd, prompt) {
  const agent = await Agent.create({ model: { id: "test/model" }, local: { cwd } })
  try {
    return await collectRun(await agent.send(prompt))
  } finally {
    await agent[Symbol.asyncDispose]()
  }
}

async function collectRun(run) {
  const events = []
  for await (const event of run.stream()) events.push(event)
  const result = await run.wait()
  return { events, result }
}

async function workspace(name) {
  const cwd = join(root, name)
  await fs.mkdir(cwd, { recursive: true })
  return cwd
}

function startMockOpenAICompatibleProvider() {
  const state = { scenarioName: undefined, queue: [], requests: [] }
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
      return sendJson(res, { data: [{ id: "test/model", name: "Test Model" }] })
    }

    if (req.method === "POST" && req.url.endsWith("/images/generations")) {
      await readBody(req)
      return sendJson(res, {
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: tinyPngBase64() }],
      })
    }

    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
      res.writeHead(404).end("not found")
      return
    }

    const body = JSON.parse(await readBody(req))
    state.requests.push(body)
    const next = state.queue.shift()
    if (!next) return streamText(res, `No queued response for ${state.scenarioName}`)
    const response = next(body, res)
    if (typeof response === "function") return response(res)
    return response
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests: state.requests,
        setScenario(name, queue) {
          state.scenarioName = name
          state.queue = [...queue]
          state.requests.length = 0
        },
        async close() {
          server.close()
          await once(server, "close").catch(() => {})
        },
      })
    })
  })
}

function toolResponse(id, name, args) {
  return () => streamTool(id, name, args)
}

function textResponse(text) {
  return () => streamText(undefined, text)
}

function streamTool(id, name, args) {
  return (res) => {
    res.writeHead(200, streamHeaders())
    writeSse(res, {
      id: "chatcmpl-smoke",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "test/model",
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        finish_reason: null,
      }],
    })
    writeSse(res, {
      id: "chatcmpl-smoke",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "test/model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })
    res.end("data: [DONE]\n\n")
  }
}

function streamText(res, text) {
  if (!res) return (actualRes) => streamText(actualRes, text)
  res.writeHead(200, streamHeaders())
  writeSse(res, {
    id: "chatcmpl-smoke",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "test/model",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  })
  writeSse(res, {
    id: "chatcmpl-smoke",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "test/model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })
  res.end("data: [DONE]\n\n")
}

function streamHeaders() {
  return {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  }
}

function writeSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function sendJson(res, value) {
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(value))
}

function tinyPngBase64() {
  return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
}

async function readBody(req) {
  let body = ""
  req.setEncoding("utf8")
  for await (const chunk of req) body += chunk
  return body
}

function modelToolNames(body) {
  return (body.tools ?? []).map((entry) => entry.function?.name ?? entry.name).filter(Boolean)
}

function conversationText(body) {
  return (body.messages ?? []).map((message) => contentText(message.content)).join("\n")
}

function contentText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part) => part.text ?? part.content ?? "").join(" ")
  return ""
}

function toolResultFor(body, callId) {
  for (const message of body.messages ?? []) {
    if (message.role !== "tool" || message.tool_call_id !== callId) continue
    if (typeof message.content !== "string") continue
    try {
      return JSON.parse(message.content)
    } catch {
      return undefined
    }
  }
  return undefined
}

function mcpServerSource(logPath) {
  return `
import { appendFileSync } from "node:fs"
const logPath = ${JSON.stringify(logPath)}
let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf("\\n")
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) handle(JSON.parse(line))
    newline = buffer.indexOf("\\n")
  }
})
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n")
}
function handle(message) {
  appendFileSync(logPath, JSON.stringify(message) + "\\n")
  if (message.method === "initialize") return send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "demo", version: "1.0.0" } })
  if (message.method === "tools/list") return send(message.id, { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] })
  if (message.method === "resources/list") return send(message.id, { resources: [] })
  if (message.method === "tools/call") return send(message.id, { content: [{ type: "text", text: "echo:" + (message.params?.arguments?.text ?? "") }] })
  if (message.id !== undefined) return send(message.id, {})
}
`
}

function hookSource(logPath) {
  return `
import { appendFileSync } from "node:fs"
const label = process.argv[2] ?? "hook"
let input = ""
process.stdin.setEncoding("utf8")
for await (const chunk of process.stdin) input += chunk
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ label, input: input ? JSON.parse(input) : null }) + "\\n")
process.stdout.write(JSON.stringify({}) + "\\n")
`
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

async function waitFor(check, message) {
  const deadline = Date.now() + 5000
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function toolEventSummary(events) {
  return events
    .filter((event) => event.type === "tool_call")
    .map((event) => `${event.name}:${event.status}`)
    .join(",") || "no tool_call events"
}
