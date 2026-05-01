# Basic

The smallest end-to-end example. Creates a local Cursor agent, sends one prompt, streams the assistant text.

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
node examples/basic/run.mjs
```
