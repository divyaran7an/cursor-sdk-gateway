let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf("\n")
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) handle(JSON.parse(line))
    newline = buffer.indexOf("\n")
  }
})

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
}

function handle(message) {
  if (message.method === "initialize") {
    return send(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "cursor-sdk-gateway-demo", version: "1.0.0" },
    })
  }

  if (message.method === "tools/list") {
    return send(message.id, {
      tools: [{
        name: "echo",
        description: "Echo text back to the agent.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      }],
    })
  }

  if (message.method === "resources/list") return send(message.id, { resources: [] })

  if (message.method === "tools/call") {
    return send(message.id, { content: [{ type: "text", text: `echo:${message.params?.arguments?.text ?? ""}` }] })
  }

  if (message.id !== undefined) return send(message.id, {})
}
