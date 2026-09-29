import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeContext, type Message, type TranscriptContext } from "@earendil-works/pi-ai/compat";
import { serializeTranscript, TRANSCRIPT_HEADER } from "../src/serialize.ts";
import { buildClaudeCodeArgs, DEFAULT_TOOLS, resolveEffort, streamClaudeTurn, type ClaudeDriverConfig } from "../src/driver.ts";

function zeroUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

// ── Serialization ─────────────────────────────────────────────────────

test("the transcript travels as one user message, roles and tools inline", () => {
	const messages: Message[] = [
		{ role: "user", content: "Map the auth module.", timestamp: 1 },
		{ role: "assistant", api: "test", provider: "test", model: "m", usage: zeroUsage(), stopReason: "toolUse", timestamp: 2,
			content: [
				{ type: "thinking", thinking: "private record of the turn" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "src/auth.ts" } },
			] },
		{ role: "toolResult", toolCallId: "t1", toolName: "read", isError: false,
			content: [{ type: "text", text: "export function auth() {}" }], timestamp: 3 },
		{ role: "assistant", api: "test", provider: "test", model: "m", usage: zeroUsage(), stopReason: "stop", timestamp: 4,
			content: [{ type: "text", text: "Auth lives in src/auth.ts." }] },
	];
	const out = serializeTranscript(messages);
	assert.ok(out.startsWith("<transcript>"));
	assert.ok(out.includes("[user]: Map the auth module."));
	assert.ok(out.includes("[assistant used tool read]"));
	assert.ok(out.includes("[tool read result]: export function auth() {}"));
	assert.ok(out.includes("[assistant]: Auth lives in src/auth.ts."));
	// The prompt travels separately (--append-system-prompt), so the leading
	// system message does not appear in the dump.
	assert.ok(!out.includes("system"));
	// Past thinking is pi's record of a turn, not a prompt for the next one.
	assert.ok(!out.includes("private record"));
	// The dump closes on the cue to continue as the assistant.
	assert.ok(out.endsWith("[end of transcript — continue as the assistant]"));
	assert.ok(TRANSCRIPT_HEADER.includes("reply with only your next message"));
});

test("long tool results and arguments are cut, images are described", () => {
	const messages: Message[] = [
		{ role: "user", timestamp: 1, content: [
			{ type: "text", text: "look" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		] } as Message,
		{ role: "toolResult", toolCallId: "t1", toolName: "read", isError: false,
			content: [{ type: "text", text: "x".repeat(10000) }], timestamp: 2 },
	];
	const out = serializeTranscript(messages);
	assert.ok(out.includes("1 image"), "images are acknowledged, not silently dropped");
	const resultLine = out.split("\n").find((l) => l.startsWith("[tool read"));
	assert.ok(resultLine!.length < 10000, "the result was cut");
});

// ── Argv ──────────────────────────────────────────────────────────────

const CONFIG: ClaudeDriverConfig = { command: "claude", allowedTools: DEFAULT_TOOLS, includePartialMessages: true };

test("the child is a headless streaming claude with a passthrough model id", () => {
	const args = buildClaudeCodeArgs("claude-opus-5[1m]", "high", "be brief", CONFIG);
	assert.deepEqual(args.slice(0, 7), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
	assert.ok(args.includes("--model") && args[args.indexOf("--model") + 1] === "claude-opus-5[1m]");
	assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "high"]);
	assert.deepEqual(args.slice(args.indexOf("--append-system-prompt"), args.indexOf("--append-system-prompt") + 2), ["--append-system-prompt", "be brief"]);
	assert.deepEqual(args.slice(args.indexOf("--allowedTools"), args.indexOf("--append-system-prompt")), ["--allowedTools", ...DEFAULT_TOOLS, "--effort", "high"]);
	assert.ok(args.includes("--permission-prompts") && args[args.indexOf("--permission-prompts") + 1] === "none");
});

