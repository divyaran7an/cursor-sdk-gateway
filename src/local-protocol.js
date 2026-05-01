const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()

const EXEC_TOOL_SPECS = {
  shell: { argsField: 2, resultField: 2, toolField: 1, encodeArgs: encodeShellArgs, decodeResult: decodeShellResult },
  write: { argsField: 3, resultField: 3, encodeArgs: encodeWriteArgs, decodeResult: decodeWriteResult },
  delete: { argsField: 4, resultField: 4, toolField: 3, encodeArgs: encodeDeleteArgs, decodeResult: decodeGenericResult },
  read: { argsField: 7, resultField: 7, encodeArgs: encodeReadArgs, decodeResult: decodeReadResult },
  grep: { argsField: 5, resultField: 5, toolField: 5, encodeArgs: encodeGrepArgs, decodeResult: decodeGenericResult },
  ls: { argsField: 8, resultField: 8, encodeArgs: encodeLsArgs, decodeResult: decodeGenericResult },
  diagnostics: { argsField: 9, resultField: 9, encodeArgs: encodeDiagnosticsArgs, decodeResult: decodeGenericResult },
  request_context: { argsField: 10, resultField: 10, encodeArgs: encodeRequestContextArgs, decodeResult: decodeGenericResult },
  mcp: { argsField: 11, resultField: 11, toolField: 15, encodeArgs: encodeMcpArgs, decodeResult: decodeGenericResult },
  shell_stream: { argsField: 14, resultField: 14, toolField: 1, encodeArgs: encodeShellArgs, decodeResult: decodeGenericResult },
  background_shell: { argsField: 16, resultField: 16, encodeArgs: encodeBackgroundShellArgs, decodeResult: decodeBackgroundShellResult },
  list_mcp_resources: { argsField: 17, resultField: 17, toolField: 20, encodeArgs: encodeListMcpResourcesArgs, decodeResult: decodeGenericResult },
  read_mcp_resource: { argsField: 18, resultField: 18, toolField: 21, encodeArgs: encodeReadMcpResourceArgs, decodeResult: decodeGenericResult },
  fetch: { argsField: 20, resultField: 20, toolField: 24, encodeArgs: encodeFetchArgs, decodeResult: decodeFetchResult },
  record_screen: { argsField: 21, resultField: 21, toolField: 29, encodeArgs: encodeRecordScreenArgs, decodeResult: decodeGenericResult },
  computer_use: { argsField: 22, resultField: 22, toolField: 30, encodeArgs: encodeComputerUseArgs, decodeResult: decodeGenericResult },
  write_shell_stdin: { argsField: 23, resultField: 23, toolField: 31, encodeArgs: encodeWriteShellStdinArgs, decodeResult: decodeWriteShellStdinResult },
  subagent: { argsField: 28, resultField: 28, toolField: 19, encodeArgs: encodeSubagentArgs, decodeResult: decodeSubagentResult },
  task: { argsField: 28, resultField: 28, toolField: 19, encodeArgs: encodeSubagentArgs, decodeResult: decodeSubagentResult },
  execute_hook: { argsField: 27, resultField: 27, encodeArgs: encodeExecuteHookArgs, decodeResult: decodeExecuteHookResult },
  force_background_shell: { argsField: 30, resultField: 30, encodeArgs: encodeForceBackgroundArgs, decodeResult: decodeGenericResult },
  force_background_subagent: { argsField: 31, resultField: 31, encodeArgs: encodeForceBackgroundArgs, decodeResult: decodeGenericResult },
  mcp_state: { argsField: 36, resultField: 36, encodeArgs: encodeEmptyArgs, decodeResult: decodeMcpStateResult },
  subagent_await: { argsField: 37, resultField: 37, encodeArgs: encodeSubagentAwaitArgs, decodeResult: decodeGenericResult },
}

export function readConnectMessage(buffer) {
  if (buffer.length < 5) return undefined
  const flags = buffer[0]
  const length = buffer.readUInt32BE(1)
  if (buffer.length < 5 + length) return undefined
  return {
    flags,
    message: buffer.subarray(5, 5 + length),
    rest: buffer.subarray(5 + length),
  }
}

export function connectEnvelope(message, flags = 0) {
  const header = Buffer.alloc(5)
  header[0] = flags
  header.writeUInt32BE(message.length, 1)
  return Buffer.concat([header, message])
}

export function connectEndEnvelope(metadata = {}) {
  return connectEnvelope(Buffer.from(JSON.stringify({ metadata })), 0x02)
}

export function extractRunRequest(message) {
  const clientMessage = parseProtoFields(message)
  const runRequest = firstBytes(clientMessage, 1)
  if (!runRequest) return {}

  const fields = parseProtoFields(runRequest)
  return {
    text: extractUserText(fields),
    modelId: extractModelId(fields),
    mcpTools: extractMcpTools(fields),
    conversationId: firstString(fields, 5),
  }
}

export function decodeAgentClientMessage(message) {
  const fields = parseProtoFields(message)

  const runRequest = firstBytes(fields, 1)
  if (runRequest) {
    return { type: "run_request", runRequest: extractRunRequest(message) }
  }

  const execClientMessage = firstBytes(fields, 2)
  if (execClientMessage) return decodeExecClientMessage(execClientMessage)

  const execClientControlMessage = firstBytes(fields, 5)
  if (execClientControlMessage) return decodeExecClientControlMessage(execClientControlMessage)

  return { type: "unknown" }
}

export function encodeExecServerToolCall({ id, execId, name, args }) {
  const toolName = normalizeToolName(name)
  const spec = EXEC_TOOL_SPECS[toolName]
  if (!spec) throw new Error(`Unsupported Cursor exec tool: ${name}`)

  const body = [
    encodeVarintField(1, id),
    encodeStringField(15, execId ?? `exec-${id}`),
    encodeMessageField(spec.argsField, spec.encodeArgs(args ?? {}, execId)),
  ]

  return encodeMessageField(2, Buffer.concat(body))
}

export function encodeExecServerHookCall({ id, execId, hookType, payload }) {
  return encodeExecServerToolCall({
    id,
    execId: execId ?? `hook-${id}`,
    name: "execute_hook",
    args: { hookType, payload },
  })
}

export function encodeToolCallStarted({ callId, modelCallId, name, args }) {
  return encodeAgentServerInteraction(
    encodeMessageField(2, encodeToolCallUpdate({ callId, modelCallId, name, args }))
  )
}

export function encodeToolCallCompleted({ callId, modelCallId, name, args, result }) {
  return encodeAgentServerInteraction(
    encodeMessageField(3, encodeToolCallUpdate({ callId, modelCallId, name, args, result }))
  )
}

export function encodeTextDelta(text) {
  return encodeAgentServerInteraction(
    encodeMessageField(1, encodeMessageField(1, encodeString(text)))
  )
}

export function encodeThinkingDelta(text) {
  return encodeAgentServerInteraction(
    encodeMessageField(4, encodeMessageField(1, encodeString(text)))
  )
}

export function encodeTurnEnded(usage = {}) {
  const fields = []
  if (Number.isFinite(usage.inputTokens)) fields.push(encodeVarintField(1, usage.inputTokens))
  if (Number.isFinite(usage.outputTokens)) fields.push(encodeVarintField(2, usage.outputTokens))
  if (Number.isFinite(usage.cacheReadTokens)) fields.push(encodeVarintField(3, usage.cacheReadTokens))
  if (Number.isFinite(usage.cacheWriteTokens)) fields.push(encodeVarintField(4, usage.cacheWriteTokens))
  return encodeAgentServerInteraction(encodeMessageField(14, Buffer.concat(fields)))
}

export function encodeHeartbeat() {
  return encodeAgentServerInteraction(encodeMessageField(13, Buffer.alloc(0)))
}

function encodeAgentServerInteraction(interactionUpdate) {
  return encodeMessageField(1, interactionUpdate)
}

function decodeExecClientMessage(message) {
  const fields = parseProtoFields(message)
  const id = Number(firstVarint(fields, 1) ?? 0n)
  const execId = firstString(fields, 15)

  for (const [name, spec] of Object.entries(EXEC_TOOL_SPECS)) {
    const rawResult = firstBytes(fields, spec.resultField)
    if (!rawResult) continue
    return {
      type: "exec_result",
      id,
      execId,
      name,
      result: spec.decodeResult(rawResult),
      rawResult,
    }
  }

  return { type: "exec_result", id, execId, result: { status: "unknown" } }
}

