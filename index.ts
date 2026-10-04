/**
 * Claude Code provider for pi.
 *
 * Registers `claude-code/*` models whose backend is the unmodified Claude
 * Code CLI: each request drives a headless `claude -p --input-format
 * stream-json` child over pi's serialized transcript, and the child's reply
 * — its own harness, its own tools, its own context management — comes back
 * as the assistant message. From the pi side this is an ordinary model: the
 * TUI, the panes, the steering, the compaction and the tools pi declares all
 * behave natively. What the model says it thought and did, it did through
 * Claude Code.
 *
 * Stage one of the idea that claude code is a provider, not a runner. Known
 * edges, all deliberate:
 *  - Claude's own tool calls travel as activity lines in the streamed text,
 *    not as pi tool calls — emitting those would make pi execute tools that
 *    belong to the claude harness.
 *  - Inside a pi-subagents child, the tools that ARE pi's travel the other
 *    way: the ask bridge surfaces caller_ping, and the tool relay surfaces
 *    every other active tool of the child pi as a real pi tool call, so the
 *    agent's declared tool list is what claude actually gets — executed by
 *    pi, auto-approved in the headless child, rendered like any other tool
 *    row. Claude keeps its own harness tools alongside the relayed ones.
 *  - The child is spawned fresh per request outside a subagent run — pi can
 *    rewrite its transcript between requests (compaction, branch, undo), and
 *    a child that re-reads the transcript each turn is always where the
 *    transcript says it is. Inside a subagent run the child is resident for
 *    the run's life: later requests adopt it and carry only the messages it
 *    has yet to see, and a run picked back up after a restart joins the
 *    recorded claude session (`--resume`) instead of starting over. Claude
 *    Code's prompt cache absorbs most of the repeated context cost either
 *    way; the per-turn harness system prompt is paid once per run, not once
 *    per request.
 *  - Images are described, not sent. The CLI's stream-json user message
 *    carries text only here.
 *  - One exception to "no pi tool calls": inside a pi-subagents child the ask
 *    bridge surfaces claude's caller_ping as a real tool call and keeps the
 *    asking claude process parked until the parent's answer arrives — the
 *    ask flows to the parent through the child pi's own channel.
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai/compat";
import { getCurrentSystemPrompt } from "./src/vendor/transcript.ts";
import { getCachedCatalog, resolveClaudeBinary } from "./src/catalog.ts";
import { ASK_PI_TOOL, resolveAskServerPath } from "./src/ask.ts";
import type { RelayToolSpec } from "./src/relay.ts";
import { DEFAULT_TOOLS, streamClaudeTurn, type ClaudeDriverConfig } from "./src/driver.ts";
import { serializeTranscript } from "./src/serialize.ts";

interface ProviderModel {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	input: number;
	output: number;
}

/**
 * The catalog. The id after `claude-code/` is passed to `--model` verbatim, so
 * the ids are the aliases Claude Code itself documents for the latest models
 * (`fable`, `opus`, `sonnet`, `haiku`) — a full name would also pass through,
 * but an alias does not age the catalog every time Anthropic ships one.
 */
export const MODELS: ProviderModel[] = [
	{ id: "fable", name: "Claude Code · Fable (latest)", contextWindow: 200_000, maxTokens: 32000, input: 10, output: 50 },
	{ id: "opus", name: "Claude Code · Opus (latest)", contextWindow: 200_000, maxTokens: 32000, input: 5, output: 25 },
	{ id: "sonnet", name: "Claude Code · Sonnet (latest)", contextWindow: 200_000, maxTokens: 64000, input: 3, output: 15 },
	{ id: "haiku", name: "Claude Code · Haiku (latest)", contextWindow: 200_000, maxTokens: 8192, input: 1, output: 5 },
];

/** The pi-subagents run dir this process serves, when it runs as a subagent
 *  child, captured at module load. It cannot be re-read per request:
 *  herdr/child.ts deletes PI_SUBAGENT_RUN_DIR from the environment on
 *  session_start so its own descendants never write into the parent's run
 *  dir — but the provider serves this session itself and needs the value for
 *  the session's whole life, including every turn after that scrub. Outside
 *  a subagent child this is undefined and every path below stays inert. */
const SUBAGENT_RUN_DIR = process.env.PI_SUBAGENT_RUN_DIR;
/** Resolved once, for the same reason. Undefined when there is no run dir or
 *  the ask server cannot be located — the bridge is off in either case. */
const ASK_SERVER_PATH = SUBAGENT_RUN_DIR ? resolveAskServerPath() : undefined;

