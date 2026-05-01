# Hooks

Drops a `.cursor/hooks.json` into the current directory with pre and post tool hooks, then runs the agent so the hooks fire around tool calls.

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
node examples/hooks/run.mjs
```

This writes `.cursor/hooks.json` in the current working directory. Run it from a demo folder, or remove that file afterward.

## Files

- `run.mjs` is the agent script.
- `hook.mjs` is the small Node script the hook config invokes around tool calls.
