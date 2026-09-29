/**
 * Drive one turn of `claude -p` and adapt its stream onto pi's message-event
 * protocol.
 *
 * Each request to this provider is one conversation turn: the child is spawned
 * fresh, handed the serialized transcript as its only user message, and read
 * until its `result` event. Claude Code executes its own tools inside that
 * turn — the harness is the point of going through the CLI — and what comes
 * back is text.
 *
 * What is deliberately NOT mapped onto pi: tool calls. Emitting a toolCall
 * block would make pi execute it, and the tool it names belongs to Claude
 * Code, not to pi. Claude's tool activity travels as activity lines inside
 * the streamed text instead, so the pi TUI shows what the child is doing
 * without ever running a second copy of it.
 *
 * Compliance note: the binary is spawned unmodified, auth is its own, and
 * `-p` with stream-json is Claude Code's documented headless interface.
 */
import { spawn } from "node:child_process";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Model,
	SimpleStreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
// From the util subpaths rather than the compat barrel: an extension loaded by
// the host's module loader can have the barrel's circular internals snapshotted
// mid-evaluation, dropping re-exported names (observed: getCurrentSystemPrompt
// undefined in a child process). The leaf subpaths have no cycle to fall into.
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { serializeTranscript } from "./serialize.ts";

/** The standard built-in set a headless child is pre-approved to use. Read
 *  -only on purpose: a provider that writes and runs shell commands without
 *  pi's approval flow in the way is a decision for whoever sets this, not a
 *  default. CLAUDE_CODE_PROVIDER_TOOLS widens it. */
export const DEFAULT_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"];

export interface ClaudeDriverConfig {
	command: string;
	allowedTools: string[];
	/** Stream text as it is written, not turn by turn. Requires Claude Code's
	 *  `--include-partial-messages`; without it the child emits whole
	 *  assistant messages and the pi TUI sees the same content arrive later. */
	includePartialMessages: boolean;
	maxBudgetUsd?: number;
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
export function buildClaudeCodeArgs(model: string, effort: string | undefined, systemPrompt: string, config: ClaudeDriverConfig): string[] {
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
		"--allowedTools", ...(config.allowedTools.length > 0 ? config.allowedTools : [""]),
	];
	if (effort) args.push("--effort", effort);
	if (systemPrompt.trim()) args.push("--append-system-prompt", systemPrompt);
	if (config.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(config.maxBudgetUsd));
	return args;
}

function zeroUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function errorEvent(message: AssistantMessage, reason: "aborted" | "error"): AssistantMessageEvent {
	return { type: "error", reason, error: message };
}