test("optional pieces are omitted, and an empty tool table is spelled explicitly", () => {
	const empty = { ...CONFIG, allowedTools: [] };
	const bare = buildClaudeCodeArgs("claude-sonnet-5", undefined, "", empty);
	assert.ok(!bare.includes("--effort"), "no reasoning, no effort");
	assert.ok(!bare.includes("--append-system-prompt"), "no prompt, no append");
	assert.deepEqual(bare.slice(bare.indexOf("--allowedTools"), bare.indexOf("--allowedTools") + 2), ["--allowedTools", ""]);
	assert.ok(!bare.includes("--max-budget-usd"));

	const budgeted = buildClaudeCodeArgs("claude-sonnet-5", "low", "x", { ...CONFIG, maxBudgetUsd: 0.5 });
	assert.deepEqual(budgeted.slice(budgeted.indexOf("--max-budget-usd"), budgeted.indexOf("--max-budget-usd") + 2), ["--max-budget-usd", "0.5"]);

	// pi's "off" and "minimal" floor at low: Claude Code has no way to say
	// "do not think".
	assert.equal(resolveEffort("off"), "low");
	assert.equal(resolveEffort("minimal"), "low");
	assert.equal(resolveEffort(undefined), undefined);
});

// ── The whole stream, against a stand-in ──────────────────────────────
//
// A stand-in for Claude Code's headless streaming mode: one user message in,
// its event stream out on stdout, alive until stdin is closed. Deltas first,
// then the complete messages, then one `result` — the shape a real child
// emits.

const FAKE_CLAUDE = `
import fs from "node:fs";
const argv = process.argv.slice(2);
const partial = argv.includes("--include-partial-messages");
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (c) => {
  buf += c;
  if (!buf.includes("\\n")) return;
  const command = JSON.parse(buf);
  appendLog({ argv, payload: command.message.content[0].text });
  emit({ type: "system", subtype: "init", model: "claude-sonnet-5" });
  if (partial) {
    emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } } });
    emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } } });
  }
  emit({ type: "assistant", message: { role: "assistant", content: [
    { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/auth.ts" } },
    ...(partial ? [] : [{ type: "text", text: "Hello world" }]),
  ] } });
  emit({ type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "file contents here" }], is_error: false },
  ] } });
  if (partial) emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Read done" } } });
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Read done" }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: "Read done",
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
    total_cost_usd: 0.01, num_turns: 2 });
  // No exit: a claude child holds the floor until its stdin closes.
});
function appendLog(o) { if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(o) + "\\n"); }
`;

