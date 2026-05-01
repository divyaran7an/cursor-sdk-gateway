# Background shell

Starts a long-running shell with the `background_shell` tool and writes input to it via `write_shell_stdin`. Useful for processes that read stdin while staying alive.

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
node examples/background-shell/run.mjs
```

## Output

A file at `demo-output/background-stdin.txt`.

## Note on cheap models

`background_shell` plus `write_shell_stdin` chained together is a strict tool sequence. Cheaper models (like `deepseek/deepseek-v4-flash`) sometimes pass `\n` as the literal two characters instead of an actual newline, which keeps the shell's `read` blocked. The example still creates the file, but the run may take longer than the others while the model retries. Bigger models (Claude, GPT) handle this cleanly on the first try.