function decodeExecClientControlMessage(message) {
  const fields = parseProtoFields(message)

  const streamClose = firstBytes(fields, 1)
  if (streamClose) {
    const streamCloseFields = parseProtoFields(streamClose)
    return { type: "exec_stream_close", id: Number(firstVarint(streamCloseFields, 1) ?? 0n) }
  }

  const thrown = firstBytes(fields, 2)
  if (thrown) {
    const thrownFields = parseProtoFields(thrown)
    return {
      type: "exec_throw",
      id: Number(firstVarint(thrownFields, 1) ?? 0n),
      error: firstString(thrownFields, 2) ?? "Cursor local executor failed.",
      stackTrace: firstString(thrownFields, 3),
      errorCode: firstString(thrownFields, 4),
    }
  }

  const heartbeat = firstBytes(fields, 3)
  if (heartbeat) {
    const heartbeatFields = parseProtoFields(heartbeat)
    return { type: "exec_heartbeat", id: Number(firstVarint(heartbeatFields, 1) ?? 0n) }
  }

  return { type: "unknown" }
}

function extractUserText(agentRunRequestFields) {
  const action = firstBytes(agentRunRequestFields, 2)
  if (!action) return undefined

  const actionFields = parseProtoFields(action)
  const userMessageAction = firstBytes(actionFields, 1)
  if (!userMessageAction) return undefined

  const userMessageActionFields = parseProtoFields(userMessageAction)
  const userMessage = firstBytes(userMessageActionFields, 1)
  if (!userMessage) return undefined

  const userMessageFields = parseProtoFields(userMessage)
  return firstString(userMessageFields, 1)
}

function extractModelId(agentRunRequestFields) {
  const requestedModel = firstBytes(agentRunRequestFields, 9)
  if (requestedModel) {
    const requestedModelFields = parseProtoFields(requestedModel)
    const modelId = firstString(requestedModelFields, 1)
    if (modelId) return modelId
  }

  const modelDetails = firstBytes(agentRunRequestFields, 3)
  if (modelDetails) {
    const modelDetailsFields = parseProtoFields(modelDetails)
    const modelId = firstString(modelDetailsFields, 1)
    if (modelId) return modelId
  }

  return firstString(agentRunRequestFields, 18)
}

function extractMcpTools(agentRunRequestFields) {
  const mcpTools = firstBytes(agentRunRequestFields, 4)
  if (!mcpTools) return []

  const fields = parseProtoFields(mcpTools)
  return (fields.get(1) ?? [])
    .filter(Buffer.isBuffer)
    .map((tool) => {
      const toolFields = parseProtoFields(tool)
      return {
        name: firstString(toolFields, 1) ?? "",
        description: firstString(toolFields, 2) ?? "",
        inputSchema: decodeJsonValue(firstBytes(toolFields, 3)),
        providerIdentifier: firstString(toolFields, 4) ?? "",
        toolName: firstString(toolFields, 5) ?? "",
      }
    })
    .filter((tool) => tool.name && tool.providerIdentifier && tool.toolName)
}

function firstBytes(fields, number) {
  const value = fields.get(number)?.[0]
  return Buffer.isBuffer(value) ? value : undefined
}

function firstVarint(fields, number) {
  const value = fields.get(number)?.[0]
  return typeof value === "bigint" ? value : undefined
}

function firstString(fields, number) {
  const value = firstBytes(fields, number)
  return value ? TEXT_DECODER.decode(value) : undefined
}

export function parseProtoFields(buffer) {
  const fields = new Map()
  let offset = 0

  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset)
    if (!tag) break
    offset = tag.offset

    const fieldNumber = Number(tag.value >> 3n)
    const wireType = Number(tag.value & 7n)
    let value

    if (wireType === 0) {
      const varint = readVarint(buffer, offset)
      if (!varint) break
      value = varint.value
      offset = varint.offset
    } else if (wireType === 1) {
      if (offset + 8 > buffer.length) break
      value = buffer.subarray(offset, offset + 8)
      offset += 8
    } else if (wireType === 2) {
      const length = readVarint(buffer, offset)
      if (!length) break
      offset = length.offset
      const end = offset + Number(length.value)
      if (end > buffer.length) break
      value = buffer.subarray(offset, end)
      offset = end
    } else if (wireType === 5) {
      if (offset + 4 > buffer.length) break
      value = buffer.subarray(offset, offset + 4)
      offset += 4
    } else {
      break
    }

    const values = fields.get(fieldNumber) ?? []
    values.push(value)
    fields.set(fieldNumber, values)
  }

  return fields
}

function readVarint(buffer, start) {
  let value = 0n
  let shift = 0n

  for (let offset = start; offset < buffer.length; offset += 1) {
    const byte = buffer[offset]
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, offset: offset + 1 }
    shift += 7n
    if (shift > 63n) return undefined
  }

  return undefined
}

function encodeMessageField(fieldNumber, message) {
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(message.length), message])
}

function encodeVarintField(fieldNumber, value) {
  return Buffer.concat([encodeTag(fieldNumber, 0), encodeVarint(value)])
}

function encodeStringField(fieldNumber, value) {
  return encodeMessageField(fieldNumber, encodeString(value))
}

function encodeBytesField(fieldNumber, value) {
  return encodeMessageField(fieldNumber, Buffer.from(value))
}

function encodeBoolField(fieldNumber, value) {
  return encodeVarintField(fieldNumber, value ? 1 : 0)
}

function encodeDoubleField(fieldNumber, value) {
  const buffer = Buffer.alloc(8)
  buffer.writeDoubleLE(Number(value), 0)
  return Buffer.concat([encodeTag(fieldNumber, 1), buffer])
}

function encodeString(value) {
  return Buffer.from(TEXT_ENCODER.encode(value))
}

function encodeTag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType)
}

function encodeVarint(rawValue) {
  let value = BigInt(rawValue)
  const bytes = []

  do {
    let byte = Number(value & 0x7fn)
    value >>= 7n
    if (value !== 0n) byte |= 0x80
    bytes.push(byte)
  } while (value !== 0n)

  return Buffer.from(bytes)
}

function encodeJsonValue(value) {
  if (value === null || value === undefined) return encodeVarintField(1, 0)
  if (typeof value === "number") return encodeDoubleField(2, value)
  if (typeof value === "string") return encodeStringField(3, value)
  if (typeof value === "boolean") return encodeBoolField(4, value)
  if (Array.isArray(value)) {
    return encodeMessageField(6, Buffer.concat(value.map((item) => encodeMessageField(1, encodeJsonValue(item)))))
  }
  if (typeof value === "object") {
    return encodeMessageField(5, Buffer.concat(Object.entries(value).map(([key, nested]) =>
      encodeMessageField(1, Buffer.concat([
        encodeStringField(1, key),
        encodeMessageField(2, encodeJsonValue(nested)),
      ]))
    )))
  }
  return encodeStringField(3, String(value))
}

function encodeJsonStruct(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return Buffer.alloc(0)
  return Buffer.concat(Object.entries(value).map(([key, nested]) =>
    encodeMessageField(1, Buffer.concat([
      encodeStringField(1, key),
      encodeMessageField(2, encodeJsonValue(nested)),
    ]))
  ))
}

function decodeJsonValue(message) {
  if (!message) return undefined
  const fields = parseProtoFields(message)

  const number = fields.get(2)?.[0]
  if (Buffer.isBuffer(number) && number.length === 8) return number.readDoubleLE(0)

  const string = firstString(fields, 3)
  if (string !== undefined) return string

  const bool = firstVarint(fields, 4)
  if (bool !== undefined) return bool !== 0n

  const struct = firstBytes(fields, 5)
  if (struct) return decodeJsonStruct(struct)

  const list = firstBytes(fields, 6)
  if (list) {
    const listFields = parseProtoFields(list)
    return (listFields.get(1) ?? [])
      .filter(Buffer.isBuffer)
      .map((item) => decodeJsonValue(item))
  }

  if (fields.has(1)) return null
  return undefined
}

