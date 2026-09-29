# pi-claude-code-provider

A [pi](https://github.com/earendil-works/pi) provider whose backend is the unmodified Claude Code CLI. Register it and `claude-code/*` behave like ordinary models: the pi TUI, panes, steering, compaction and tool declarations all work natively — while every request is actually answered by a headless `claude -p --input-format stream-json` child with Claude Code's own harness, tools and context management.

The point is the interface, not the plumbing: a conversation with `claude-code/claude-opus-5` looks, from the user's side, exactly like a session with any other pi model. What differs lives behind the provider boundary.

## How it works

Each request spawns a fresh `claude -p` child and hands it pi's transcript as one structured user message (roles and tool results inline), with pi's system prompt appended to Claude Code's own. The child runs its turn — thinking, executing its own tools across multiple internal rounds — and its reply streams back as the assistant message, live, via `--include-partial-messages` deltas.

Deliberate stage-one edges:

- **Claude's tool calls are activity lines, not pi tool calls.** Emitting a pi `toolCall` would make pi execute a tool that belongs to the claude harness. Claude's own tool use (`▸ Read src/auth.ts`, its results) is visible in the streamed text instead. A later stage can relay tool calls back through an MCP bridge if pi is to own tool execution.
- **A fresh child per request.** Claude Code's prompt cache absorbs most of the repeated transcript cost, but a turn re-pays the harness's own system prompt. Cost metadata reflects the underlying Anthropic prices.
- **Text only.** Images are acknowledged in the transcript, not sent.
- **Thinking maps to `--effort`** (`off`/`minimal` floor at `low`).

## Install

```sh
# as a pi package (installed beside pi's extensions), or point pi at the file:
pi --extension /path/to/pi-claude-code-provider/index.ts
```

The provider's peer dependencies are whatever pi installation it runs under — it does not need its own copies. For development, symlink the installed pi's packages into `node_modules/` (the layout this repo was built with):

```sh
GLOBAL=$(dirname $(dirname $(which pi)))  # adjust to your global node_modules
mkdir -p node_modules/@earendil-works
ln -s $GLOBAL/node_modules/@earendil-works/pi-ai node_modules/@earendil-works/pi-ai
ln -s $GLOBAL/@earendil-works/pi-coding-agent node_modules/@earendil-works/pi-coding-agent
ln -s $GLOBAL/node_modules/typebox node_modules/typebox
```

## Configuration

Environment variables, read when the provider is registered:

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_CODE_PROVIDER_COMMAND` | `claude` | The binary to run (resolved on PATH). |
| `CLAUDE_CODE_PROVIDER_TOOLS` | `Read,Grep,Glob,WebSearch,WebFetch` | The child's `--allowedTools` — what a headless turn may do without a human prompt. Read-only by default on purpose: widening it means claude's `Edit`/`Write`/`Bash` run unattended inside pi's turns. |
| `CLAUDE_CODE_PROVIDER_MAX_BUDGET_USD` | unset | A hard ceiling per request, passed as `--max-budget-usd`. |

Models: the catalog is **read out of your Claude Code installation at startup** — every alias and every exact model id the installed CLI accepts (`fable`, `opus`, `claude-sonnet-4-5-20250929`, the `[1m]` long-context spellings, …), so pinning a precise version is picking a row, not editing config. The refresh scans the binary the shim resolves to (read-only, a few hundred ms) and degrades to the four latest-model aliases when the binary cannot be read or its catalog format has changed. Cost figures are a family heuristic — the binary carries no prices.

## Authentication and compliance

The provider spawns the CLI as published and never touches authentication: sign in the way you always have (`claude /login`, your own subscription, or your own API key). It relies on headless mode being Claude Code's documented interface, and on the rule that an end user may sign in to the unmodified binary with their own plan — the conditions Anthropic's Claude Code compliance page states for offering Claude Code inside another product.

## Development

```sh
npm run typecheck
npm test              # unit tests, against a stand-in child; no usage
```

## Roadmap

- **Tool relay** (stage two): disable claude's own tools, expose pi's through an MCP bridge, and let pi execute — approval UI, sandbox and tool-call rendering all become pi's.
- **Steering across turns**: queue a mid-turn user message into the running child's stdin instead of waiting for the request to settle.
- **Integration with pi-subagents-herdr**: a pane child can run with this as its model (`models: { scout: "claude-code/claude-sonnet-5" }`), replacing the dedicated claude runner for agents that want claude's harness behind pi's interface.