/** What a failed `result` event says, in its own words when it has them. */
function describeResult(evt: any): string {
	if (typeof evt.result === "string" && evt.result.trim()) return evt.result.trim();
	if (evt.api_error_status) return `Claude Code API error ${evt.api_error_status}`;
	return `Claude Code ended with ${evt.subtype || "an error"}`;
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
): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	void (async () => {
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
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
		let started = false;
		const push = (event: DistributiveOmit<AssistantMessageEvent, "partial">) => {
			stream.push({ ...event, partial: message } as AssistantMessageEvent);
		};
		const begin = () => {
			if (!started) { started = true; push({ type: "start" }); }
		};

		/** The last content block, opened on demand. Blocks grow through their
		 *  deltas and are closed when the turn finalizes, per the protocol. */
		const ensureBlock = (type: "text" | "thinking"): number => {
			begin();
			const last = message.content.at(-1);
			if (last && last.type === type) return message.content.length - 1;
			message.content.push(type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
			const index = message.content.length - 1;
			push(type === "text" ? { type: "text_start", contentIndex: index } : { type: "thinking_start", contentIndex: index });
			return index;
		};

		// An activity line lands in the text block, visually separated.
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
		const addActivity = (line: string) => addText(`\n▸ ${line}`);

		let stderrTail = "";
		let exited = false;
		let aborted = false;

		let proc: ReturnType<typeof spawn>;
		try {
			const systemPrompt = getCurrentSystemPrompt(context.messages);
			const effort = resolveEffort(options?.reasoning);
			const argv = buildClaudeCodeArgs(model.id, effort, systemPrompt, config);
			const payload = serializeTranscript(context.messages);
			// Request inspection, honored the way a custom stream must: the hook
			// sees what would be sent, and a replacement payload becomes the
			// message that actually travels.
			let finalPayload = payload;
			if (options?.onPayload) {
				const replacement = await options.onPayload(
					{ provider: "claude-code", model: model.id, cwd: process.cwd(), argv, message: payload },
					model,
				);
				if (typeof replacement === "string") finalPayload = replacement;
			}
			proc = spawn(config.command, argv, { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
			// onResponse matches built-in providers' contract: after the
			// response exists, before its body is consumed. A subprocess has no
			// HTTP response to inspect, so the hook gets the synthetic 200.
			if (options?.onResponse) options.onResponse({ status: 200, headers: {} }, model);
			proc.stdin?.on("error", () => {});
			proc.stdin?.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: finalPayload }] } }) + "\n");
		} catch (error) {
			message.stopReason = "error";
			message.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push(errorEvent(message, "error"));
			stream.end();
			return;
		}

		const onAbort = () => {
			aborted = true;
			try { proc.kill("SIGTERM"); } catch { /* already gone */ }
		};
		options?.signal?.addEventListener("abort", onAbort, { once: true });

		let buf = "";
		let finished = false;
		/** Terminate the turn with an error: close the child's stdin, mark the
		 *  turn over, and land the error on the stream. Idempotent, like finish. */
		const finishError = (errorMessage: string, reason: "aborted" | "error") => {
			if (finished) return;
			finished = true;
			exited = true;
			options?.signal?.removeEventListener("abort", onAbort);
			try { proc.stdin?.end(); } catch { /* already gone */ }
			message.stopReason = reason;
			message.errorMessage = errorMessage;
			stream.push(errorEvent(message, reason));
		};
		const finish = (reason: "stop" | "length" | "toolUse" | "deferred") => {
			if (finished) return;
			finished = true;
			exited = true;
			message.stopReason = reason;
			options?.signal?.removeEventListener("abort", onAbort);
			try { proc.stdin?.end(); } catch { /* already gone */ }
			push({ type: "done", reason, message });
		};

		proc.stdout?.on("data", (d: Buffer) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let evt: any;
				try { evt = JSON.parse(line); } catch { continue; }

				// Live deltas, when the CLI was asked for partial messages. The
				// complete assistant messages that follow are then read only for
				// their tool_use blocks.
				if (evt.type === "stream_event" && evt.event) {
					const delta = evt.event.delta;
					if (delta?.type === "text_delta" && delta.text) addText(delta.text);
					else if (delta?.type === "thinking_delta" && delta.thinking) addThinking(delta.thinking);
					continue;
				}

				if (evt.type === "assistant" && evt.message) {
					const u = evt.message.usage;
					if (u) {
						message.usage.input += u.input_tokens || 0;
						message.usage.output += u.output_tokens || 0;
						message.usage.cacheRead += u.cache_read_input_tokens || 0;
						message.usage.cacheWrite += u.cache_creation_input_tokens || 0;
						message.usage.totalTokens = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
					}
					for (const block of evt.message.content ?? []) {
						if (block.type === "tool_use") {
							const input = block.input ?? {};
							const preview = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query ?? "";
							addActivity(`${block.name}${preview ? ` ${String(preview).slice(0, 120)}` : ""}`);
						} else if (!config.includePartialMessages && block.type === "text" && block.text) {
							addText(block.text);
						} else if (!config.includePartialMessages && block.type === "thinking" && block.thinking) {
							addThinking(block.thinking);
						}
					}
					continue;
				}

				if (evt.type === "user" && evt.message) {
					for (const block of evt.message.content ?? []) {
						if (block.type === "tool_result") {
							const content = Array.isArray(block.content)
								? block.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")
								: "";
							const status = block.is_error ? "error" : "done";
							const head = String(content).slice(0, 80).replace(/\n/g, " ");
							addActivity(status === "error" ? `✗ ${head || "tool error"}` : head);
						}
					}
					continue;
				}

				if (evt.type === "result") {
					// The result's usage is the turn's total — the authoritative
					// figure, replacing whatever the per-call assistant events
					// accumulated.
					const u = evt.usage;
					if (u) {
						message.usage.input = u.input_tokens || 0;
						message.usage.output = u.output_tokens || 0;
						message.usage.cacheRead = u.cache_read_input_tokens || 0;
						message.usage.cacheWrite = u.cache_creation_input_tokens || 0;
						message.usage.totalTokens = u.total_tokens
							|| message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
					}
					if (typeof evt.total_cost_usd === "number") message.usage.cost.total = evt.total_cost_usd;
					if (evt.is_error) {
						finishError(describeResult(evt), "error");
					} else {
						finish("stop");
					}
					return;
				}
			}
		});

		proc.stderr?.on("data", (d: Buffer) => {
			stderrTail = (stderrTail + d.toString()).slice(-2000);
		});

		proc.on("error", (error) => {
			finishError(error.message, "error");
			stream.end();
		});

		proc.on("close", (code) => {
			options?.signal?.removeEventListener("abort", onAbort);
			if (finished) { stream.end(); return; }
			exited = true;
			if (aborted) finishError("Aborted", "aborted");
			else {
				const stderr = stderrTail.trim().split("\n").at(-1);
				finishError(`Claude Code exited (code ${code}) before finishing${stderr ? `: ${stderr}` : ""}`, "error");
			}
			stream.end();
		});
	})();
	return stream;
}