function decodeJsonStruct(message) {
  const fields = parseProtoFields(message)
  const output = {}

  for (const entry of fields.get(1) ?? []) {
    if (!Buffer.isBuffer(entry)) continue
    const entryFields = parseProtoFields(entry)
    const key = firstString(entryFields, 1)
    if (!key) continue
    output[key] = decodeJsonValue(firstBytes(entryFields, 2))
  }

  return output
}

function encodeToolCallUpdate({ callId, modelCallId, name, args, result }) {
  return Buffer.concat([
    encodeStringField(1, callId),
    encodeMessageField(2, encodeToolCall({ name, args, result })),
    encodeStringField(3, modelCallId ?? callId),
  ])
}

function encodeToolCall({ name, args, result }) {
  const toolName = normalizeToolName(name)
  const spec = EXEC_TOOL_SPECS[toolName]
  if (toolName === "write" || toolName === "edit") return encodeMessageField(12, encodeEditToolCall(args, result))
  if (toolName === "read") return encodeMessageField(8, encodeReadToolCall(args, result))
  if (toolName === "ls") return encodeMessageField(13, encodeLsToolCall(args, result))
  if (toolName === "glob") return encodeMessageField(4, encodeGlobToolCall(args, result))
  if (toolName === "readLints") return encodeMessageField(14, encodeReadLintsToolCall(args, result))
  if (toolName === "semSearch" || toolName === "sem_search") return encodeMessageField(16, encodeSemSearchToolCall(args, result))
  if (toolName === "createPlan") return encodeMessageField(17, encodeCreatePlanToolCall(args, result))
  if (toolName === "generateImage") return encodeMessageField(28, encodeGenerateImageToolCall(args, result))
  if (toolName === "updateTodos") return encodeMessageField(9, encodeUpdateTodosToolCall(args, result))
  if (toolName === "task" || toolName === "subagent") return encodeMessageField(19, encodeTaskToolCall(args, result))
  if (spec?.toolField) return encodeMessageField(spec.toolField, encodeExecBackedToolCall(toolName, args, result))
  throw new Error(`Unsupported Cursor ToolCall event: ${name}`)
}

function encodeEditToolCall(rawArgs, result) {
  const args = normalizeToolArgs("write", rawArgs)
  const fields = [encodeMessageField(1, encodeEditToolArgs(args))]
  const editResult = encodeEditToolResult(args, result?.result)
  if (editResult) fields.push(encodeMessageField(2, editResult))
  return Buffer.concat(fields)
}

function encodeEditToolArgs(args) {
  const fields = [encodeStringField(1, args.path)]
  if (args.fileText) fields.push(encodeStringField(6, args.fileText))
  return Buffer.concat(fields)
}

function encodeEditToolResult(args, result) {
  if (!result || result.status !== "success") return undefined
  const success = [
    encodeStringField(1, result.path ?? args.path),
    encodeVarintField(3, result.linesCreated ?? 0),
    encodeVarintField(4, 0),
    encodeStringField(7, args.fileText ?? result.fileContentAfterWrite ?? ""),
    encodeStringField(8, "File written."),
  ]
  return encodeMessageField(1, Buffer.concat(success))
}

function encodeReadToolCall(rawArgs, result) {
  const args = normalizeToolArgs("read", rawArgs)
  const fields = [encodeMessageField(1, encodeReadToolArgs(args))]
  const readResult = encodeReadToolResult(result?.result)
  if (readResult) fields.push(encodeMessageField(2, readResult))
  return Buffer.concat(fields)
}

function encodeReadToolArgs(args) {
  const fields = [encodeStringField(1, args.path)]
  if (args.offset !== undefined) fields.push(encodeVarintField(2, args.offset))
  if (args.limit !== undefined) fields.push(encodeVarintField(3, args.limit))
  return Buffer.concat(fields)
}

function encodeReadToolResult(result) {
  if (!result || result.status !== "success") return undefined
  const success = [
    encodeStringField(1, result.content ?? ""),
    encodeBoolField(2, !result.content),
    encodeBoolField(3, Boolean(result.truncated)),
    encodeVarintField(4, result.totalLines ?? 0),
    encodeVarintField(5, result.fileSize ?? 0),
    encodeStringField(7, result.path ?? ""),
  ]
  return encodeMessageField(1, Buffer.concat(success))
}

function encodeExecBackedToolCall(name, rawArgs, result) {
  const spec = EXEC_TOOL_SPECS[name]
  const args = normalizeToolArgs(name, rawArgs)
  const fields = [encodeMessageField(1, spec.encodeArgs(args, ""))]
  if (result?.rawResult) fields.push(encodeMessageField(2, result.rawResult))
  return Buffer.concat(fields)
}

function encodeLsToolCall(rawArgs, _result) {
  // agent.v1.LsToolCall { args: LsArgs (1), result: LsResult (2) }
  // Minimum public lifecycle: emit args so Cursor SDK surfaces a `ls` tool_call event.
  // The local executor returns the actual directory tree to the model directly,
  // so we leave result undefined here.
  const args = normalizeToolArgs("ls", rawArgs)
  const argsBytes = [encodeStringField(1, args.path ?? ".")]
  if (Array.isArray(args.ignore)) {
    for (const entry of args.ignore) argsBytes.push(encodeStringField(2, String(entry)))
  }
  return encodeMessageField(1, Buffer.concat(argsBytes))
}

function encodeGlobToolCall(rawArgs, result) {
  const args = normalizeToolArgs("glob", rawArgs)
  const fields = [encodeMessageField(1, encodeGlobToolArgs(args))]
  const toolResult = encodeGlobToolResult(args, result?.result)
  if (toolResult) fields.push(encodeMessageField(2, toolResult))
  return Buffer.concat(fields)
}

function encodeGlobToolArgs(args) {
  const fields = [encodeStringField(2, args.globPattern)]
  if (args.targetDirectory !== undefined) fields.push(encodeStringField(1, args.targetDirectory))
  return Buffer.concat(fields)
}

function encodeGlobToolResult(args, result) {
  if (!result) return undefined
  if (result.status !== "success") return encodeMessageField(2, encodeStringField(1, result.message ?? "glob failed"))
  const success = [
    encodeStringField(1, args.globPattern),
    encodeStringField(2, result.path ?? args.targetDirectory ?? "."),
    encodeVarintField(4, result.totalFiles ?? result.files?.length ?? 0),
    encodeBoolField(5, Boolean(result.clientTruncated)),
    encodeBoolField(6, Boolean(result.ripgrepTruncated)),
  ]
  for (const file of result.files ?? []) success.push(encodeStringField(3, file))
  return encodeMessageField(1, Buffer.concat(success))
}

function encodeSemSearchToolCall(rawArgs, result) {
  const args = normalizeToolArgs("semSearch", rawArgs)
  const fields = [encodeMessageField(1, encodeSemSearchToolArgs(args))]
  const toolResult = encodeSemSearchToolResult(result?.result)
  if (toolResult) fields.push(encodeMessageField(2, toolResult))
  return Buffer.concat(fields)
}

function encodeSemSearchToolArgs(args) {
  const fields = [encodeStringField(1, args.query), encodeStringField(3, args.explanation ?? "")]
  for (const directory of args.targetDirectories ?? []) fields.push(encodeStringField(2, directory))
  return Buffer.concat(fields)
}

function encodeSemSearchToolResult(result) {
  if (!result) return undefined
  if (result.status !== "success") return encodeMessageField(2, encodeStringField(1, result.message ?? "semantic search failed"))
  return encodeMessageField(1, encodeStringField(1, result.results ?? ""))
}

function encodeReadLintsToolCall(rawArgs, result) {
  const args = normalizeToolArgs("readLints", rawArgs)
  const fields = [encodeMessageField(1, encodeReadLintsArgs(args))]
  const toolResult = encodeReadLintsResult(result?.result)
  if (toolResult) fields.push(encodeMessageField(2, toolResult))
  return Buffer.concat(fields)
}

function encodeReadLintsArgs(args) {
  const fields = []
  for (const path of args.paths ?? []) fields.push(encodeStringField(1, path))
  return Buffer.concat(fields)
}

