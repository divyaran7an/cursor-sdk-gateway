// Local HTTP shim. The gateway treats it as a normal openai-compatible
// endpoint; behind the scenes it forwards to api.darkbloom.dev, forces
// non-streaming upstream, and synthesizes the streaming SSE the AI SDK
// expects on the way back. Self-contained — see README for the why.

import http from "node:http"

const DARKBLOOM_URL = "https://api.darkbloom.dev/v1"

export async function startDarkbloomBridge({ apiKey }) {
  if (!apiKey) throw new Error("DARKBLOOM_API_KEY is not set")

  const server = http.createServer((req, res) => {
    handle(req, res, apiKey).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: String(err?.message ?? err) } }))
    })
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()

  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

async function handle(req, res, apiKey) {
  if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
    return handleChat(req, res, apiKey)
  }
  return passthrough(req, res, apiKey)
}

async function handleChat(req, res, apiKey) {
  const raw = await readBody(req)
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: "invalid JSON body" } }))
    return
  }

  const wantsStream = body.stream === true
  if (Array.isArray(body.messages)) body.messages = inlineToolHistory(body.messages)
  body.stream = false

  const upstream = await fetch(`${DARKBLOOM_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })

  if (!upstream.ok) {
    const text = await upstream.text()
    res.writeHead(upstream.status, { "content-type": "application/json" })
    res.end(text)
    return
  }

  const json = await upstream.json()
  if (!wantsStream) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(json))
    return
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  for (const chunk of streamChunksFor(json)) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  res.write("data: [DONE]\n\n")
  res.end()
}

// Convert a non-streaming chat-completion JSON response into the streaming
// chunk shape Vercel AI SDK reads — delta.role, delta.reasoning, delta.content,
// delta.tool_calls, then a final chunk with finish_reason.
function* streamChunksFor(response) {
  const choice = response?.choices?.[0]
  if (!choice) return

  const message = choice.message ?? {}
  const finishReason = choice.finish_reason ?? "stop"
  const base = {
    id: response.id ?? "chatcmpl-bridge",
    object: "chat.completion.chunk",
    created: response.created ?? Math.floor(Date.now() / 1000),
    model: response.model ?? "unknown",
  }

  yield { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }

  if (typeof message.reasoning === "string" && message.reasoning) {
    yield { ...base, choices: [{ index: 0, delta: { reasoning: message.reasoning }, finish_reason: null }] }
  }
  if (typeof message.content === "string" && message.content) {
    yield { ...base, choices: [{ index: 0, delta: { content: message.content }, finish_reason: null }] }
  }
  if (Array.isArray(message.tool_calls)) {
    for (const [index, call] of message.tool_calls.entries()) {
      yield {
        ...base,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index,
              id: call.id,
              type: "function",
              function: { name: call.function?.name, arguments: call.function?.arguments ?? "" },
            }],
          },
          finish_reason: null,
        }],
      }
    }
  }

  yield {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    ...(response.usage ? { usage: response.usage } : {}),
  }
}

// Multi-turn requests with role:"tool" don't currently work upstream, so we
// fold any prior tool calls + their results into a single user-role context
// message before forwarding.
function inlineToolHistory(messages) {
  const results = new Map()
  for (const m of messages) {
    if (m.role === "tool" && typeof m.tool_call_id === "string") {
      results.set(m.tool_call_id, asString(m.content))
    }
  }

  const out = []
  const buffer = []

  const flush = () => {
    if (buffer.length === 0) return
    out.push({
      role: "user",
      content:
        `[Tool execution context — for reference only, do not repeat this format in your reply]\n` +
        buffer.join("\n") +
        `\n\nUsing the results above, continue with the original task. Respond directly with the next action or final answer.`,
    })
    buffer.length = 0
  }

  for (const m of messages) {
    if (m.role === "tool") continue
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      if (typeof m.content === "string" && m.content) buffer.push(`(prior assistant note: ${m.content})`)
      for (const tc of m.tool_calls) {
        const name = tc.function?.name ?? "tool"
        const args = tc.function?.arguments ?? "{}"
        const result = results.get(tc.id) ?? "(no result)"
        buffer.push(`- ${name}(${args}) -> ${result}`)
      }
      continue
    }
    flush()
    out.push(m)
  }
  flush()
  return out
}

function asString(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((c) => typeof c === "string" ? c : c?.text ?? c?.content ?? JSON.stringify(c)).join("\n")
  }
  if (content && typeof content === "object") return JSON.stringify(content)
  return ""
}

async function passthrough(req, res, apiKey) {
  const url = `${DARKBLOOM_URL}${(req.url ?? "").replace(/^\/v1/, "")}`
  const headers = { authorization: `Bearer ${apiKey}` }
  for (const [key, value] of Object.entries(req.headers)) {
    if (key === "host" || key === "content-length" || key === "authorization") continue
    if (typeof value === "string") headers[key] = value
  }

  const init = { method: req.method ?? "GET", headers }
  if (req.method !== "GET" && req.method !== "HEAD") init.body = await readBody(req)

  const upstream = await fetch(url, init)
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  })
  res.end(await upstream.text())
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}
