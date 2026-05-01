# Quickstart (Cursor cookbook port)

A port of [Cursor's official quickstart](https://github.com/cursor/cookbook/tree/main/sdk/quickstart). Same code, just routed through `cursor-sdk-gateway` so you can pick any model.

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
node examples/cursor-cookbook/quickstart/run.mjs
```

## Diff vs the original

| Original | This port |
|---|---|
| `import { Agent } from "@cursor/sdk"` | `await configureCursorGateway(...)` then `await import("@cursor/sdk")` |
| `apiKey: process.env.CURSOR_API_KEY` | no Cursor key, gateway routes to your provider |
| `model: { id: "composer-2" }` | `model: { id: "deepseek/deepseek-v4-flash" }` (or any provider model) |