function encodeReadLintsResult(result) {
  if (!result) return undefined
  if (result.status !== "success") return encodeMessageField(2, encodeStringField(1, toolErrorMessage(result, "readLints failed")))
  const value = result.value ?? result
  const success = [
    encodeVarintField(2, Number(value.totalFiles ?? value.fileDiagnostics?.length ?? 0)),
    encodeVarintField(3, Number(value.totalDiagnostics ?? 0)),
  ]
  for (const file of value.fileDiagnostics ?? []) {
    const fileFields = [
      encodeStringField(1, String(file.path ?? "")),
      encodeVarintField(3, Number(file.diagnosticsCount ?? file.diagnostics?.length ?? 0)),
    ]
    for (const diagnostic of file.diagnostics ?? []) fileFields.push(encodeMessageField(2, encodeDiagnostic(diagnostic)))
    success.push(encodeMessageField(1, Buffer.concat(fileFields)))
  }
  return encodeMessageField(1, Buffer.concat(success))
}

function encodeDiagnostic(diagnostic) {
  const fields = [
    encodeVarintField(1, diagnosticSeverityToEnum(diagnostic.severity)),
    encodeStringField(3, String(diagnostic.message ?? "")),
    encodeStringField(4, String(diagnostic.source ?? "")),
    encodeStringField(5, String(diagnostic.code ?? "")),
  ]
  return Buffer.concat(fields)
}

function encodeTaskToolCall(rawArgs, result) {
  const args = normalizeToolArgs("task", rawArgs)
  const fields = [encodeMessageField(1, encodeTaskArgs(args))]
  const toolResult = encodeTaskToolResult(result?.result ?? result)
  if (toolResult) fields.push(encodeMessageField(2, toolResult))
  return Buffer.concat(fields)
}

function encodeTaskToolResult(result) {
  if (!result) return undefined
  if (result.status === "success") {
    return encodeMessageField(1, Buffer.concat([
      ...(result.agentId ? [encodeStringField(2, result.agentId)] : []),
      encodeBoolField(3, Boolean(result.backgroundReason)),
      ...(result.finalMessage ? [encodeStringField(5, result.finalMessage)] : []),
      ...(result.transcriptPath ? [encodeStringField(7, result.transcriptPath)] : []),
    ]))
  }

  return encodeMessageField(2, encodeStringField(1, result.message ?? result.error ?? "Subagent failed."))
}

function encodeCreatePlanToolCall(rawArgs, result) {
  const args = normalizeToolArgs("createPlan", rawArgs)
  const fields = [encodeMessageField(1, encodeCreatePlanArgs(args))]
  const toolResult = encodeCreatePlanResult(result?.result)
  if (toolResult) fields.push(encodeMessageField(2, toolResult))
  return Buffer.concat(fields)
}

function encodeCreatePlanArgs(args) {
  return encodeStringField(1, args.plan)
}

function encodeCreatePlanResult(result) {
  if (!result) return undefined
  if (result.status !== "success") return encodeMessageField(2, encodeStringField(1, toolErrorMessage(result, "createPlan failed")))
  const fields = [encodeMessageField(1, Buffer.alloc(0))]
  if (result.planUri) fields.push(encodeStringField(3, result.planUri))
  return Buffer.concat(fields)
}

function encodeGenerateImageToolCall(rawArgs, result) {
  const args = normalizeToolArgs("generateImage", rawArgs)
  const fields = [encodeMessageField(1, encodeGenerateImageArgs(args))]
  const toolResult = encodeGenerateImageResult(result?.result)
  if (toolResult) fields.push(encodeMessageField(2, toolResult))
  return Buffer.concat(fields)
}

function encodeGenerateImageArgs(args) {
  const fields = [encodeStringField(1, args.description)]
  if (args.filePath !== undefined) fields.push(encodeStringField(2, args.filePath))
  for (const path of args.referenceImagePaths ?? []) fields.push(encodeStringField(5, path))
  return Buffer.concat(fields)
}

function encodeGenerateImageResult(result) {
  if (!result) return undefined
  if (result.status !== "success") return encodeMessageField(2, encodeStringField(1, toolErrorMessage(result, "generateImage failed")))
  const value = result.value ?? result
  return encodeMessageField(1, Buffer.concat([
    encodeStringField(1, String(value.filePath ?? "")),
    encodeStringField(2, String(value.imageData ?? "")),
  ]))
}

function encodeUpdateTodosToolCall(rawArgs, result) {
  const args = normalizeToolArgs("updateTodos", rawArgs)
  const fields = [encodeMessageField(1, encodeUpdateTodosArgs(args))]
  const toolResult = encodeUpdateTodosResult(result?.result)
  if (toolResult) fields.push(encodeMessageField(2, toolResult))
  return Buffer.concat(fields)
}

function encodeUpdateTodosArgs(args) {
  const fields = []
  for (const todo of args.todos ?? []) fields.push(encodeMessageField(1, encodeTodoItem(todo)))
  if (args.merge !== undefined) fields.push(encodeBoolField(2, Boolean(args.merge)))
  return Buffer.concat(fields)
}

function encodeUpdateTodosResult(result) {
  if (!result) return undefined
  if (result.status !== "success") return encodeMessageField(2, encodeStringField(1, toolErrorMessage(result, "updateTodos failed")))
  const value = result.value ?? result
  const success = [encodeVarintField(2, Number(value.totalCount ?? value.todos?.length ?? 0))]
  for (const todo of value.todos ?? []) success.push(encodeMessageField(1, encodeTodoItem(todo)))
  if (value.wasMerge !== undefined) success.push(encodeBoolField(3, Boolean(value.wasMerge)))
  return encodeMessageField(1, Buffer.concat(success))
}

function encodeTodoItem(todo) {
  const fields = [
    encodeStringField(2, String(todo.content ?? "")),
    encodeVarintField(3, todoStatusToEnum(todo.status)),
  ]
  if (todo.id !== undefined) fields.push(encodeStringField(1, String(todo.id)))
  if (todo.createdAt !== undefined) fields.push(encodeVarintField(4, Number(todo.createdAt)))
  if (todo.updatedAt !== undefined) fields.push(encodeVarintField(5, Number(todo.updatedAt)))
  for (const dependency of todo.dependencies ?? []) fields.push(encodeStringField(6, String(dependency)))
  return Buffer.concat(fields)
}

function encodeWriteArgs(rawArgs, toolCallId) {
  const args = normalizeToolArgs("write", rawArgs)
  const fields = [
    encodeStringField(1, args.path),
    encodeStringField(2, args.fileText),
    encodeStringField(3, toolCallId ?? ""),
  ]

  if (args.returnFileContentAfterWrite !== undefined) {
    fields.push(encodeBoolField(4, args.returnFileContentAfterWrite))
  }
  if (args.fileBytes !== undefined) fields.push(encodeBytesField(5, args.fileBytes))
  if (args.encodingHint !== undefined) fields.push(encodeStringField(6, args.encodingHint))

  return Buffer.concat(fields)
}

function encodeShellArgs(rawArgs, toolCallId) {
  const args = normalizeToolArgs("shell", rawArgs)
  const fields = [
    encodeStringField(1, args.command),
    encodeStringField(2, args.workingDirectory ?? ""),
    encodeVarintField(3, args.timeout ?? 0),
    encodeStringField(4, toolCallId ?? ""),
  ]
  for (const command of args.simpleCommands ?? []) fields.push(encodeStringField(5, command))
  if (args.hasInputRedirect !== undefined) fields.push(encodeBoolField(6, args.hasInputRedirect))
  if (args.hasOutputRedirect !== undefined) fields.push(encodeBoolField(7, args.hasOutputRedirect))
  fields.push(encodeMessageField(8, encodeShellParsingResult(args)))
  if (args.fileOutputThresholdBytes !== undefined) fields.push(encodeVarintField(10, args.fileOutputThresholdBytes))
  if (args.isBackground !== undefined) fields.push(encodeBoolField(11, args.isBackground))
  if (args.skipApproval !== undefined) fields.push(encodeBoolField(12, args.skipApproval))
  if (args.timeoutBehavior !== undefined) fields.push(encodeVarintField(13, args.timeoutBehavior))
  if (args.hardTimeout !== undefined) fields.push(encodeVarintField(14, args.hardTimeout))
  if (args.description !== undefined) fields.push(encodeStringField(15, args.description))
  if (args.closeStdin !== undefined) fields.push(encodeBoolField(17, args.closeStdin))
  return Buffer.concat(fields)
}

