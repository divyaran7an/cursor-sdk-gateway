# MCP

Spins up a tiny stdio MCP server, registers it inline on the agent, and asks the agent to call its `echo` tool.

## Install

```bash
npm install cursor-sdk-gateway @cursor/sdk
```

## Set a provider

```bash
export AI_GATEWAY_API_KEY="vck_..."
export CURSOR_MODEL="deepseek/deepseek-v4-flash"
```

## Run

```bash
node examples/mcp/run.mjs
```

## Files

- `run.mjs` is the agent script.
- `demo-mcp-server.mjs` is a tiny MCP server that exposes a single `echo` tool.
