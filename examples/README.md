# Examples

Each example is a normal `@cursor/sdk` local agent. The only extra setup is one call to `configureCursorGateway()` before importing `@cursor/sdk`, and then everything else is the same Cursor SDK API you already know.

## Install

```bash
npm install cursor-sdk-gateway @cursor/sdk
```

## Setup

Set a provider before running any example.

Vercel AI Gateway:

```bash
export AI_GATEWAY_API_KEY="vck_..."
export CURSOR_MODEL="deepseek/deepseek-v4-flash"
```

Or an OpenAI-compatible endpoint (OpenRouter, LiteLLM, vLLM, LocalAI, your own gateway):

```bash
export OPENAI_COMPATIBLE_BASE_URL="https://openrouter.ai/api/v1"
export OPENAI_COMPATIBLE_API_KEY="..."
export CURSOR_MODEL="deepseek/deepseek-v4-flash"
```

## Run

```bash
node examples/basic/run.mjs
node examples/local-tools/run.mjs
node examples/mcp/run.mjs
node examples/hooks/run.mjs
node examples/subagents/run.mjs
node examples/background-shell/run.mjs
node examples/resume-generator/run.mjs "Person Name"
node examples/cursor-cookbook/quickstart/run.mjs
node examples/cursor-cookbook/coding-agent-cli/run.mjs
```

## What each one shows

| Example | What it demonstrates |
|---|---|
| `basic/` | Minimal local agent with `Agent.create`, `agent.send`, `run.stream` |
| `local-tools/` | Workspace tools: `write`, `read`, `ls`, `grep`, `shell`, `delete` |
| `mcp/` | Inline MCP server discovery and `tools/call` |
| `hooks/` | Project hooks from `.cursor/hooks.json` running pre/post tool use |
| `subagents/` | Parent agent delegating to a named subagent |
| `background-shell/` | Long-running shell with `write_shell_stdin` |
| `resume-generator/` | Multi-tool flow: `fetch` + `shell` + `write` to produce a real `.docx` |
| `cursor-cookbook/` | Ports of [Cursor's official cookbook examples](https://github.com/cursor/cookbook/tree/main/sdk) routed through the gateway |

## Attribution

`resume-generator/` is adapted from Anthropic's [Claude Agent SDK demos](https://github.com/anthropics/claude-agent-sdk-demos/tree/main/resume-generator). The original uses `@anthropic-ai/claude-agent-sdk` with `WebSearch`, `Bash`, and `Write`. This port uses `@cursor/sdk` and `cursor-sdk-gateway` with Cursor's local executor tools, so the workflow is the same but the SDK and model route are different. See [`resume-generator/README.md`](./resume-generator/README.md) for details.

## Disclaimer

This isn't an official Cursor or Anysphere project, just something I built on top of their SDK.