function encodeShellParsingResult(args) {
  const command = args.command ?? ""
  const hasRedirects =
    args.hasInputRedirect !== undefined || args.hasOutputRedirect !== undefined
      ? Boolean(args.hasInputRedirect || args.hasOutputRedirect)
      : /(^|[^\\])([<>]|>>|2>)/.test(command)
  const executable = firstShellExecutable(command)
  const fields = [
    encodeBoolField(1, false),
    encodeMessageField(2, encodeShellExecutableCommand(executable, command)),
    encodeBoolField(3, hasRedirects),
    encodeBoolField(4, /\$\(|`/.test(command)),
    encodeBoolField(5, /\/dev\/null/.test(command)),
  ]
  return Buffer.concat(fields)
}

function encodeShellExecutableCommand(name, fullText) {
  return Buffer.concat([
    encodeStringField(1, name),
    encodeStringField(3, fullText),
  ])
}

function firstShellExecutable(command) {
  const trimmed = command.trim()
  if (!trimmed) return ""
  const withoutEnv = trimmed.replace(/^env\\s+/, "")
  const match = withoutEnv.match(/^([A-Za-z0-9_./-]+)/)
  return match?.[1] ?? trimmed.split(/\\s+/)[0] ?? ""
}

function encodeDeleteArgs(rawArgs, toolCallId) {
  const args = normalizeToolArgs("delete", rawArgs)
  return Buffer.concat([encodeStringField(1, args.path), encodeStringField(2, toolCallId ?? "")])
}

function encodeReadArgs(rawArgs, toolCallId) {
  const args = normalizeToolArgs("read", rawArgs)
  const fields = [encodeStringField(1, args.path), encodeStringField(2, toolCallId ?? "")]
  if (args.offset !== undefined) fields.push(encodeVarintField(4, args.offset))
  if (args.limit !== undefined) fields.push(encodeVarintField(5, args.limit))
  if (args.encodingHint !== undefined) fields.push(encodeStringField(6, args.encodingHint))
  return Buffer.concat(fields)
}

function encodeLsArgs(rawArgs, toolCallId) {
  const args = normalizeToolArgs("ls", rawArgs)
  const fields = [encodeStringField(1, args.path), encodeStringField(3, toolCallId ?? "")]
  for (const item of args.ignore ?? []) fields.push(encodeStringField(2, item))
  if (args.timeoutMs !== undefined) fields.push(encodeVarintField(5, args.timeoutMs))
  return Buffer.concat(fields)
}

function encodeGrepArgs(rawArgs, toolCallId) {
  const args = normalizeToolArgs("grep", rawArgs)
  const fields = [encodeStringField(1, args.pattern), encodeStringField(14, toolCallId ?? "")]
  if (args.path !== undefined) fields.push(encodeStringField(2, args.path))
  if (args.glob !== undefined) fields.push(encodeStringField(3, args.glob))
  if (args.outputMode !== undefined) fields.push(encodeStringField(4, args.outputMode))
  if (args.contextBefore !== undefined) fields.push(encodeVarintField(5, args.contextBefore))
  if (args.contextAfter !== undefined) fields.push(encodeVarintField(6, args.contextAfter))
  if (args.context !== undefined) fields.push(encodeVarintField(7, args.context))
  if (args.caseInsensitive !== undefined) fields.push(encodeBoolField(8, args.caseInsensitive))
  if (args.type !== undefined) fields.push(encodeStringField(9, args.type))
  if (args.headLimit !== undefined) fields.push(encodeVarintField(10, args.headLimit))
  if (args.multiline !== undefined) fields.push(encodeBoolField(11, args.multiline))
  if (args.sort !== undefined) fields.push(encodeStringField(12, args.sort))
  if (args.sortAscending !== undefined) fields.push(encodeBoolField(13, args.sortAscending))
  if (args.offset !== undefined) fields.push(encodeVarintField(16, args.offset))
  return Buffer.concat(fields)
}

function encodeDiagnosticsArgs(rawArgs, toolCallId) {
  const args = normalizeToolArgs("diagnostics", rawArgs)
  return Buffer.concat([encodeStringField(1, args.path), encodeStringField(2, toolCallId ?? "")])
}

function encodeRequestContextArgs(rawArgs) {
  const args = normalizeToolArgs("request_context", rawArgs)
  const fields = []
  if (args.notesSessionId !== undefined) fields.push(encodeStringField(2, args.notesSessionId))
  if (args.workspaceId !== undefined) fields.push(encodeStringField(3, args.workspaceId))
  if (args.readOnlyPinnedTreeSha !== undefined) fields.push(encodeStringField(4, args.readOnlyPinnedTreeSha))
  return Buffer.concat(fields)
}

function encodeMcpArgs(rawArgs, toolCallId) {
  const args = normalizeToolArgs("mcp", rawArgs)
  const fields = [
    encodeStringField(1, args.name),
    encodeStringField(3, toolCallId ?? ""),
    encodeStringField(4, args.providerIdentifier ?? ""),
    encodeStringField(5, args.toolName ?? args.name),
  ]
  for (const [key, value] of Object.entries(args.args ?? {})) {
    fields.push(encodeMessageField(2, Buffer.concat([
      encodeStringField(1, key),
      encodeMessageField(2, encodeJsonValue(value)),
    ])))
  }
  return Buffer.concat(fields)
}

function encodeBackgroundShellArgs(rawArgs, toolCallId) {
  const args = normalizeToolArgs("background_shell", rawArgs)
  const fields = [
    encodeStringField(1, args.command),
    encodeStringField(2, args.workingDirectory ?? ""),
    encodeStringField(3, toolCallId ?? ""),
    encodeMessageField(4, encodeShellParsingResult(args)),
  ]
  if (args.enableWriteShellStdinTool !== undefined) fields.push(encodeBoolField(6, args.enableWriteShellStdinTool))
  if (args.description !== undefined) fields.push(encodeStringField(7, args.description))
  return Buffer.concat(fields)
}

function encodeListMcpResourcesArgs(rawArgs) {
  const args = normalizeToolArgs("list_mcp_resources", rawArgs)
  return args.server !== undefined ? encodeStringField(1, args.server) : Buffer.alloc(0)
}

function encodeReadMcpResourceArgs(rawArgs) {
  const args = normalizeToolArgs("read_mcp_resource", rawArgs)
  const fields = [encodeStringField(1, args.server), encodeStringField(2, args.uri)]
  if (args.downloadPath !== undefined) fields.push(encodeStringField(3, args.downloadPath))
  return Buffer.concat(fields)
}

function encodeFetchArgs(rawArgs, toolCallId) {
  const args = normalizeToolArgs("fetch", rawArgs)
  return Buffer.concat([encodeStringField(1, args.url), encodeStringField(2, toolCallId ?? "")])
}

function encodeRecordScreenArgs(rawArgs, toolCallId) {
  const args = normalizeToolArgs("record_screen", rawArgs)
  const fields = [encodeVarintField(1, args.mode ?? 0), encodeStringField(2, toolCallId ?? "")]
  if (args.saveAsFilename !== undefined) fields.push(encodeStringField(3, args.saveAsFilename))
  return Buffer.concat(fields)
}

function encodeComputerUseArgs(rawArgs, toolCallId) {
  const args = normalizeToolArgs("computer_use", rawArgs)
  const fields = [encodeStringField(1, toolCallId ?? "")]
  for (const action of args.actions ?? []) {
    if (Buffer.isBuffer(action)) fields.push(encodeMessageField(2, action))
  }
  return Buffer.concat(fields)
}

function encodeWriteShellStdinArgs(rawArgs) {
  const args = normalizeToolArgs("write_shell_stdin", rawArgs)
  return Buffer.concat([encodeVarintField(1, args.shellId), encodeStringField(2, args.chars)])
}

function encodeSubagentArgs(rawArgs, toolCallId) {
  const args = normalizeToolArgs("task", rawArgs)
  const fields = [
    encodeStringField(1, toolCallId ?? ""),
    encodeStringField(2, args.subagentType ?? ""),
    encodeStringField(3, args.modelId ?? args.model ?? ""),
    encodeStringField(4, args.prompt),
    encodeBoolField(5, Boolean(args.readonly)),
  ]
  if (args.resumeAgentId !== undefined) fields.push(encodeStringField(6, args.resumeAgentId))
  if (args.runInBackground !== undefined) fields.push(encodeBoolField(7, args.runInBackground))
  if (args.parentConversationId !== undefined) fields.push(encodeStringField(9, args.parentConversationId))
  if (args.interrupt !== undefined) fields.push(encodeBoolField(13, args.interrupt))
  if (args.mode !== undefined) fields.push(encodeVarintField(14, args.mode))
  if (args.forkAgentId !== undefined) fields.push(encodeStringField(15, args.forkAgentId))
  if (args.rootParentConversationId !== undefined) fields.push(encodeStringField(16, args.rootParentConversationId))
  return Buffer.concat(fields)
}

function encodeTaskArgs(rawArgs) {
  const args = normalizeToolArgs("task", rawArgs)
  const fields = [
    encodeStringField(1, args.description ?? ""),
    encodeStringField(2, args.prompt),
  ]
  if (args.model !== undefined) fields.push(encodeStringField(4, args.model))
  if (args.resume !== undefined) fields.push(encodeStringField(5, args.resume))
  if (args.agentId !== undefined) fields.push(encodeStringField(6, args.agentId))
  for (const attachment of args.attachments ?? []) fields.push(encodeStringField(7, attachment))
  if (args.mode !== undefined) fields.push(encodeVarintField(8, args.mode))
  for (const id of args.respondingToMessageIds ?? []) fields.push(encodeStringField(9, id))
  return Buffer.concat(fields)
}

function encodeForceBackgroundArgs(rawArgs, toolCallId) {
  const args = normalizeToolArgs("force_background", rawArgs)
  return encodeStringField(1, args.toolCallId ?? toolCallId ?? "")
}

function encodeEmptyArgs() {
  return Buffer.alloc(0)
}

function encodeSubagentAwaitArgs(rawArgs) {
  const args = normalizeToolArgs("subagent_await", rawArgs)
  return Buffer.concat([encodeStringField(1, args.agentId), encodeVarintField(2, args.timeoutMs ?? 0)])
}

function encodeExecuteHookArgs(rawArgs) {
  const args = normalizeToolArgs("execute_hook", rawArgs)
  return encodeMessageField(1, encodeExecuteHookRequest(args.hookType, args.payload ?? {}))
}

function encodeExecuteHookRequest(hookType, payload) {
  if (hookType === "preToolUse") return encodeMessageField(4, encodePreToolUseRequest(payload))
  if (hookType === "postToolUse") return encodeMessageField(5, encodePostToolUseRequest(payload))
  if (hookType === "postToolUseFailure") return encodeMessageField(6, encodePostToolUseFailureRequest(payload))
  return Buffer.alloc(0)
}

function encodePreToolUseRequest(payload) {
  const fields = [
    encodeStringField(1, payload.toolName ?? ""),
    encodeMessageField(2, encodeJsonStruct(payload.toolInput ?? {})),
    encodeStringField(3, payload.toolUseId ?? ""),
  ]
  if (payload.cwd !== undefined) fields.push(encodeStringField(4, payload.cwd))
  if (payload.conversationId !== undefined) fields.push(encodeStringField(5, payload.conversationId))
  if (payload.generationId !== undefined) fields.push(encodeStringField(6, payload.generationId))
  if (payload.model !== undefined) fields.push(encodeStringField(7, payload.model))
  return Buffer.concat(fields)
}

function encodePostToolUseRequest(payload) {
  const fields = [
    encodeStringField(1, payload.toolName ?? ""),
    encodeMessageField(2, encodeJsonStruct(payload.toolInput ?? {})),
    encodeStringField(3, payload.toolOutput ?? ""),
    encodeVarintField(4, payload.durationMs ?? 0),
    encodeStringField(5, payload.toolUseId ?? ""),
  ]
  if (payload.cwd !== undefined) fields.push(encodeStringField(6, payload.cwd))
  if (payload.conversationId !== undefined) fields.push(encodeStringField(7, payload.conversationId))
  if (payload.generationId !== undefined) fields.push(encodeStringField(8, payload.generationId))
  if (payload.model !== undefined) fields.push(encodeStringField(9, payload.model))
  return Buffer.concat(fields)
}

function encodePostToolUseFailureRequest(payload) {
  const fields = [
    encodeStringField(1, payload.toolName ?? ""),
    encodeMessageField(2, encodeJsonStruct(payload.toolInput ?? {})),
    encodeStringField(3, payload.errorMessage ?? ""),
    encodeStringField(4, payload.failureType ?? "error"),
    encodeVarintField(5, payload.durationMs ?? 0),
    encodeStringField(6, payload.toolUseId ?? ""),
    encodeBoolField(7, Boolean(payload.isInterrupt)),
  ]
  if (payload.conversationId !== undefined) fields.push(encodeStringField(8, payload.conversationId))
  if (payload.generationId !== undefined) fields.push(encodeStringField(9, payload.generationId))
  if (payload.model !== undefined) fields.push(encodeStringField(10, payload.model))
  return Buffer.concat(fields)
}

function decodeWriteResult(message) {
  const fields = parseProtoFields(message)
  const success = firstBytes(fields, 1)
  if (success) {
    const successFields = parseProtoFields(success)
    return {
      status: "success",
      path: firstString(successFields, 1),
      linesCreated: numberValue(firstVarint(successFields, 2)),
      fileSize: numberValue(firstVarint(successFields, 3)),
      fileContentAfterWrite: firstString(successFields, 4),
    }
  }

  return decodeErrorOneof(fields)
}

function decodeReadResult(message) {
  const fields = parseProtoFields(message)
  const success = firstBytes(fields, 1)
  if (success) {
    const successFields = parseProtoFields(success)
    return {
      status: "success",
      path: firstString(successFields, 1),
      content: firstString(successFields, 2),
      totalLines: numberValue(firstVarint(successFields, 3)),
      fileSize: numberValue(firstVarint(successFields, 4)),
      truncated: booleanValue(firstVarint(successFields, 6)),
      rangeApplied: booleanValue(firstVarint(successFields, 8)),
    }
  }

  return decodeErrorOneof(fields)
}

function decodeShellResult(message) {
  const fields = parseProtoFields(message)
  const success = firstBytes(fields, 1)
  if (success) return { status: "success", value: decodeShellOutput(success), raw: message.toString("base64") }

  const failure = firstBytes(fields, 2)
  if (failure) return { status: "error", value: decodeShellOutput(failure), raw: message.toString("base64") }

  return { ...decodeErrorOneof(fields), raw: message.toString("base64") }
}

function decodeShellOutput(message) {
  const fields = parseProtoFields(message)
  return {
    command: firstString(fields, 1),
    workingDirectory: firstString(fields, 2),
    exitCode: numberValue(firstVarint(fields, 3)),
    signal: firstString(fields, 4),
    stdout: firstString(fields, 5),
    stderr: firstString(fields, 6),
    executionTime: numberValue(firstVarint(fields, 7)),
    interleavedOutput: firstString(fields, 9),
    pid: numberValue(firstVarint(fields, 11)),
  }
}

function decodeFetchResult(message) {
  const fields = parseProtoFields(message)
  const success = firstBytes(fields, 1)
  if (success) {
    const successFields = parseProtoFields(success)
    return {
      status: "success",
      url: firstString(successFields, 1),
      content: firstString(successFields, 2),
      statusCode: numberValue(firstVarint(successFields, 3)),
      contentType: firstString(successFields, 4),
      raw: message.toString("base64"),
    }
  }

  return { ...decodeErrorOneof(fields), raw: message.toString("base64") }
}

function decodeBackgroundShellResult(message) {
  const fields = parseProtoFields(message)
  const success = firstBytes(fields, 1)
  if (success) {
    const successFields = parseProtoFields(success)
    return {
      status: "success",
      shellId: numberValue(firstVarint(successFields, 1)),
      command: firstString(successFields, 2),
      workingDirectory: firstString(successFields, 3),
      pid: numberValue(firstVarint(successFields, 4)),
      raw: message.toString("base64"),
    }
  }

  return { ...decodeErrorOneof(fields), raw: message.toString("base64") }
}

function decodeWriteShellStdinResult(message) {
  const fields = parseProtoFields(message)
  const success = firstBytes(fields, 1)
  if (success) {
    const successFields = parseProtoFields(success)
    return {
      status: "success",
      shellId: numberValue(firstVarint(successFields, 1)),
      terminalFileLengthBeforeInputWritten: numberValue(firstVarint(successFields, 2)),
      raw: message.toString("base64"),
    }
  }

  return { ...decodeErrorOneof(fields), raw: message.toString("base64") }
}

function decodeSubagentResult(message) {
  const fields = parseProtoFields(message)
  const success = firstBytes(fields, 1)
  if (success) {
    const successFields = parseProtoFields(success)
    return {
      status: "success",
      agentId: firstString(successFields, 1),
      finalMessage: firstString(successFields, 2),
      toolCallCount: numberValue(firstVarint(successFields, 3)),
      transcriptPath: firstString(successFields, 5),
      raw: message.toString("base64"),
    }
  }

  return { ...decodeErrorOneof(fields), raw: message.toString("base64") }
}

function decodeExecuteHookResult(message) {
  const fields = parseProtoFields(message)
  const response = firstBytes(fields, 1)
  if (!response) return { status: "success", raw: message.toString("base64") }

  const responseFields = parseProtoFields(response)
  const preToolUse = firstBytes(responseFields, 4)
  if (preToolUse) {
    const preToolUseFields = parseProtoFields(preToolUse)
    return {
      status: "success",
      hookType: "preToolUse",
      permission: firstString(preToolUseFields, 1),
      userMessage: firstString(preToolUseFields, 2),
      agentMessage: firstString(preToolUseFields, 3),
      updatedInput: firstString(preToolUseFields, 4),
      raw: message.toString("base64"),
    }
  }

  const postToolUse = firstBytes(responseFields, 5)
  if (postToolUse) {
    const postToolUseFields = parseProtoFields(postToolUse)
    return {
      status: "success",
      hookType: "postToolUse",
      additionalContext: firstString(postToolUseFields, 1),
      raw: message.toString("base64"),
    }
  }

  return { status: "success", raw: message.toString("base64") }
}

function decodeGenericResult(message) {
  const fields = parseProtoFields(message)
  const success = firstBytes(fields, 1)
  if (success) return { status: "success", raw: success.toString("base64") }
  return decodeErrorOneof(fields)
}

function decodeMcpStateResult(message) {
  const fields = parseProtoFields(message)
  const success = firstBytes(fields, 1)
  if (!success) return decodeErrorOneof(fields)

  const successFields = parseProtoFields(success)
  const servers = []
  const tools = []

  for (const serverBytes of successFields.get(1) ?? []) {
    if (!Buffer.isBuffer(serverBytes)) continue
    const serverFields = parseProtoFields(serverBytes)
    const server = {
      name: firstString(serverFields, 1) ?? "",
      identifier: firstString(serverFields, 2) ?? "",
      status: firstString(serverFields, 7) ?? "",
      tools: [],
    }

    for (const toolBytes of serverFields.get(5) ?? []) {
      if (!Buffer.isBuffer(toolBytes)) continue
      const toolFields = parseProtoFields(toolBytes)
      const definition = {
        name: firstString(toolFields, 1) ?? "",
        description: firstString(toolFields, 2) ?? "",
        inputSchema: decodeJsonValue(firstBytes(toolFields, 3)),
        providerIdentifier: firstString(toolFields, 4) ?? server.identifier,
        toolName: firstString(toolFields, 5) ?? "",
      }
      if (definition.name && definition.providerIdentifier && definition.toolName) {
        server.tools.push(definition)
        tools.push(definition)
      }
    }

    servers.push(server)
  }

  return { status: "success", servers, tools, raw: success.toString("base64") }
}

function decodeErrorOneof(fields) {
  for (const [fieldNumber, values] of fields.entries()) {
    if (fieldNumber === 1) continue
    const value = values[0]
    if (!Buffer.isBuffer(value)) continue
    const nested = parseProtoFields(value)
    return {
      status: "error",
      case: String(fieldNumber),
      message: firstString(nested, 2) ?? firstString(nested, 1) ?? value.toString("base64"),
    }
  }

  return { status: "unknown" }
}

function normalizeToolName(name) {
  if (name === "write_file") return "write"
  if (name === "read_file") return "read"
  if (name === "list_dir") return "ls"
  if (name === "bash") return "shell"
  if (name === "run_command") return "shell"
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
  if (name === "read_lints") return "readLints"
  if (name === "generate_image") return "generateImage"
  if (name === "create_plan") return "createPlan"
  if (name === "update_todos") return "updateTodos"
  return name ?? "unknown"
}

function normalizeToolArgs(name, args = {}) {
  if (name === "shell") {
    return {
      command: String(args.command ?? args.cmd ?? ""),
      workingDirectory: args.workingDirectory !== undefined ? String(args.workingDirectory) : "",
      timeout: args.timeout !== undefined ? Number(args.timeout) : 0,
      ...(Array.isArray(args.simpleCommands) ? { simpleCommands: args.simpleCommands.map(String) } : {}),
      ...(args.hasInputRedirect !== undefined ? { hasInputRedirect: Boolean(args.hasInputRedirect) } : {}),
      ...(args.hasOutputRedirect !== undefined ? { hasOutputRedirect: Boolean(args.hasOutputRedirect) } : {}),
      ...(args.fileOutputThresholdBytes !== undefined ? { fileOutputThresholdBytes: Number(args.fileOutputThresholdBytes) } : {}),
      ...(args.isBackground !== undefined ? { isBackground: Boolean(args.isBackground) } : {}),
      ...(args.skipApproval !== undefined ? { skipApproval: Boolean(args.skipApproval) } : {}),
      ...(args.timeoutBehavior !== undefined ? { timeoutBehavior: Number(args.timeoutBehavior) } : {}),
      ...(args.hardTimeout !== undefined ? { hardTimeout: Number(args.hardTimeout) } : {}),
      ...(args.description !== undefined ? { description: String(args.description) } : {}),
      ...(args.closeStdin !== undefined ? { closeStdin: Boolean(args.closeStdin) } : {}),
    }
  }

  if (name === "write") {
    return {
      path: String(args.path ?? ""),
      fileText: String(args.fileText ?? args.content ?? ""),
      ...(args.returnFileContentAfterWrite !== undefined
        ? { returnFileContentAfterWrite: Boolean(args.returnFileContentAfterWrite) }
        : {}),
      ...(args.fileBytes !== undefined ? { fileBytes: args.fileBytes } : {}),
      ...(args.encodingHint !== undefined ? { encodingHint: String(args.encodingHint) } : {}),
    }
  }

  if (name === "delete") {
    return { path: String(args.path ?? "") }
  }

  if (name === "read") {
    return {
      path: String(args.path ?? ""),
      ...(args.offset !== undefined ? { offset: Number(args.offset) } : {}),
      ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
      ...(args.encodingHint !== undefined ? { encodingHint: String(args.encodingHint) } : {}),
    }
  }

  if (name === "diagnostics") {
    return { path: String(args.path ?? "") }
  }

  if (name === "readLints") {
    return {
      paths: Array.isArray(args.paths)
        ? args.paths.map(String)
        : [String(args.path ?? "")].filter(Boolean),
    }
  }

  if (name === "request_context") {
    return {
      ...(args.notesSessionId !== undefined ? { notesSessionId: String(args.notesSessionId) } : {}),
      ...(args.workspaceId !== undefined ? { workspaceId: String(args.workspaceId) } : {}),
      ...(args.readOnlyPinnedTreeSha !== undefined ? { readOnlyPinnedTreeSha: String(args.readOnlyPinnedTreeSha) } : {}),
    }
  }

  if (name === "mcp") {
    return {
      name: String(args.name ?? args.toolName ?? ""),
      args: args.args && typeof args.args === "object" ? args.args : {},
      providerIdentifier: args.providerIdentifier !== undefined ? String(args.providerIdentifier) : "",
      toolName: args.toolName !== undefined ? String(args.toolName) : String(args.name ?? ""),
    }
  }

  if (name === "background_shell") {
    return {
      command: String(args.command ?? args.cmd ?? ""),
      workingDirectory: args.workingDirectory !== undefined ? String(args.workingDirectory) : "",
      ...(args.enableWriteShellStdinTool !== undefined ? { enableWriteShellStdinTool: Boolean(args.enableWriteShellStdinTool) } : {}),
      ...(args.description !== undefined ? { description: String(args.description) } : {}),
    }
  }

  if (name === "list_mcp_resources") {
    return args.server !== undefined ? { server: String(args.server) } : {}
  }

  if (name === "read_mcp_resource") {
    return {
      server: String(args.server ?? ""),
      uri: String(args.uri ?? ""),
      ...(args.downloadPath !== undefined ? { downloadPath: String(args.downloadPath) } : {}),
    }
  }

  if (name === "fetch") {
    return { url: String(args.url ?? "") }
  }

  if (name === "record_screen") {
    return {
      mode: normalizeRecordingMode(args.mode),
      ...(args.saveAsFilename !== undefined ? { saveAsFilename: String(args.saveAsFilename) } : {}),
    }
  }

  if (name === "computer_use") {
    return { actions: Array.isArray(args.actions) ? args.actions : [] }
  }

  if (name === "write_shell_stdin") {
    return {
      shellId: Number(args.shellId ?? args.shell_id ?? 0),
      chars: String(args.chars ?? ""),
    }
  }

  if (name === "task" || name === "subagent") {
    let subagentType
    if (args.subagentType !== undefined && args.subagentType !== null) {
      if (typeof args.subagentType === "object") {
        subagentType = String(args.subagentType.name ?? args.subagentType.kind ?? "")
      } else {
        subagentType = String(args.subagentType)
      }
    }
    return {
      description: args.description !== undefined ? String(args.description) : "",
      prompt: String(args.prompt ?? ""),
      ...(subagentType ? { subagentType } : {}),
      ...(args.modelId !== undefined ? { modelId: String(args.modelId) } : {}),
      ...(args.model !== undefined ? { model: String(args.model) } : {}),
      ...(args.resume !== undefined ? { resume: String(args.resume) } : {}),
      ...(args.resumeAgentId !== undefined ? { resumeAgentId: String(args.resumeAgentId) } : {}),
      ...(args.agentId !== undefined ? { agentId: String(args.agentId) } : {}),
      ...(Array.isArray(args.attachments) ? { attachments: args.attachments.map(String) } : {}),
      ...(args.mode !== undefined ? { mode: Number(args.mode) } : {}),
      ...(Array.isArray(args.respondingToMessageIds) ? { respondingToMessageIds: args.respondingToMessageIds.map(String) } : {}),
      ...(args.readonly !== undefined ? { readonly: Boolean(args.readonly) } : {}),
      ...(args.runInBackground !== undefined ? { runInBackground: Boolean(args.runInBackground) } : {}),
      ...(args.parentConversationId !== undefined ? { parentConversationId: String(args.parentConversationId) } : {}),
      ...(args.interrupt !== undefined ? { interrupt: Boolean(args.interrupt) } : {}),
      ...(args.forkAgentId !== undefined ? { forkAgentId: String(args.forkAgentId) } : {}),
      ...(args.rootParentConversationId !== undefined ? { rootParentConversationId: String(args.rootParentConversationId) } : {}),
    }
  }

  if (name === "glob") {
    return {
      globPattern: String(args.globPattern ?? args.pattern ?? args.glob ?? "*"),
      ...(args.targetDirectory !== undefined ? { targetDirectory: String(args.targetDirectory) } : {}),
    }
  }

  if (name === "semSearch" || name === "sem_search") {
    return {
      query: String(args.query ?? ""),
      ...(Array.isArray(args.targetDirectories) ? { targetDirectories: args.targetDirectories.map(String) } : {}),
      ...(args.explanation !== undefined ? { explanation: String(args.explanation) } : {}),
    }
  }

  if (name === "generateImage") {
    return {
      description: String(args.description ?? ""),
      ...(args.filePath !== undefined ? { filePath: String(args.filePath) } : {}),
      ...(Array.isArray(args.referenceImagePaths) ? { referenceImagePaths: args.referenceImagePaths.map(String) } : {}),
    }
  }

  if (name === "createPlan") {
    return { plan: String(args.plan ?? "") }
  }

  if (name === "updateTodos") {
    return {
      todos: Array.isArray(args.todos)
        ? args.todos.map((todo) => ({
            ...(todo?.id !== undefined ? { id: String(todo.id) } : {}),
            content: String(todo?.content ?? ""),
            status: normalizeTodoStatus(todo?.status),
            ...(todo?.createdAt !== undefined ? { createdAt: Number(todo.createdAt) } : {}),
            ...(todo?.updatedAt !== undefined ? { updatedAt: Number(todo.updatedAt) } : {}),
            ...(Array.isArray(todo?.dependencies) ? { dependencies: todo.dependencies.map(String) } : {}),
          }))
        : [],
      ...(args.merge !== undefined ? { merge: Boolean(args.merge) } : {}),
    }
  }

  if (name === "execute_hook") {
    return {
      hookType: String(args.hookType ?? ""),
      payload: args.payload && typeof args.payload === "object" ? args.payload : {},
    }
  }

  if (name === "force_background") {
    return { ...(args.toolCallId !== undefined ? { toolCallId: String(args.toolCallId) } : {}) }
  }

  if (name === "subagent_await") {
    return {
      agentId: String(args.agentId ?? ""),
      timeoutMs: args.timeoutMs !== undefined ? Number(args.timeoutMs) : 0,
    }
  }

  if (name === "ls") {
    return {
      path: String(args.path ?? "."),
      ...(Array.isArray(args.ignore) ? { ignore: args.ignore.map(String) } : {}),
      ...(args.timeoutMs !== undefined ? { timeoutMs: Number(args.timeoutMs) } : {}),
    }
  }

  if (name === "grep") {
    return {
      pattern: String(args.pattern ?? ""),
      ...(args.path !== undefined ? { path: String(args.path) } : {}),
      ...(args.glob !== undefined ? { glob: String(args.glob) } : {}),
      ...(args.outputMode !== undefined ? { outputMode: String(args.outputMode) } : {}),
      ...(args.contextBefore !== undefined ? { contextBefore: Number(args.contextBefore) } : {}),
      ...(args.contextAfter !== undefined ? { contextAfter: Number(args.contextAfter) } : {}),
      ...(args.context !== undefined ? { context: Number(args.context) } : {}),
      ...(args.caseInsensitive !== undefined ? { caseInsensitive: Boolean(args.caseInsensitive) } : {}),
      ...(args.type !== undefined ? { type: String(args.type) } : {}),
      ...(args.headLimit !== undefined ? { headLimit: Number(args.headLimit) } : {}),
      ...(args.multiline !== undefined ? { multiline: Boolean(args.multiline) } : {}),
      ...(args.sort !== undefined ? { sort: String(args.sort) } : {}),
      ...(args.sortAscending !== undefined ? { sortAscending: Boolean(args.sortAscending) } : {}),
      ...(args.offset !== undefined ? { offset: Number(args.offset) } : {}),
    }
  }

  return args
}

function normalizeRecordingMode(mode) {
  if (mode === "START_RECORDING") return 1
  if (mode === "SAVE_RECORDING") return 2
  if (mode === "DISCARD_RECORDING") return 3
  return mode !== undefined ? Number(mode) : 0
}

function normalizeTodoStatus(status) {
  if (status === "in_progress" || status === "in-progress" || status === "inProgress") return "inProgress"
  if (status === "completed" || status === "complete" || status === "done") return "completed"
  if (status === "cancelled" || status === "canceled") return "cancelled"
  return "pending"
}

function todoStatusToEnum(status) {
  if (status === "inProgress") return 2
  if (status === "completed") return 3
  if (status === "cancelled") return 4
  return 1
}

function diagnosticSeverityToEnum(severity) {
  if (severity === "warning") return 2
  if (severity === "information") return 3
  if (severity === "hint") return 4
  return 1
}

function toolErrorMessage(result, fallback) {
  if (typeof result?.message === "string") return result.message
  if (typeof result?.error === "string") return result.error
  if (typeof result?.error?.message === "string") return result.error.message
  return fallback
}

function numberValue(value) {
  return value === undefined ? undefined : Number(value)
}

function booleanValue(value) {
  return value === undefined ? undefined : value !== 0n
}
