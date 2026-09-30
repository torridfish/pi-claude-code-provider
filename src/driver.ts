/**
 * Drive one turn of `claude -p` and adapt its stream onto pi's message-event
 * protocol.
 *
 * A request to this provider is one conversation turn. Outside a subagent run
 * the child is spawned fresh per request, handed the serialized transcript as
 * its only user message, and read until its `result` event; inside one it is
 * resident for the run's life (see below). Claude Code executes its own tools
 * inside that turn — the harness is the point of going through the CLI — and
 * what comes back is text.
 *
 * Outside a run dir the fresh spawn is load-bearing, not incidental: pi can
 * rewrite its transcript between requests (compaction, branch, undo), and a
 * child that re-reads the transcript each turn is always exactly where the
 * transcript says it is. A resident child carries its own in-process context,
 * which pi cannot rewind. A subagent run is append-only in practice, which is
 * what makes residency safe there.
 *
 * What is deliberately NOT mapped onto pi: tool calls. Emitting a toolCall
 * block would make pi execute it, and the tool it names belongs to Claude
 * Code, not to pi. Claude's tool activity travels as activity lines inside
 * the streamed text instead, so the pi TUI shows what the child is doing
 * without ever running a second copy of it.
 *
 * The one exception is the ask bridge: inside a pi-subagents run dir, claude's
 * `caller_ping` call is surfaced as a REAL pi tool call, because that tool is
 * the child pi's own (registered by herdr/child.ts, not part of claude's
 * harness) — pi executing it is how the question reaches the parent. The
 * claude process that asked is then parked, not killed: its stdin stays open
 * so its in-process context survives, and the request that carries the
 * parent's answer adopts it and feeds the answer in. See `Session`.
 *
 * The park is the general rule, not the ask's special case: inside a run dir
 * every spawned child stays resident after its request settles, and every
 * later request of the run adopts it — delivering only the messages it has
 * yet to see. The transcript is re-serialized exactly once, on the first
 * spawn; each later turn costs the turn itself, not the harness system
 * prompt plus the whole history again. A run picked back up after a restart
 * finds no resident child and joins the claude session the first leg recorded
 * (`--resume`, the id kept in the run dir) rather than starting over; only a
 * claude whose own store no longer has that session falls back to a fresh
 * conversation with the full transcript.
 *
 * Compliance note: the binary is spawned unmodified, auth is its own, and
 * `-p` with stream-json is Claude Code's documented headless interface.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Model,
	SimpleStreamOptions,
	ToolCall,
	TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
// From the util subpaths rather than the compat barrel: an extension loaded by
// the host's module loader can have the barrel's circular internals snapshotted
// mid-evaluation, dropping re-exported names (observed: getCurrentSystemPrompt
// undefined in a child process). The leaf subpaths have no cycle to fall into.
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { ASK_PI_TOOL, ASK_SERVER, ASK_TOOL } from "./ask.ts";
import { flattenText, serializeTranscript } from "./serialize.ts";

/** The standard built-in set a headless child is pre-approved to use. Read
 *  -only on purpose: a provider that writes and runs shell commands without
 *  pi's approval flow in the way is a decision for whoever sets this, not a
 *  default. CLAUDE_CODE_PROVIDER_TOOLS widens it.
 *
 *  The effective surface is this list plus Claude Code's built-in set of
 *  read-only Bash commands (`ls`, `cat`, `grep`, `find`, read-only `git`,
 *  …), which run without a permission prompt in every mode and are not
 *  configurable — `--allowedTools` never gates them. `--permission-prompts
 *  none` denies everything else that would prompt; it allows nothing. */
export const DEFAULT_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"];

