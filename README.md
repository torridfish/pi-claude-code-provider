# pi-claude-code-provider

A [pi](https://github.com/earendil-works/pi) provider whose backend is the unmodified Claude Code CLI. Register it and `claude-code/*` behave like ordinary models: the pi TUI, panes, steering, compaction and tool declarations all work natively — while every request is actually answered by a headless `claude -p --input-format stream-json` child with Claude Code's own harness, tools and context management.

The point is the interface, not the plumbing: a conversation with `claude-code/claude-opus-5` looks, from the user's side, exactly like a session with any other pi model. What differs lives behind the provider boundary.

## How it works

Each request spawns a fresh `claude -p` child and hands it pi's transcript as one structured user message (roles and tool results inline), with pi's system prompt appended to Claude Code's own. The child runs its turn — thinking, executing its own tools across multiple internal rounds — and its reply streams back as the assistant message, live, via `--include-partial-messages` deltas.

Deliberate stage-one edges:

- **Claude's tool calls are activity lines, not pi tool calls.** Emitting a pi `toolCall` would make pi execute a tool that belongs to the claude harness. Claude's own tool use (`▸ Read src/auth.ts`, its results) is visible in the streamed text instead. A later stage can relay tool calls back through an MCP bridge if pi is to own tool execution. The one exception is the ask bridge below: `caller_ping` is the child pi's own tool, not one of claude's.
- **A fresh child per request — outside a subagent run.** A main-session transcript can be rewritten between requests (compaction, branch, undo), and a child that re-reads the transcript each turn is always exactly where the transcript says it is. Inside a subagent run the child is resident for the run's life instead: later requests adopt it and carry only the messages it has yet to see, so the harness system prompt is paid once per run, not once per request. A run picked back up after a restart joins the claude session the first leg recorded (`--resume`; the id lives in a `claude-session-id` file in the run dir) — and if claude's own store no longer has that session, the driver retries once as a fresh conversation with the full transcript before giving up. Cost metadata reflects the underlying Anthropic prices.
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
| `CLAUDE_CODE_PROVIDER_TOOLS` | `Read,Grep,Glob,WebSearch,WebFetch` | The child's `--allowedTools` — what a headless turn may do without a human prompt. Read-only by default on purpose: widening it means claude's `Edit`/`Write`/`Bash` run unattended inside pi's turns. Note the effective surface also includes Claude Code's built-in set of read-only Bash commands (`ls`, `cat`, `grep`, `find`, read-only `git`, …), which run without a prompt in every mode and cannot be configured away — `--permission-prompts none` denies everything else that would prompt, it allows nothing. |
| `CLAUDE_CODE_PROVIDER_MAX_BUDGET_USD` | unset | A hard ceiling per request, passed as `--max-budget-usd`. |
| `CLAUDE_CODE_PROVIDER_ASK_SERVER` | sibling checkout | Where the ask MCP server lives (see below); the bridge is off when it cannot be found. |

Models: the catalog is **read out of your Claude Code installation at startup** — every alias and every exact model id the installed CLI accepts (`fable`, `opus`, `claude-sonnet-4-5-20250929`, the `[1m]` long-context spellings, …), so pinning a precise version is picking a row, not editing config. The refresh scans the binary the shim resolves to (read-only, a few hundred ms) and degrades to the four latest-model aliases when the binary cannot be read or its catalog format has changed. Cost figures are a family heuristic — the binary carries no prices.

## Asking its caller (the pi-subagents bridge)

Inside a [pi-subagents-herdr](https://github.com/torridfish/pi-subagents-herdr) child — a run whose model is this provider — claude can ask the agent that dispatched it a question, the same way any child can. The run dir (`PI_SUBAGENT_RUN_DIR`) is captured when the provider loads; the child extension scrubs it from the environment on `session_start`, but the provider serves this session itself and needs the value for its whole life.

The mechanics, per ask:

1. The driver spawns claude with the run's ask MCP server (`--mcp-config`, pre-approved under its mangled MCP name) and none of the `PI_SUBAGENT_*` variables in claude's own env.
2. When claude's stream shows a `caller_ping` call, it is surfaced as a **real pi tool call** — the one tool that breaks the no-toolCall rule, because executing it is how the question reaches the parent. The request ends with a `toolUse` stop reason; pi's loop executes its own `caller_ping` and parks the child session.
3. The claude process that asked is **parked, not killed**: its stdin stays open and its in-process context — everything it did that pi's transcript never saw — survives. Stream events that arrive with no request to consume them are buffered.
4. The next request adopts the parked child. Right after the tool result it carries no new message: the child finishes its ask turn on its own and the buffered events replay into that request. When the parent's answer arrives (a later user message), the driver writes just that text into the parked child's stdin — and appends the delivery marker to `answers.jsonl`, which the parent does for its own runner children but not for pi ones — and the child's completion streams as that turn's assistant message. Further asks repeat the cycle in the same process.

The resident child dies with the run: an aborted request kills it, and the provider process exiting SIGTERMs whatever is still open. A run picked back up after a restart finds no resident child and joins the recorded claude session (`--resume`) instead — only a claude whose own store no longer has that session falls back to a fresh conversation with the full serialized transcript.

The ask server path is the sibling checkout's `runners/claude-ask.mjs` (one implementation of the ask protocol for both consumers), overridable with `CLAUDE_CODE_PROVIDER_ASK_SERVER`; without it the bridge stays off.

## Authentication and compliance

The provider spawns the CLI as published and never touches authentication: sign in the way you always have (`claude /login`, your own subscription, or your own API key). It relies on headless mode being Claude Code's documented interface, and on the rule that an end user may sign in to the unmodified binary with their own plan — the conditions Anthropic's Claude Code compliance page states for offering Claude Code inside another product.

## Development

```sh
npm run typecheck
npm test              # unit tests, against a stand-in child; no usage
```

## The tool relay (pi's tools, executed by pi)

Inside a pi-subagents run dir the provider arms a second MCP sidecar, `pi_relay`, that serves the child pi's ACTIVE tools (its `--tools` allowlist, minus `caller_ping`, which the ask bridge owns) to claude under namespaced names (`mcp__pi_relay__read`, …). The mechanics, per call:

1. The driver publishes the catalog — name, description (pi's prompt guidelines folded in), parameter schema — to `<runDir>/relay-tools.json` before spawning claude, and pre-approves every relayed tool in `--allowedTools`.
2. When claude's stream shows a relayed `tool_use` block, the driver surfaces it as a REAL pi tool call — pi's loop executes it the way it executes its own, auto-approved in a headless child — and the turn ends with `toolUse`, exactly like the ask.
3. The next request's transcript carries the `toolResult`; the driver drops it into `<runDir>/relay-res/`, where the sidecar — still blocked in the `tools/call` it received from claude — finds it by the (tool, arguments) key both sides hash, and answers.
4. Claude's turn continues in the same process, replaying into the request that delivered the result.

The relay is ADDITIVE: claude keeps its own harness tools and its built-in read-only Bash set, and reaches for whichever tool fits. That is the point — an agent's declared tool list becomes authoritative for what EXTRA surface claude gets (`subagent`, `write`, custom extension tools, pi's `web_search`), while the harness's strengths stay native. Overlapping pairs (`Read` vs relayed `read`) coexist; claude prefers its own.

Display follows execution: relayed calls render as ordinary pi tool rows in the herdr pane; claude's own tools remain activity lines.

## Roadmap

- **Steering across turns**: queue a mid-turn user message into the running child's stdin instead of waiting for the request to settle.
- **Integration with pi-subagents-herdr**: a pane child can run with this as its model (`models: { scout: "claude-code/claude-sonnet-5" }`), replacing the dedicated claude runner for agents that want claude's harness behind pi's interface. The ask bridge and the tool relay are in; what remains is progress shaping for claude's own (non-relayed) tool activity.
