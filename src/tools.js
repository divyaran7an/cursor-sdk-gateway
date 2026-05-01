import { promises as fs } from "node:fs"
import { basename, dirname, relative, resolve, sep } from "node:path"
import { tool } from "ai"
import { z } from "zod"

const TEXT_READ_LIMIT = 200_000
const MAX_GREP_FILES = 500
const MAX_GREP_MATCHES = 100

export function createWorkspaceTools(cwd) {
  const workspace = resolve(cwd ?? process.cwd())

  return {
    write: tool({
      description:
        "Write a file in the current workspace. Use this when the user asks you to create or replace a file.",
      inputSchema: z.object({
        path: z.string().describe("Path to write, relative to the workspace."),
        fileText: z.string().describe("Complete file contents to write."),
        returnFileContentAfterWrite: z
          .boolean()
          .optional()
          .describe("Whether to include written content in the tool result."),
      }),
      execute: async (args) => writeFileTool(workspace, args),
    }),

    read: tool({
      description: "Read a file from the current workspace.",
      inputSchema: z.object({
        path: z.string().describe("Path to read, relative to the workspace."),
      }),
      execute: async (args) => readFileTool(workspace, args),
    }),

    ls: tool({
      description: "List files and directories in the current workspace.",
      inputSchema: z.object({
        path: z.string().describe("Directory path to list, relative to the workspace."),
        ignore: z.array(z.string()).optional().describe("Names to ignore."),
      }),
      execute: async (args) => listDirectoryTool(workspace, args),
    }),

    grep: tool({
      description: "Search text files in the current workspace for a pattern.",
      inputSchema: z.object({
        pattern: z.string().describe("Text or regular expression pattern to search for."),
        path: z
          .string()
          .optional()
          .describe("Directory or file path to search, relative to the workspace."),
        caseInsensitive: z.boolean().optional().describe("Search case-insensitively."),
        headLimit: z.number().optional().describe("Maximum number of matches to return."),
      }),
      execute: async (args) => grepTool(workspace, args),
    }),
  }
}

