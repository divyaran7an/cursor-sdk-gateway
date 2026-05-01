# Cursor cookbook ports

These are minimal ports of [Cursor's official cookbook examples](https://github.com/cursor/cookbook/tree/main/sdk), routed through `cursor-sdk-gateway` so they run with any provider model.

The diff in each port is small: one `configureCursorGateway()` call before the SDK import, and a non-Cursor model id. Everything else is the same `@cursor/sdk` shape.

## Install

```bash
npm install cursor-sdk-gateway @cursor/sdk
```

## Set a provider

```bash
export AI_GATEWAY_API_KEY="vck_..."
export CURSOR_MODEL="deepseek/deepseek-v4-flash"
```

## Examples

| Port | What it shows | Original |
|---|---|---|
| [`quickstart/`](./quickstart) | Minimal local agent that sends one prompt and streams text. | [quickstart](https://github.com/cursor/cookbook/tree/main/sdk/quickstart) |
| [`coding-agent-cli/`](./coding-agent-cli) | Small REPL that sends each line to the agent and streams responses. | [coding-agent-cli](https://github.com/cursor/cookbook/tree/main/sdk/coding-agent-cli) |

## Examples we didn't port

Cursor's cookbook also ships two full Next.js apps: [`agent-kanban`](https://github.com/cursor/cookbook/tree/main/sdk/agent-kanban) and [`app-builder`](https://github.com/cursor/cookbook/tree/main/sdk/app-builder). Both are too large to fit in here as a minimal example, but they work with `cursor-sdk-gateway` the same way the smaller ones do: add the one `configureCursorGateway()` call before any `@cursor/sdk` import, and pick a non-Cursor model id.