export interface ClaudeDriverConfig {
	command: string;
	allowedTools: string[];
	/** Stream text as it is written, not turn by turn. Requires Claude Code's
	 *  `--include-partial-messages`; without it the child emits whole
	 *  assistant messages and the pi TUI sees the same content arrive later. */
	includePartialMessages: boolean;
	maxBudgetUsd?: number;
	/** The pi-subagents run directory this provider serves, when it runs inside
	 *  a subagent child. Captured at registration — herdr/child.ts scrubs
	 *  PI_SUBAGENT_RUN_DIR out of process.env on session_start (descendants
	 *  must not write into the parent's run dir), but the provider serves the
	 *  session itself and needs the value for its whole life. */
	subagentRunDir?: string;
	/** The ask MCP server script handed to claude via `--mcp-config`. Only
	 *  meaningful together with `subagentRunDir`; the bridge is off when
	 *  either half is missing. */
	askServerPath?: string;
}

/** pi's thinking levels are broader than Claude Code's `--effort`; "off" and
 *  "minimal" both floor at "low", which is the no-effort end of what the CLI
 *  accepts. */
const EFFORT_LEVELS: Record<string, string> = {
	off: "low",
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

export function resolveEffort(reasoning: string | undefined): string | undefined {
	if (!reasoning) return undefined;
	return EFFORT_LEVELS[reasoning];
}

/** The child's argv, exported for tests: this is the contract with the CLI. */
export function buildClaudeCodeArgs(model: string, effort: string | undefined, systemPrompt: string, config: ClaudeDriverConfig, sessionId?: string, resume = false): string[] {
	// The ask bridge exists only when both halves are configured; either alone
	// would name a tool no server answers.
	const askBridge = !!(config.subagentRunDir && config.askServerPath);
	const allowed = [...config.allowedTools];
	if (askBridge) allowed.push(ASK_TOOL);
	const args = [
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose", // stream-json requires it under --print
		"--include-partial-messages",
		"--model", model,
		"--permission-prompts", "none",
		// Variadic, and DROPS unrecognized names silently: an empty table means
		// "no tools at all", spelled explicitly.
		"--allowedTools", ...(allowed.length > 0 ? allowed : [""]),
	];
	// The id-spelling the dedicated claude runner also uses: a run names its
	// conversation at first spawn and joins it by id when picked back up. Left
	// off outside a run dir, where the child is fresh per request by design.
	if (sessionId) args.push(resume ? "--resume" : "--session-id", sessionId);
	if (askBridge) {
		// The same shape runners/claude.ts passes: one inline server definition,
		// with the run directory spelled out because the claude child's own env
		// is scrubbed of PI_SUBAGENT_* when it is spawned below.
		args.push("--mcp-config", JSON.stringify({
			mcpServers: {
				[ASK_SERVER]: {
					command: process.execPath,
					args: [config.askServerPath],
					env: { PI_SUBAGENT_RUN_DIR: config.subagentRunDir },
				},
			},
		}));
	}
	if (effort) args.push("--effort", effort);
	if (systemPrompt.trim()) args.push("--append-system-prompt", systemPrompt);
	if (config.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(config.maxBudgetUsd));
	return args;
}

function zeroUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** What a failed `result` event says, in its own words when it has them. */
function describeResult(evt: any): string {
	if (typeof evt.result === "string" && evt.result.trim()) return evt.result.trim();
	if (evt.api_error_status) return `Claude Code API error ${evt.api_error_status}`;
	return `Claude Code ended with ${evt.subtype || "an error"}`;
}

// ── The ask bridge ────────────────────────────────────────────────────
//
// A claude child that asked its caller a question cannot die with the request
// that surfaced it: pi's turn continues past the toolCall (it executes its own
// caller_ping and requests again), and the parent's answer arrives as a user
// message one or more requests later. The process that asked is parked here —
// stdin open, holding its whole in-process context — and adopted by the next
// request for the same run dir, which either lets it finish its ask turn or
// feeds it the answer. The registry lives in the provider's own process, which
// is the parked pi child itself: in-memory state survives exactly as long as
// the park can. A run picked back up after a restart finds no park and falls
// back to a fresh spawn reading the full serialized transcript.

/** Resident claude children by run dir. Exported for tests and for cleanup. */
export const residentSessions = new Map<string, Session>();

class Session {
	readonly proc: ChildProcess;
	readonly runDir: string;
	/** The tool_use id of the ask this session surfaced to pi; the request that
	 *  continues past pi's own caller_ping result references it. */
	askToolCallId: string | undefined;
	/** Stream events that arrived with no request attached to consume them. */
	buffer: any[] = [];
	/** The request currently consuming this child's stream, if any. */
	sink: Turn | null = null;
	/** A `result` event has been routed since the last delivery: the child
	 *  finished its turn and now waits for the next user message on stdin. */
	idle = false;
	/** This driver closed the child's stdin (a turn ended without a park): the
	 *  child is on its way out and must not be adopted. */
	stdinClosed = false;
	exited = false;
	stderrTail = "";

	constructor(proc: ChildProcess, runDir: string) {
		this.proc = proc;
		this.runDir = runDir;
		residentSessions.set(runDir, this);
	}
}

/** Whether a resident child can still be adopted by an incoming request. */
function adoptable(session: Session): boolean {
	return !session.exited && !session.stdinClosed
		&& session.proc.exitCode === null && !session.proc.signalCode;
}

let exitHookInstalled = false;
function installExitHook() {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	// The resident child outlives every request; it dies when the pi child
	// does.
	process.on("exit", () => {
		for (const session of residentSessions.values()) {
			try { session.proc.kill("SIGTERM"); } catch { /* already gone */ }
		}
	});
}

/** The parent appends one line per delivery for its own runner children; it
 *  holds the pi child's stdin, not this claude's, so the provider records the
 *  delivery itself — the ask server counts these lines to tell an answered
 *  question from an outstanding one. */
function recordDelivery(runDir: string) {
	try {
		fs.appendFileSync(path.join(runDir, "answers.jsonl"), JSON.stringify({ at: Date.now(), via: "claude-code-provider" }) + "\n", { mode: 0o600 });
	} catch { /* a failed record only degrades the second-ask check */ }
}

/** The user-message envelope claude's streaming input takes, as herdr's
 *  claude runner writes it. */
function userMessage(text: string): string {
	return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
}

// ── The claude session id ─────────────────────────────────────────
//
// A run records the id its first spawn named in the run dir, where the
// relaunched provider process of a picked-back-up run finds it. Same shape
// as the dedicated runner's `--session-id` argv: `--session-id` names a new
// conversation, `--resume` joins the one the id already names.

const SESSION_FILE = "claude-session-id";
/** How long a resume probe waits for the child's first stdout line before
 *  concluding it is alive (a child still starting up) rather than dead. */
const RESUME_PROBE_MS = 3000;

function readSessionId(runDir: string): string | undefined {
	try {
		const id = fs.readFileSync(path.join(runDir, SESSION_FILE), "utf8").trim();
		return id || undefined;
	} catch { return undefined; }
}

function writeSessionId(runDir: string, id: string): void {
	try { fs.writeFileSync(path.join(runDir, SESSION_FILE), id + "\n", { mode: 0o600 }); } catch { /* a failed record costs only the resume path */ }
}

// ── One request's view of the turn ────────────────────────────────────

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface Turn {
	message: AssistantMessage;
	stream: AssistantMessageEventStream;
	isFinished(): boolean;
	wasAborted(): boolean;
	push(event: DistributiveOmit<AssistantMessageEvent, "partial">): void;
	closeBlock(type: "text" | "thinking"): void;
	addText(delta: string): void;
	addThinking(delta: string): void;
	addActivity(line: string): void;
	/** Terminate the turn with `done`. A turn that surfaced an ask, or one that
	 *  adopted a parked child, leaves the claude process's stdin open: the
	 *  child survives the request. Everything else ends it. */
	finish(reason: "stop" | "length" | "toolUse" | "deferred"): void;
	/** Terminate with an error: close the child's stdin, land the error on the
	 *  stream. Idempotent, like finish. */
	finishError(errorMessage: string, reason: "aborted" | "error"): void;
	/** Undo this turn's abort subscription without terminating anything: a
	 *  discarded attempt's listeners must not fire into the retry that replaces
	 *  it. */
	discard(): void;
}

/**
 * One request's message state and the machine that grows it from claude's
 * events. The same machine serves a fresh spawn and an adopted parked child —
 * the difference is only where `proc` comes from and whether the child
 * survives the request.
 */
function createTurn(
	model: Model<Api>,
	stream: AssistantMessageEventStream,
	options: SimpleStreamOptions | undefined,
	proc: ChildProcess | null,
	session: Session | null,
	keepChildOnStop: boolean,
): Turn {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
	let started = false;
	let finished = false;
	let aborted = false;
	const push = (event: DistributiveOmit<AssistantMessageEvent, "partial">) => {
		stream.push({ ...event, partial: message } as AssistantMessageEvent);
	};
	const begin = () => {
		if (!started) { started = true; push({ type: "start" }); }
	};

	/** The last content block, opened on demand. Blocks grow through their
	 *  deltas and are closed when the turn finalizes, per the protocol. */
	let openTextIndex = -1;
	let openThinkingIndex = -1;
	const ensureBlock = (type: "text" | "thinking"): number => {
		begin();
		const open = type === "text" ? openTextIndex : openThinkingIndex;
		if (open !== -1) return open;
		message.content.push(type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
		const index = message.content.length - 1;
		if (type === "text") openTextIndex = index; else openThinkingIndex = index;
		push(type === "text" ? { type: "text_start", contentIndex: index } : { type: "thinking_start", contentIndex: index });
		return index;
	};
	/** Close an open block: the protocol's authoritative end, carrying the
	 *  accumulated content. Activities close eagerly — each is a complete
	 *  unit, and the answer must not stick to the back of one. */
	const closeBlock = (type: "text" | "thinking") => {
		const index = type === "text" ? openTextIndex : openThinkingIndex;
		if (index === -1) return;
		if (type === "text") { openTextIndex = -1; push({ type: "text_end", contentIndex: index, content: (message.content[index] as { text: string }).text }); }
		else { openThinkingIndex = -1; push({ type: "thinking_end", contentIndex: index, content: (message.content[index] as { thinking: string }).thinking }); }
	};

	const addText = (delta: string) => {
		const index = ensureBlock("text");
		(message.content[index] as { text: string }).text += delta;
		push({ type: "text_delta", contentIndex: index, delta });
	};
	const addThinking = (delta: string) => {
		const index = ensureBlock("thinking");
		(message.content[index] as { thinking: string }).thinking += delta;
		push({ type: "thinking_delta", contentIndex: index, delta });
	};
	/** One activity line, its own block, closed immediately. */
	const addActivity = (line: string) => {
		closeBlock("text");
		addText(`▸ ${line}\n`);
		closeBlock("text");
	};

	const onAbort = () => {
		aborted = true;
		try { proc?.kill("SIGTERM"); } catch { /* already gone */ }
		if (session && residentSessions.get(session.runDir) === session) residentSessions.delete(session.runDir);
	};
	const detachAbort = () => options?.signal?.removeEventListener("abort", onAbort);
	options?.signal?.addEventListener("abort", onAbort, { once: true });

	const endChild = () => {
		try { proc?.stdin?.end(); } catch { /* already gone */ }
		if (session) session.stdinClosed = true;
	};

	const finish = (reason: "stop" | "length" | "toolUse" | "deferred") => {
		if (finished) return;
		finished = true;
		detachAbort();
		// An ask keeps the child alive by definition; an adopted child keeps it
		// because the run is still going — only the pi child's exit ends it.
		const keepChild = !!session && (keepChildOnStop || reason === "toolUse");
		if (!keepChild) endChild();
		message.stopReason = reason;
		begin();
		closeBlock("text");
		closeBlock("thinking");
		push({ type: "done", reason, message });
	};
	const finishError = (errorMessage: string, reason: "aborted" | "error") => {
		if (finished) return;
		finished = true;
		detachAbort();
		endChild();
		message.stopReason = reason;
		message.errorMessage = errorMessage;
		push({ type: "error", reason, error: message });
	};

	return {
		message,
		stream,
		isFinished: () => finished,
		wasAborted: () => aborted,
		push,
		closeBlock,
		addText,
		addThinking,
		addActivity,
		finish,
		finishError,
		discard: detachAbort,
	};
}

/** Surface a `caller_ping` call as a real pi tool call: the one toolUse this
 *  provider lets pi execute, because the tool is the child pi's own. */
function surfaceAsk(turn: Turn, session: Session, block: any): void {
	turn.closeBlock("text");
	turn.closeBlock("thinking");
	const toolCall: ToolCall = {
		type: "toolCall",
		id: typeof block.id === "string" && block.id ? block.id : `ask_${Date.now()}`,
		name: ASK_PI_TOOL,
		arguments: (block.input ?? {}) as ToolCall["arguments"],
	};
	turn.message.content.push(toolCall);
	const contentIndex = turn.message.content.length - 1;
	turn.push({ type: "toolcall_start", contentIndex });
	turn.push({ type: "toolcall_end", contentIndex, toolCall });
	session.askToolCallId = toolCall.id;
	session.idle = false;
	// The tokens claude spent reaching the ask are re-accounted by the ask
	// turn's authoritative `result`, which replays into the continuation
	// request; zeroing here keeps the turn from being counted twice.
	turn.message.usage = zeroUsage();
	turn.finish("toolUse");
	if (session.sink === turn) session.sink = null;
}

/**
 * Route one parsed stream-json event into a turn.
 *
 * Shared by the fresh-spawn and adopted paths; the ask bridge's differences
 * all hang off `session` — null outside a run dir, where behavior is exactly
 * the stage-one one.
 */
function applyEvent(evt: any, turn: Turn, session: Session | null, config: ClaudeDriverConfig): void {
	// Live deltas, when the CLI was asked for partial messages. The complete
	// assistant messages that follow are then read only for their tool_use
	// blocks.
	if (evt.type === "stream_event" && evt.event) {
		const delta = evt.event.delta;
		if (delta?.type === "text_delta" && delta.text) turn.addText(delta.text);
		else if (delta?.type === "thinking_delta" && delta.thinking) turn.addThinking(delta.thinking);
		return;
	}

	if (evt.type === "assistant" && evt.message) {
		const u = evt.message.usage;
		if (u) {
			turn.message.usage.input += u.input_tokens || 0;
			turn.message.usage.output += u.output_tokens || 0;
			turn.message.usage.cacheRead += u.cache_read_input_tokens || 0;
			turn.message.usage.cacheWrite += u.cache_creation_input_tokens || 0;
			turn.message.usage.totalTokens = turn.message.usage.input + turn.message.usage.output + turn.message.usage.cacheRead + turn.message.usage.cacheWrite;
		}
		for (const block of evt.message.content ?? []) {
			if (block.type === "tool_use") {
				if (session && block.name === ASK_TOOL) {
					surfaceAsk(turn, session, block);
					continue;
				}
				const input = block.input ?? {};
				const preview = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query ?? "";
				turn.addActivity(`${block.name}${preview ? ` ${String(preview).slice(0, 120)}` : ""}`);
			} else if (!config.includePartialMessages && block.type === "text" && block.text) {
				turn.addText(block.text);
			} else if (!config.includePartialMessages && block.type === "thinking" && block.thinking) {
				turn.addThinking(block.thinking);
			}
		}
		return;
	}

	if (evt.type === "user" && evt.message) {
		for (const block of evt.message.content ?? []) {
			if (block.type === "tool_result") {
				// The ask's own tool result needs no activity line: pi already
				// holds its own record of the call it executed.
				if (session && block.tool_use_id && block.tool_use_id === session.askToolCallId) continue;
				// Claude Code's tool_result content is a string or a block array,
				// depending on the tool.
				const raw = block.content;
				const content = typeof raw === "string"
					? raw
					: Array.isArray(raw)
						? raw.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")
						: "";
				const head = String(content).slice(0, 80).replace(/\n/g, " ");
				// An empty result says nothing; a bare activity line for it would
				// only masquerade as the answer that follows.
				if (head.trim() || block.is_error) turn.addActivity(block.is_error ? `✗ ${head || "tool error"}` : head);
			}
		}
		return;
	}

	if (evt.type === "result") {
		// The result's usage is the turn's total — the authoritative figure,
		// replacing whatever the per-call assistant events accumulated.
		const u = evt.usage;
		if (u) {
			turn.message.usage.input = u.input_tokens || 0;
			turn.message.usage.output = u.output_tokens || 0;
			turn.message.usage.cacheRead = u.cache_read_input_tokens || 0;
			turn.message.usage.cacheWrite = u.cache_creation_input_tokens || 0;
			turn.message.usage.totalTokens = u.total_tokens
				|| turn.message.usage.input + turn.message.usage.output + turn.message.usage.cacheRead + turn.message.usage.cacheWrite;
		}
		if (typeof evt.total_cost_usd === "number") turn.message.usage.cost.total = evt.total_cost_usd;
		if (session) {
			// A completed turn leaves the child idle, waiting on stdin for the
			// next message — which may be the parent's answer, so it stays parked.
			session.idle = true;
			if (session.sink === turn) session.sink = null;
		}
		if (evt.is_error) {
			turn.finishError(describeResult(evt), "error");
		} else {
			turn.finish("stop");
		}
		return;
	}
}

/**
 * Adopt a resident child for an incoming request.
 *
 * The request is one of three things: the continuation pi's loop makes right
 * after executing its own `caller_ping` (its transcript ends with the matching
 * toolResult and carries no new message — the child is finishing its ask turn
 * on its own), a message meant for the child — the parent's answer to a
 * parked ask, a steered message, the next turn's prompt — arrived as a user
 * message, or a replay of events the child emitted before this request
 * attached. All three attach to the same process; only the message writes to
 * its stdin.
 */
function attachSession(
	session: Session,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	config: ClaudeDriverConfig,
	stream: AssistantMessageEventStream,
): void {
	const turn = createTurn(model, stream, options, session.proc, session, true);
	const last = context.messages.at(-1);
	let deliver: string | undefined;
	if (last?.role === "toolResult" && session.askToolCallId && last.toolCallId === session.askToolCallId) {
		// Continuation after pi's own caller_ping result: nothing to deliver,
		// the child drives its own closing turn.
	} else if (last?.role === "user") {
		const text = flattenText(last.content);
		if (text.trim()) deliver = text;
	}
	if (!deliver && session.idle && session.buffer.length === 0) {
		// An idle child streams nothing until its stdin gets a message; without
		// one this request could only hang.
		turn.finishError("the resident claude child is waiting for a message and this request carries none to deliver", "error");
		return;
	}
	// No payload hook on an adopted child: nothing travels to claude but the
	// answer text, and the transcript dump would mislead a hook into thinking
	// the child is being re-briefed from scratch.
	options?.onResponse?.({ status: 200, headers: {} }, model);
	session.sink = turn;
	const pending = session.buffer;
	session.buffer = [];
	for (const evt of pending) {
		if (turn.isFinished()) { session.buffer.push(evt); continue; }
		applyEvent(evt, turn, session, config);
	}
	if (deliver) {
		recordDelivery(session.runDir);
		try { session.proc.stdin?.write(userMessage(deliver)); } catch { /* the close lands as an error */ }
		session.idle = false;
	}
}

/**
 * Run one claude turn and push the events onto the stream.
 *
 * Text and thinking stream as they are written (`stream_event` deltas). The
 * complete assistant messages the CLI also emits are read only for their
 * `tool_use` blocks — in partial mode the deltas are the text, and reading
 * the message too would double every word.
 */
export function streamClaudeTurn(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	config: ClaudeDriverConfig,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		// Inside a subagent run, a resident child is the request's real backend:
		// the turn must reach the process that holds the conversation, not a
		// fresh one.
		const inRun = !!config.subagentRunDir;
		if (inRun) {
			const session = residentSessions.get(config.subagentRunDir!);
			if (session && adoptable(session)) {
				attachSession(session, model, context, options, config, stream);
				return;
			}
		}

		let proc: ChildProcess;
		let session: Session | null = null;
		let turn: Turn;
		try {
			const systemPrompt = getCurrentSystemPrompt(context.messages);
			const effort = resolveEffort(options?.reasoning);
			const fullPayload = serializeTranscript(context.messages);
			// Inside a run dir the child persists its conversation under a stable
			// id, recorded in the run dir: the first spawn names it, and a run
			// picked back up after a restart joins it instead of starting over.
			const recorded = inRun ? readSessionId(config.subagentRunDir!) : undefined;
			const resume = !!recorded;
			const sessionId = inRun ? recorded ?? crypto.randomUUID() : undefined;
			if (inRun && !recorded) writeSessionId(config.subagentRunDir!, sessionId!);
			// A resumed child already holds everything up to its persistence
			// boundary; only what it has yet to see travels. That is the trailing
			// user message when there is one, and the full transcript otherwise
			// (a tail the child cannot be summed up against).
			let payload = fullPayload;
			if (resume) {
				const last = context.messages.at(-1);
				const text = last?.role === "user" ? flattenText(last.content) : "";
				if (text.trim()) payload = text;
			}
			// The claude child is told none of the subagent plumbing:
			// PI_SUBAGENT_* would let its own descendants write into the run
			// dir. The ask server gets the run dir explicitly, via --mcp-config.
			let spawnOptions: Parameters<typeof spawn>[2] = { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] };
			if (inRun) {
				const env = { ...process.env };
				for (const key of Object.keys(env)) {
					if (key.startsWith("PI_SUBAGENT_")) delete env[key];
				}
				spawnOptions = { ...spawnOptions, env };
			}

			// A resume claude cannot join (its own store no longer has the
			// session) fails before reading anything; that attempt is discarded
			// and the turn retried once as a fresh conversation with the full
			// transcript — under a new id, so later pickups do not hit the same
			// wall. Retrying before the stream has carried anything keeps the
			// protocol intact: the model sees one turn, not an error then a turn.
			for (let attempt = 1; ; attempt++) {
				const useResume = resume && attempt === 1;
				const sessionIdNow = attempt === 1 ? sessionId! : crypto.randomUUID();
				if (attempt > 1 && resume) writeSessionId(config.subagentRunDir!, sessionIdNow);
				const attemptPayload = attempt === 1 ? payload : fullPayload;
				const argv = buildClaudeCodeArgs(model.id, effort, systemPrompt, config, sessionIdNow, useResume);
				// Request inspection, honored the way a custom stream must: the hook
				// sees what would be sent, and a replacement payload becomes the
				// message that actually travels.
				let finalPayload = attemptPayload;
				if (options?.onPayload) {
					const replacement = await options.onPayload(
						{ provider: "claude-code", model: model.id, cwd: process.cwd(), argv, message: attemptPayload },
						model,
					);
					if (typeof replacement === "string") finalPayload = replacement;
				}
				proc = spawn(config.command, argv, spawnOptions);
				// onResponse matches built-in providers' contract: after the response
				// exists, before its body is consumed. A subprocess has no HTTP
				// response to inspect, so the hook gets the synthetic 200.
				if (options?.onResponse) options.onResponse({ status: 200, headers: {} }, model);
				// Set before the probe so a failed-resume close never reaches the
				// live handlers below: the probe listener is attached first and flips
				// this flag synchronously during the same close event.
				let abandoned = false;
				if (useResume) proc.once("close", () => { abandoned = true; });
				proc.stdin?.on("error", () => {});
				// A resident child outlives the request that spawned it — a later
				// turn of the same run adopts it, and the provider process exiting
				// SIGTERMs whatever is still open.
				session = inRun ? new Session(proc, config.subagentRunDir!) : null;
				if (session) installExitHook();
				turn = createTurn(model, stream, options, proc, session, inRun);
				if (session) session.sink = turn;
				proc.stdin?.write(userMessage(finalPayload));

				let lineBuf = "";
				let stderrTail = "";
				proc.stdout?.on("data", (d: Buffer) => {
					lineBuf += d.toString();
					const lines = lineBuf.split("\n");
					lineBuf = lines.pop() || "";
					for (const line of lines) {
						if (!line.trim()) continue;
						let evt: any;
						try { evt = JSON.parse(line); } catch { continue; }
						const sink = session ? session.sink : turn;
						if (sink) applyEvent(evt, sink, session, config);
						else if (session) session.buffer.push(evt);
					}
				});

				proc.stderr?.on("data", (d: Buffer) => {
					const tail = ((session ? session.stderrTail : stderrTail) + d.toString()).slice(-2000);
					if (session) session.stderrTail = tail;
					else stderrTail = tail;
				});

				proc.on("error", (error) => {
					if (abandoned) return;
					if (session && residentSessions.get(session.runDir) === session) residentSessions.delete(session.runDir);
					if (!turn.isFinished()) turn.finishError(error.message, "error");
					turn.stream.end();
				});

				proc.on("close", (code) => {
					if (session) {
						session.exited = true;
						if (residentSessions.get(session.runDir) === session) residentSessions.delete(session.runDir);
					}
					if (abandoned) return;
					// An adopted request reads the child through the session; a
					// resident one (nobody attached) has no turn to fail.
					const live = session ? session.sink : turn;
					if (!live) return;
					if (!live.isFinished()) {
						if (live.wasAborted()) live.finishError("Aborted", "aborted");
						else {
							const stderr = (session ? session.stderrTail : stderrTail).trim().split("\n").at(-1);
							live.finishError(`Claude Code exited (code ${code}) before finishing${stderr ? `: ${stderr}` : ""}`, "error");
						}
					}
					live.stream.end();
				});

				if (!useResume) return;
				// The resume probe: a child that dies before speaking cannot join
				// its recorded session; anything else — a line of output, or a
				// quiet-but-alive startup past the probe window — is a live one.
				const died = new Promise<"exited">((resolve) => proc.once("close", () => resolve("exited")));
				const spoke = new Promise<"spoke">((resolve) => proc.stdout?.once("data", () => resolve("spoke")));
				const verdict = await Promise.race([
					died,
					spoke,
					new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), RESUME_PROBE_MS)),
				]);
				if (verdict !== "exited") return;
				if (turn.wasAborted()) {
					turn.finishError("Aborted", "aborted");
					turn.stream.end();
					return;
				}
				abandoned = true;
				turn.discard();
				// Fall through: attempt 2 spawns fresh, under a new id, with the
				// full transcript.
			}
		} catch (error) {
			const failed: AssistantMessage = {
				role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
				usage: zeroUsage(), stopReason: "error", timestamp: Date.now(),
				errorMessage: error instanceof Error ? error.message : String(error),
			};
			stream.push({ type: "error", reason: "error", error: failed } as AssistantMessageEvent);
			stream.end();
			return;
		}
	})();
	return stream;
}