export function createCursorExecTools(executeTool, options = {}) {
  return {
    ...createMcpModelTools(options.mcpTools, executeTool),

    shell: tool({
      description: "Run a shell command through Cursor's local executor.",
      inputSchema: z.object({
        command: z.string().describe("Command to execute."),
        workingDirectory: z.string().optional().describe("Working directory."),
        timeout: z.number().optional().describe("Timeout in milliseconds."),
        description: z.string().optional().describe("Short explanation of why this command is being run."),
      }),
      execute: async (args, options) => executeTool("shell", args, options?.toolCallId),
    }),

    write: tool({
      description:
        "Write a file in the current workspace. Use this when the user asks you to create or replace a file.",
      inputSchema: z.object({
        path: z.string().describe("Path to write, relative to the workspace."),
        fileText: z.string().describe("Complete file contents to write."),
        returnFileContentAfterWrite: z
          .boolean()
          .optional()
          .describe("Whether to include written content in the tool result."),
      }),
      execute: async (args, options) => executeTool("write", args, options?.toolCallId),
    }),

    edit: tool({
      description:
        "Edit a file in the current workspace. Provide the complete updated file contents in fileText. Cursor surfaces the result as an edit step.",
      inputSchema: z.object({
        path: z.string().describe("Path to edit, relative to the workspace."),
        fileText: z.string().describe("Complete updated file contents after the edit."),
        returnFileContentAfterWrite: z
          .boolean()
          .optional()
          .describe("Whether to include the resulting content in the tool result."),
      }),
      execute: async (args, options) => executeTool("write", args, options?.toolCallId),
    }),

    delete: tool({
      description: "Delete a file from the current workspace through Cursor's local executor.",
      inputSchema: z.object({
        path: z.string().describe("Path to delete, relative to the workspace."),
      }),
      execute: async (args, options) => executeTool("delete", args, options?.toolCallId),
    }),

    read: tool({
      description: "Read a file from the current workspace.",
      inputSchema: z.object({
        path: z.string().describe("Path to read, relative to the workspace."),
        offset: z.number().optional().describe("Optional starting line offset."),
        limit: z.number().optional().describe("Optional maximum number of lines."),
      }),
      execute: async (args, options) => executeTool("read", args, options?.toolCallId),
    }),

    ls: tool({
      description: "List files and directories in the current workspace.",
      inputSchema: z.object({
        path: z.string().describe("Directory path to list, relative to the workspace."),
        ignore: z.array(z.string()).optional().describe("Names to ignore."),
      }),
      execute: async (args, options) => executeTool("ls", args, options?.toolCallId),
    }),

    grep: tool({
      description: "Search text files in the current workspace for a pattern.",
      inputSchema: z.object({
        pattern: z.string().describe("Text or regular expression pattern to search for."),
        path: z
          .string()
          .optional()
          .describe("Directory or file path to search, relative to the workspace."),
        caseInsensitive: z.boolean().optional().describe("Search case-insensitively."),
        headLimit: z.number().optional().describe("Maximum number of matches to return."),
      }),
      execute: async (args, options) => executeTool("grep", args, options?.toolCallId),
    }),

    glob: tool({
      description: "Find files by glob pattern in the current workspace.",
      inputSchema: z.object({
        globPattern: z.string().optional().describe("Glob pattern to match."),
        pattern: z.string().optional().describe("Glob pattern alias."),
        targetDirectory: z.string().optional().describe("Directory to search from."),
      }),
      execute: async (args, options) => executeTool("glob", args, options?.toolCallId),
    }),

    semSearch: tool({
      description: "Search code semantically by query.",
      inputSchema: z.object({
        query: z.string().describe("Search query."),
        targetDirectories: z.array(z.string()).optional().describe("Directories to search."),
        explanation: z.string().optional().describe("Why this search is being run."),
      }),
      execute: async (args, options) => executeTool("semSearch", args, options?.toolCallId),
    }),

    readLints: tool({
      description: "Read lint and diagnostic results for workspace files.",
      inputSchema: z.object({
        paths: z.array(z.string()).describe("Paths to inspect, relative to the workspace."),
      }),
      execute: async (args, options) => executeTool("readLints", args, options?.toolCallId),
    }),

    generateImage: tool({
      description: "Request image generation in the Cursor tool-call shape.",
      inputSchema: z.object({
        description: z.string().describe("Image description."),
        filePath: z.string().optional().describe("Optional output path."),
      }),
      execute: async (args, options) => executeTool("generateImage", args, options?.toolCallId),
    }),

    createPlan: tool({
      description: "Create a Cursor plan for the current task.",
      inputSchema: z.object({
        plan: z.string().describe("Plan text."),
      }),
      execute: async (args, options) => executeTool("createPlan", args, options?.toolCallId),
    }),

    updateTodos: tool({
      description: "Update Cursor-style todos for the current task.",
      inputSchema: z.object({
        todos: z.array(z.object({
          content: z.string().describe("Todo text."),
          status: z.enum(["pending", "inProgress", "completed", "cancelled"]).describe("Todo status."),
        })).describe("Todo items."),
      }),
      execute: async (args, options) => executeTool("updateTodos", args, options?.toolCallId),
    }),

    fetch: tool({
      description: "Fetch a URL through Cursor's local executor.",
      inputSchema: z.object({
        url: z.string().describe("URL to fetch."),
      }),
      execute: async (args, options) => executeTool("fetch", args, options?.toolCallId),
    }),

    mcp: tool({
      description: "Call an MCP tool configured for the Cursor agent.",
      inputSchema: z.object({
        name: z.string().optional().describe("MCP tool name."),
        providerIdentifier: z.string().optional().describe("MCP provider/server identifier."),
        toolName: z.string().optional().describe("MCP tool name."),
        args: z.record(z.string(), z.any()).optional().describe("MCP tool arguments."),
      }),
      execute: async (args, options) => executeTool("mcp", args, options?.toolCallId),
    }),

    list_mcp_resources: tool({
      description: "List resources from configured MCP servers.",
      inputSchema: z.object({
        server: z.string().optional().describe("Optional MCP server name."),
      }),
      execute: async (args, options) => executeTool("list_mcp_resources", args, options?.toolCallId),
    }),

    read_mcp_resource: tool({
      description: "Read a resource from a configured MCP server.",
      inputSchema: z.object({
        server: z.string().describe("MCP server name."),
        uri: z.string().describe("Resource URI."),
        downloadPath: z.string().optional().describe("Optional path for downloaded content."),
      }),
      execute: async (args, options) => executeTool("read_mcp_resource", args, options?.toolCallId),
    }),

    mcp_state: tool({
      description: "Read Cursor MCP state.",
      inputSchema: z.object({}),
      execute: async (args, options) => executeTool("mcp_state", args, options?.toolCallId),
    }),

    background_shell: tool({
      description: "Start a background shell command through Cursor's local executor.",
      inputSchema: z.object({
        command: z.string().describe("Command to run in the background."),
        workingDirectory: z.string().optional(),
        enableWriteShellStdinTool: z.boolean().optional(),
        description: z.string().optional(),
      }),
      execute: async (args, options) => executeTool("background_shell", args, options?.toolCallId),
    }),

    write_shell_stdin: tool({
      description: "Write stdin to a background shell started by Cursor.",
      inputSchema: z.object({
        shellId: z.number().describe("Cursor shell id."),
        chars: z.string().describe("Characters to write to stdin."),
      }),
      execute: async (args, options) => executeTool("write_shell_stdin", args, options?.toolCallId),
    }),

    task: tool({
      description: "Spawn a Cursor subagent task through Cursor's local executor.",
      inputSchema: z.object({
        description: z.string().describe("Short description of the subagent task."),
        prompt: z.string().describe("Task prompt for the subagent."),
        subagentType: z
          .union([
            z.string(),
            z.object({ kind: z.string(), name: z.string().optional() }),
          ])
          .optional()
          .describe("Subagent identifier — Cursor accepts either a string name or { kind, name }."),
        model: z.string().optional(),
        modelId: z.string().optional(),
        resume: z.string().optional(),
        agentId: z.string().optional(),
        attachments: z.array(z.string()).optional(),
        readonly: z.boolean().optional(),
        runInBackground: z.boolean().optional(),
      }),
      execute: async (args, options) => executeTool("task", args, options?.toolCallId),
    }),

    subagent_await: tool({
      description: "Wait for a background Cursor subagent.",
      inputSchema: z.object({
        agentId: z.string().describe("Subagent id."),
        timeoutMs: z.number().optional().describe("Timeout in milliseconds."),
      }),
      execute: async (args, options) => executeTool("subagent_await", args, options?.toolCallId),
    }),

    force_background_shell: tool({
      description: "Force a running shell tool call into the background.",
      inputSchema: z.object({
        toolCallId: z.string().optional(),
      }),
      execute: async (args, options) => executeTool("force_background_shell", args, options?.toolCallId),
    }),

    force_background_subagent: tool({
      description: "Force a running subagent tool call into the background.",
      inputSchema: z.object({
        toolCallId: z.string().optional(),
      }),
      execute: async (args, options) => executeTool("force_background_subagent", args, options?.toolCallId),
    }),

    request_context: tool({
      description: "Request Cursor workspace context.",
      inputSchema: z.object({
        notesSessionId: z.string().optional(),
        workspaceId: z.string().optional(),
        readOnlyPinnedTreeSha: z.string().optional(),
      }),
      execute: async (args, options) => executeTool("request_context", args, options?.toolCallId),
    }),

    record_screen: tool({
      description: "Record or save the screen through Cursor's local executor.",
      inputSchema: z.object({
        mode: z.number().optional(),
        saveAsFilename: z.string().optional(),
      }),
      execute: async (args, options) => executeTool("record_screen", args, options?.toolCallId),
    }),

    recordScreen: tool({
      description: "Record or save the screen through Cursor's local executor.",
      inputSchema: z.object({
        mode: z.enum(["START_RECORDING", "SAVE_RECORDING", "DISCARD_RECORDING"]).describe("Recording action."),
      }),
      execute: async (args, options) => executeTool("recordScreen", args, options?.toolCallId),
    }),
  }
}

