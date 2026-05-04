# Darkbloom

This example shows how to wire [Darkbloom](https://darkbloom.dev) — Eigen Labs' decentralized inference network on hardware-attested Apple Silicon — in as the model provider for a Cursor SDK agent through `cursor-sdk-gateway`. Use it as a starting point if you want to point your own `@cursor/sdk` app at Darkbloom.

The demo itself is a minimal terminal chat: type a message, get a reply. Same agent, same local executor, same tool surface as every other example in this repo — the model call is the only thing that changes.

## Quickstart

From the repo root:

```bash
npm install
cp examples/darkbloom/.env.example examples/darkbloom/.env
# put your DARKBLOOM_API_KEY (eigeninference-...) into the file
node --env-file=examples/darkbloom/.env examples/darkbloom/run.mjs
```

You'll land at a `you:` prompt. Type, hit enter, wait for the reply. `exit` or Ctrl-C to quit.

```
chat with darkbloom · model: qwen3.5-27b-claude-opus-8bit
type 'exit' or hit ctrl-c to quit

you: hey
ai:  Hi! What can I help you with today?

you: what's in package.json?
ai:  ...... [agent uses the read tool, then summarizes]

you: exit
```

## What is Darkbloom?

Darkbloom is a decentralized inference network from [Eigen Labs](https://darkbloom.dev). Instead of routing model calls to hyperscaler GPUs, it pools idle Apple Silicon Macs and runs inference on them directly. Each request is end-to-end encrypted on the user's device, decrypted only inside a hardened process on a hardware-attested node, and the response is signed by the specific machine that produced it — so the operator running the model cannot observe the prompt or the result. The API is OpenAI-compatible.

## Files in this folder

- `run.mjs` — the chat REPL. Boots the bridge, configures `cursor-sdk-gateway`, creates a Cursor agent, loops on stdin.
- `bridge.mjs` — small local HTTP shim. The gateway treats it as a normal openai-compatible endpoint; it forwards requests to `api.darkbloom.dev` and reshapes them to match what the AI SDK expects on the wire. Self-contained — no library changes, no special provider.
- `.env.example` — copy to `.env` and add your key.

## Notes

The first reply each session is slow, usually 15–60s while Darkbloom warms up the model on whichever attested Mac picks up the request. Subsequent messages are faster. Dots tick on screen while you wait.

Because this is a Cursor SDK agent, the model can call `read`, `ls`, `grep`, `shell`, `write`, and the rest of the local executor's tools when a prompt warrants it — "read package.json", "summarize examples/basic/run.mjs", "create a file called notes.md", and so on. Plain chat works the same way; tools only fire when the model decides it needs them.

To swap models, set `CURSOR_MODEL` in `.env`. The default is `qwen3.5-27b-claude-opus-8bit`. Pull the live catalog with:

```bash
curl https://api.darkbloom.dev/v1/models \
  -H "Authorization: Bearer $DARKBLOOM_API_KEY"
```

`--env-file` needs Node 20.6+, which this package's `engines` field already requires.