/** The relay server is this package's own, so its path needs no resolution. */
const RELAY_SERVER_PATH = fileURLToPath(new URL("./src/relay-server.mjs", import.meta.url));

/** The extension API handle, captured at registration. The relay reads the
 *  child's active tools through it, live per spawn — other extensions
 *  register their tools after this one loads, so a snapshot taken here would
 *  miss them. */
let piHandle: ExtensionAPI | undefined;

/** The child pi's active tools, minus the ask tool — claude reaches
 *  caller_ping through the ask bridge, which is not the relay's business.
 *  Prompt guidelines fold into the description: MCP has no equivalent field,
 *  and a tool introduced without its usage advice is a tool misused. */
function relayToolCatalog(): RelayToolSpec[] {
	if (!piHandle) return [];
	const active = new Set(piHandle.getActiveTools());
	const specs: RelayToolSpec[] = [];
	for (const tool of piHandle.getAllTools()) {
		if (!active.has(tool.name) || tool.name === ASK_PI_TOOL) continue;
		const guidelines = Array.isArray(tool.promptGuidelines) ? tool.promptGuidelines.join("\n\n") : tool.promptGuidelines;
		specs.push({
			name: tool.name,
			description: [tool.description, guidelines].filter((s): s is string => !!s && s.trim().length > 0).join("\n\n"),
			inputSchema: (tool.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
		});
	}
	return specs;
}

export function resolveConfig(): ClaudeDriverConfig {
	const command = process.env.CLAUDE_CODE_PROVIDER_COMMAND || "claude";
	const tools = (process.env.CLAUDE_CODE_PROVIDER_TOOLS || DEFAULT_TOOLS.join(","))
		.split(",").map((s) => s.trim()).filter(Boolean);
	const budget = Number(process.env.CLAUDE_CODE_PROVIDER_MAX_BUDGET_USD);
	return {
		command,
		allowedTools: tools,
		includePartialMessages: true,
		maxBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : undefined,
		subagentRunDir: SUBAGENT_RUN_DIR,
		askServerPath: ASK_SERVER_PATH,
		relayServerPath: fs.existsSync(RELAY_SERVER_PATH) ? RELAY_SERVER_PATH : undefined,
		getRelayTools: piHandle ? relayToolCatalog : undefined,
	};
}

export function streamClaudeCode(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) {
	return streamClaudeTurn(model, context, options, resolveConfig());
}

/** Any catalog entry — static or scanned — as pi's model definition. */
function toProviderModel({ id, name, contextWindow, maxTokens, input, output }: ProviderModel): ProviderModelConfig {
	return {
		id,
		name,
		api: "claude-code-harness",
		reasoning: true,
		thinkingLevelMap: { minimal: "low", xhigh: "max" },
		input: ["text"],
		cost: { input, output, cacheRead: input / 10, cacheWrite: input * 1.25 },
		contextWindow,
		maxTokens,
	};
}

/**
 * The refresh: every model this CLI version accepts, read out of the binary
 * the user runs, through the binary-versioned scan cache — a preload and any
 * concurrent refreshes of one binary share a single scan, and a changed
 * binary is rescanned. Degrades to the static alias catalog when the binary
 * cannot be read or no longer matches the shapes we know — a degraded refresh
 * beats an empty catalog.
 */
export async function refreshModels(): Promise<ProviderModelConfig[]> {
	let entries: ProviderModel[];
	try {
		entries = await getCachedCatalog(resolveClaudeBinary(resolveConfig().command));
	} catch {
		entries = MODELS.map((m) => ({ ...m, alias: true }));
	}
	return entries.map(toProviderModel);
}

export default async function (pi: ExtensionAPI) {
	piHandle = pi;
	// Awaited before registration on purpose: pi waits for an async factory
	// before startup, so the very first registration already carries the full
	// scanned catalog. A synchronous registration of the static four would be
	// recomposed away by the first refresh — a window `--list-models` could
	// catch, showing 4 or the full list depending on which refresh won.
	const models = await refreshModels();
	pi.registerProvider("claude-code", {
		name: "Claude Code",
		// No endpoint and no key of ours: the claude binary owns its own auth
		// (subscription or API key, whichever the user logged in with). The
		// literal below satisfies the provider shape and is never sent anywhere.
		baseUrl: "claude-code://local",
		apiKey: "claude-code-harness",
		api: "claude-code-harness",
		models,
		streamSimple: streamClaudeCode,
		refreshModels: () => refreshModels(),
	});
}