function createMcpModelTools(mcpTools = [], executeTool) {
  const output = {}
  const usedNames = new Set()

  for (const definition of mcpTools) {
    const modelToolName = uniqueToolName(toModelToolName(definition.name), usedNames)
    if (!modelToolName) continue

    output[modelToolName] = tool({
      description: definition.description || `Call MCP tool ${definition.toolName} on ${definition.providerIdentifier}.`,
      inputSchema: z.object({}).catchall(z.any()),
      execute: async (args, options) => executeTool("mcp", {
        name: definition.name,
        providerIdentifier: definition.providerIdentifier,
        toolName: definition.toolName,
        args: args && typeof args === "object" && !Array.isArray(args) ? args : {},
      }, options?.toolCallId),
    })
  }

  return output
}

function toModelToolName(name) {
  return String(name ?? "")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
}

function uniqueToolName(name, usedNames) {
  if (!name) return undefined
  if (!usedNames.has(name)) {
    usedNames.add(name)
    return name
  }

  for (let index = 2; index < 100; index += 1) {
    const suffix = `_${index}`
    const candidate = `${name.slice(0, 64 - suffix.length)}${suffix}`
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate)
      return candidate
    }
  }

  return undefined
}

export function cursorToolCallFromPart(part, result) {
  const name = normalizeToolName(part.name)
  const args = normalizeToolArgs(name, part.args)

  return {
    type: name,
    args,
    ...(result !== undefined ? { result: normalizeToolResult(name, result) } : {}),
  }
}