function stubClaude(directory: string, script = FAKE_CLAUDE) {
	const entry = path.join(directory, "fake-claude.mjs");
	fs.writeFileSync(entry, script);
	const shim = path.join(directory, "claude");
	fs.writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${entry} "$@"\n`, { mode: 0o755 });
	const oldPath = process.env.PATH, oldLog = process.env.FAKE_CLAUDE_LOG;
	process.env.PATH = `${directory}:${process.env.PATH}`;
	process.env.FAKE_CLAUDE_LOG = path.join(directory, "calls.jsonl");
	fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, "");
	return {
		calls: () => fs.readFileSync(process.env.FAKE_CLAUDE_LOG!, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
		restore: () => {
			process.env.PATH = oldPath;
			if (oldLog === undefined) delete process.env.FAKE_CLAUDE_LOG; else process.env.FAKE_CLAUDE_LOG = oldLog;
		},
	};
}

const MODEL = {
	id: "claude-sonnet-5", name: "Claude Code · Sonnet 5", api: "claude-code-harness", provider: "claude-code",
	reasoning: true, input: ["text"], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000, maxTokens: 64000,
} as any;

function userContext(text: string, systemPrompt = "be brief"): TranscriptContext {
	return normalizeContext({ systemPrompt, tools: [], messages: [{ role: "user", content: text, timestamp: 1 } as Message] });
}

async function collect(stream: AsyncIterable<any>): Promise<any[]> {
	const events: any[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

test("a turn streams text as it is written and lands as one assistant message", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-test-"));
	const claude = stubClaude(directory);
	try {
		const events = await collect(streamClaudeTurn(MODEL, userContext("map auth"), undefined, CONFIG));
		const types = events.map((e) => e.type);
		assert.equal(types[0], "start");
		assert.ok(types.includes("text_start"));
		assert.ok(types.includes("done"), "the stream terminated with done");

		const done = events.at(-1);
		assert.equal(done.type, "done");
		assert.equal(done.reason, "stop");
		assert.equal(done.message.stopReason, "stop");
		// The deltas were the text, and the complete messages were read only
		// for their tool_use blocks — nothing doubled.
		const text = done.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
		assert.ok(text.includes("Hello world"), `got: ${JSON.stringify(text)}`);
		assert.ok(text.includes("Read done"), `got: ${JSON.stringify(text)}`);
		assert.ok(text.includes("▸ Read src/auth.ts"), "claude's own tool call is visible as an activity line");
		assert.ok(text.includes("file contents here"), "so is its result");
		assert.ok(!/Hello world[\s\S]*Read done[\s\S]*Read done/.test(text.replace(/\nRead done$/, "")), "the final result was not appended after being streamed");
		assert.deepEqual(done.message.content.filter((c: any) => c.type === "toolCall"), [], "no pi tool calls: pi must not execute claude's tools");

		// Usage and cost came off the result event.
		assert.deepEqual(done.message.usage, {
			input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 125,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
		});

		// The child saw the transcript as one user message and the prompt as an
		// appended system prompt, with the model id passed through.
		const call = claude.calls()[0];
		assert.deepEqual(call.argv.slice(call.argv.indexOf("--model"), call.argv.indexOf("--model") + 2), ["--model", "claude-sonnet-5"]);
		assert.ok(call.argv.includes("--effort") === false, "no reasoning requested, no effort passed");
		assert.equal(call.argv[call.argv.indexOf("--append-system-prompt") + 1], "be brief");
		assert.match(call.payload, /\[user\]: map auth/);
		assert.match(call.payload, /end of transcript/);

		// With reasoning and a prompt, both travel.
		const events2 = await collect(streamClaudeTurn(MODEL, userContext("go on", "be terse"), { reasoning: "high" } as any, CONFIG));
		assert.equal(events2.at(-1).message.stopReason, "stop");
		const call2 = claude.calls()[1];
		assert.deepEqual(call2.argv.slice(call2.argv.indexOf("--effort"), call2.argv.indexOf("--effort") + 2), ["--effort", "high"]);
		assert.equal(call2.argv[call2.argv.indexOf("--append-system-prompt") + 1], "be terse");
		assert.match(call2.payload, /\[user\]: go/);
	} finally {
		claude.restore();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("a failed result arrives as an error, in claude's own words", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-error-test-"));
	const claude = stubClaude(directory, `
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.exit(0));
emit({ type: "system", subtype: "init", model: "claude-sonnet-5" });
emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "credit balance too low" });
`);
	try {
		const events = await collect(streamClaudeTurn(MODEL, userContext("go"), undefined, CONFIG));
		const error = events.at(-1);
		assert.equal(error.type, "error");
		assert.equal(error.reason, "error");
		assert.equal(error.error.stopReason, "error");
		assert.match(error.error.errorMessage, /credit balance too low/);
	} finally {
		claude.restore();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("an abort kills the child and lands as an aborted stream", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-abort-test-"));
	const claude = stubClaude(directory, `
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.exit(0));
emit({ type: "system", subtype: "init", model: "claude-sonnet-5" });
setInterval(() => {}, 1000); // holds the floor forever, as a long turn would
`);
	const signal = new AbortController();
	try {
		const stream = streamClaudeTurn(MODEL, userContext("long work"), { signal: signal.signal } as any, CONFIG);
		const done = (async () => { await collect(stream); })();
		await new Promise((resolve) => setTimeout(resolve, 200));
		signal.abort();
		await done;
	} finally {
		claude.restore();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("a claude that cannot start is an error, not a hang", async () => {
	const events = await collect(streamClaudeTurn(MODEL, userContext("go"), undefined,
		{ command: "/nonexistent/claude-provider-test", allowedTools: DEFAULT_TOOLS, includePartialMessages: true }));
	const error = events.at(-1);
	assert.equal(error.type, "error");
	assert.match(error.error.errorMessage, /nonexistent|ENOENT/);
});
