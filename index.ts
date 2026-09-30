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
 *  - Claude's tool calls travel as activity lines in the streamed text, not
 *    as pi tool calls — emitting those would make pi execute tools that
 *    belong to the claude harness. A later stage can relay them back through
 *    an MCP bridge if pi is to own tool execution.
 *  - The child is spawned fresh per request. Claude Code's prompt cache
 *    absorbs most of the repeated context cost, but a turn still re-pays the
 *    harness's own system prompt.
 *  - Images are described, not sent. The CLI's stream-json user message
 *    carries text only here.
 *  - One exception to "no pi tool calls": inside a pi-subagents child the ask
 *    bridge surfaces claude's caller_ping as a real tool call and keeps the
 *    asking claude process parked until the parent's answer arrives — the
 *    ask flows to the parent through the child pi's own channel.
 */
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai/compat";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { buildCatalog, resolveClaudeBinary } from "./src/catalog.ts";
import { resolveAskServerPath } from "./src/ask.ts";
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
	};
}

export function streamClaudeCode(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) {
	return streamClaudeTurn(model, context, options, resolveConfig());
}

/**
 * The refresh: every model this CLI version accepts, read out of the binary
 * the user runs. Degrades to the static alias catalog when the binary cannot
 * be read or no longer matches the shapes we know — a degraded refresh beats
 * an empty catalog.
 */
export async function refreshModels(): Promise<ProviderModelConfig[]> {
	const config = resolveConfig();
	let entries;
	try {
		entries = await buildCatalog(resolveClaudeBinary(config.command));
	} catch {
		entries = MODELS.map((m) => ({ ...m, alias: true }));
	}
	return entries.map(({ id, name, contextWindow, maxTokens, input, output }) => ({
		id,
		name,
		api: "claude-code-harness",
		reasoning: true,
		thinkingLevelMap: { minimal: "low", xhigh: "max" },
		input: ["text"],
		cost: { input, output, cacheRead: input / 10, cacheWrite: input * 1.25 },
		contextWindow,
		maxTokens,
	}));
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("claude-code", {
		name: "Claude Code",
		// No endpoint and no key of ours: the claude binary owns its own auth
		// (subscription or API key, whichever the user logged in with). The
		// literal below satisfies the provider shape and is never sent anywhere.
		baseUrl: "claude-code://local",
		apiKey: "claude-code-harness",
		api: "claude-code-harness",
		models: MODELS.map(({ id, name, contextWindow, maxTokens, input, output }) => ({
			id,
			name,
			api: "claude-code-harness",
			reasoning: true,
			thinkingLevelMap: { minimal: "low", xhigh: "max" },
			input: ["text"],
			cost: { input, output, cacheRead: input / 10, cacheWrite: input * 1.25 },
			contextWindow,
			maxTokens,
		})),
		streamSimple: streamClaudeCode,
		refreshModels: () => refreshModels(),
	});
}