function normalizeToolName(name) {
  if (name === "write_file") return "write"
  if (name === "read_file") return "read"
  if (name === "list_dir") return "ls"
  if (name === "read_lints") return "readLints"
  if (name === "generate_image") return "generateImage"
  if (name === "create_plan") return "createPlan"
  if (name === "update_todos") return "updateTodos"
  if (name === "record_screen") return "recordScreen"
  return name ?? "unknown"
}

function normalizeToolArgs(name, args = {}) {
  if (name === "write") {
    return {
      path: String(args.path ?? ""),
      fileText: String(args.fileText ?? args.content ?? ""),
      ...(args.returnFileContentAfterWrite !== undefined
        ? { returnFileContentAfterWrite: Boolean(args.returnFileContentAfterWrite) }
        : {}),
    }
  }

  if (name === "read") {
    return { path: String(args.path ?? "") }
  }

  if (name === "readLints") {
    return {
      paths: Array.isArray(args.paths)
        ? args.paths.map(String)
        : [String(args.path ?? "")].filter(Boolean),
    }
  }

  if (name === "ls") {
    return {
      path: String(args.path ?? "."),
      ...(Array.isArray(args.ignore) ? { ignore: args.ignore.map(String) } : {}),
    }
  }

  if (name === "grep") {
    return {
      pattern: String(args.pattern ?? ""),
      ...(args.path !== undefined ? { path: String(args.path) } : {}),
      ...(args.caseInsensitive !== undefined
        ? { caseInsensitive: Boolean(args.caseInsensitive) }
        : {}),
      ...(args.headLimit !== undefined ? { headLimit: Number(args.headLimit) } : {}),
    }
  }

  if (name === "generateImage") {
    return {
      description: String(args.description ?? ""),
      ...(args.filePath !== undefined ? { filePath: String(args.filePath) } : {}),
    }
  }

  if (name === "createPlan") {
    return { plan: String(args.plan ?? "") }
  }

  if (name === "updateTodos") {
    return {
      todos: Array.isArray(args.todos)
        ? args.todos.map((todo) => ({
            content: String(todo?.content ?? ""),
            status: normalizeTodoStatus(todo?.status),
          }))
        : [],
    }
  }

  return args
}

function normalizeTodoStatus(status) {
  if (status === "in_progress" || status === "in-progress" || status === "inProgress") return "inProgress"
  if (status === "completed" || status === "complete" || status === "done") return "completed"
  if (status === "cancelled" || status === "canceled") return "cancelled"
  return "pending"
}

function normalizeToolResult(_name, result) {
  if (result && typeof result === "object" && "status" in result) return result
  return { status: "success", value: result }
}

async function writeFileTool(workspace, rawArgs) {
  const args = normalizeToolArgs("write", rawArgs)
  const target = safeResolve(workspace, args.path)
  await fs.mkdir(dirname(target), { recursive: true })
  await fs.writeFile(target, args.fileText, "utf8")
  const stat = await fs.stat(target)

  return {
    status: "success",
    value: {
      path: toWorkspacePath(workspace, target),
      linesCreated: countLines(args.fileText),
      fileSize: stat.size,
      ...(args.returnFileContentAfterWrite
        ? { fileContentAfterWrite: args.fileText }
        : {}),
    },
  }
}

async function readFileTool(workspace, rawArgs) {
  const args = normalizeToolArgs("read", rawArgs)
  const target = safeResolve(workspace, args.path)
  const stat = await fs.stat(target)
  const content = await fs.readFile(target, "utf8")
  const limited =
    content.length > TEXT_READ_LIMIT
      ? `${content.slice(0, TEXT_READ_LIMIT)}\n...[truncated]`
      : content

  return {
    status: "success",
    value: {
      content: limited,
      totalLines: countLines(content),
      fileSize: stat.size,
    },
  }
}

async function listDirectoryTool(workspace, rawArgs) {
  const args = normalizeToolArgs("ls", rawArgs)
  const target = safeResolve(workspace, args.path)
  const entries = await fs.readdir(target, { withFileTypes: true })
  const ignored = new Set(args.ignore ?? [])
  const children = entries
    .filter((entry) => !ignored.has(entry.name))
    .slice(0, 200)
    .map((entry) => ({
      name: entry.name,
      path: toWorkspacePath(workspace, resolve(target, entry.name)),
      type: entry.isDirectory() ? "directory" : "file",
    }))

  return {
    status: "success",
    value: {
      directoryTreeRoot: {
        name: basename(target) || ".",
        path: toWorkspacePath(workspace, target),
        type: "directory",
        children,
      },
    },
  }
}

async function grepTool(workspace, rawArgs) {
  const args = normalizeToolArgs("grep", rawArgs)
  const start = safeResolve(workspace, args.path ?? ".")
  const flags = args.caseInsensitive ? "i" : ""
  const regex = new RegExp(args.pattern, flags)
  const files = await collectFiles(start)
  const matches = []
  const limit = Math.min(args.headLimit || MAX_GREP_MATCHES, MAX_GREP_MATCHES)

  for (const file of files.slice(0, MAX_GREP_FILES)) {
    let content
    try {
      content = await fs.readFile(file, "utf8")
    } catch {
      continue
    }

    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      if (!regex.test(lines[index])) continue
      regex.lastIndex = 0
      matches.push({
        file: toWorkspacePath(workspace, file),
        lineNumber: index + 1,
        line: lines[index],
      })
      if (matches.length >= limit) break
    }
    if (matches.length >= limit) break
  }

  return {
    status: "success",
    value: {
      workspaceResults: {
        [workspace]: {
          type: "content",
          output: {
            matches,
            totalMatches: matches.length,
          },
        },
      },
    },
  }
}

async function collectFiles(start) {
  const stat = await fs.stat(start)
  if (stat.isFile()) return [start]
  const output = []
  await walk(start, output)
  return output
}

async function walk(directory, output) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (output.length >= MAX_GREP_FILES) return
    if (entry.name === "node_modules" || entry.name === ".git") continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      await walk(path, output)
    } else if (entry.isFile()) {
      output.push(path)
    }
  }
}

function safeResolve(workspace, inputPath) {
  const target = resolve(workspace, inputPath || ".")
  if (target !== workspace && !target.startsWith(`${workspace}${sep}`)) {
    throw new Error(`Path escapes workspace: ${inputPath}`)
  }
  return target
}

function toWorkspacePath(workspace, path) {
  const value = relative(workspace, path)
  return value || "."
}

function countLines(text) {
  if (!text) return 0
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length
}
