import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeContext, type Message, type TranscriptContext } from "@earendil-works/pi-ai/compat";
import { serializeTranscript, TRANSCRIPT_HEADER } from "../src/serialize.ts";
import { ASK_PI_TOOL, ASK_TOOL } from "../src/ask.ts";
import { buildClaudeCodeArgs, DEFAULT_TOOLS, residentSessions, resolveEffort, streamClaudeTurn, type ClaudeDriverConfig } from "../src/driver.ts";

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

// ── The ask bridge's argv ───────────────────────────────────────────

const BRIDGE_CONFIG: ClaudeDriverConfig = { ...CONFIG, subagentRunDir: "/run/dir", askServerPath: "/srv/ask.mjs" };

test("the ask bridge travels in argv only when run dir and server are both configured", () => {
	const args = buildClaudeCodeArgs("claude-sonnet-5", undefined, "", BRIDGE_CONFIG);
	const mcpIdx = args.indexOf("--mcp-config");
	assert.ok(mcpIdx !== -1, "the ask server is handed over via --mcp-config");
	const server = JSON.parse(args[mcpIdx + 1]).mcpServers.pi_subagents;
	assert.equal(server.command, process.execPath);
	assert.deepEqual(server.args, ["/srv/ask.mjs"]);
	assert.deepEqual(server.env, { PI_SUBAGENT_RUN_DIR: "/run/dir" });
	// The mangled MCP name is what claude pre-approves; it rides the same
	// variadic list as the built-ins.
	assert.equal(args[args.indexOf("--allowedTools") + 1 + DEFAULT_TOOLS.length], ASK_TOOL);

	// A run dir without a server is a bridge that is off, not a broken child.
	const degraded = buildClaudeCodeArgs("claude-sonnet-5", undefined, "", { ...CONFIG, subagentRunDir: "/run/dir" });
	assert.ok(!degraded.includes("--mcp-config"));
	assert.ok(!degraded.includes(ASK_TOOL));
	// And none of this appears outside a run dir.
	assert.ok(!CONFIG_ARGS.includes("--mcp-config"));
});
const CONFIG_ARGS = buildClaudeCodeArgs("claude-sonnet-5", "high", "be brief", CONFIG);

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

// ── The ask bridge, end to end ────────────────────────────────────────
//
// A stand-in for Claude Code that also fakes its half of the ask MCP
// handshake: it parses `--mcp-config`, spawns the REAL sibling ask server, and
// speaks JSON-RPC to it exactly as claude would — initialize, tools/list,
// tools/call. Its first turn asks one question; every later stdin message is
// the caller speaking, echoed back as a new turn. It logs its boot (once per
// process) and every stdin line, which is how the tests tell "the answer
// reached the parked child" from "a second child was spawned".

const FAKE_CLAUDE_ASK = `
import fs from "node:fs";
import { spawn } from "node:child_process";
const argv = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const appendLog = (o) => { if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(o) + "\\n"); };
const slow = process.env.FAKE_CLAUDE_SLOW === "1";
appendLog({ boot: true, argv, subagentEnv: process.env.PI_SUBAGENT_RUN_DIR ?? null });

const mcpIdx = argv.indexOf("--mcp-config");
if (mcpIdx === -1) {
  emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "ask fake spawned without --mcp-config" });
  process.exit(1);
}
const server = JSON.parse(argv[mcpIdx + 1]).mcpServers.pi_subagents;
const child = spawn(server.command, server.args, { env: Object.assign({}, process.env, server.env), stdio: ["pipe", "pipe", "pipe"] });
let mcpBuf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  mcpBuf += d;
  let i;
  while ((i = mcpBuf.indexOf("\\n")) !== -1) {
    const line = mcpBuf.slice(0, i);
    mcpBuf = mcpBuf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const waiter = pending.get(msg.id);
    if (waiter) { pending.delete(msg.id); waiter(msg); }
  }
});
let rpcId = 0;
const rpc = (method, params) => new Promise((resolve) => {
  const id = String(++rpcId);
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The handshake as Claude Code does it: initialize, initialized, tools/list.
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\\n");
const listed = await rpc("tools/list", {});
const toolName = listed.result.tools[0].name;
appendLog({ mcp: { tools: listed.result.tools.map((t) => t.name) } });

emit({ type: "system", subtype: "init", model: "claude-sonnet-5" });

let buf = "";
const queue = [];
let waiter;
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const text = msg.message && msg.message.content && msg.message.content[0] ? msg.message.content[0].text : "";
    appendLog({ stdin: text });
    if (waiter) { const w = waiter; waiter = undefined; w(text); } else queue.push(text);
  }
});
process.stdin.on("end", () => process.exit(0));
const nextMessage = () => new Promise((r) => { if (queue.length) r(queue.shift()); else waiter = r; });
const QUESTION = "Which auth module should I map first?";

// Turn one: preamble, the ask, the MCP round trip, then the closing turn.
await nextMessage();
emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Checking with my caller. " } } });
emit({ type: "assistant", message: { role: "assistant", content: [
  { type: "tool_use", id: "ask1", name: "mcp__pi_subagents__" + toolName, input: { question: QUESTION } },
] } });
const call = await rpc("tools/call", { name: toolName, arguments: { question: QUESTION } });
const resultText = call.result.content.map((c) => c.text).join(" ");
emit({ type: "user", message: { role: "user", content: [
  { type: "tool_result", tool_use_id: "ask1", content: [{ type: "text", text: resultText }], is_error: !!call.result.isError },
] } });
const closing = "Asked my caller and will wait for the answer.";
if (slow) {
  await sleep(150);
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: closing } } });
  await sleep(150);
} else {
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: closing } } });
}
emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: closing }] } });
emit({ type: "result", subtype: "success", is_error: false, result: closing,
  usage: { input_tokens: 150, output_tokens: 25, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
  total_cost_usd: 0.02, num_turns: 2 });

// Every later stdin message is the caller speaking; echo it and keep the
// floor — the parked child never exits until its stdin closes.
for (;;) {
  const message = await nextMessage();
  const reply = "Answered: " + message;
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: reply } } });
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: reply,
    usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 },
    total_cost_usd: 0.03, num_turns: 3 });
}
`;

const ASK_SERVER_PATH = fileURLToPath(new URL("../../pi-subagents-herdr/runners/claude-ask.mjs", import.meta.url));
const askBridgeTest = fs.existsSync(ASK_SERVER_PATH) ? test : test.skip;

function contextWith(messages: Message[]): TranscriptContext {
	return normalizeContext({ systemPrompt: "be brief", tools: [], messages });
}

const ASK_TURN: Message[] = [
	{ role: "user", content: "map auth", timestamp: 1 } as Message,
	{ role: "assistant", api: "test", provider: "test", model: "m", usage: zeroUsage(), stopReason: "toolUse", timestamp: 2,
		content: [{ type: "toolCall", id: "ask1", name: ASK_PI_TOOL, arguments: { question: "Which auth module should I map first?" } }] },
	{ role: "toolResult", toolCallId: "ask1", toolName: ASK_PI_TOOL, isError: false,
		content: [{ type: "text", text: "Question sent to your caller. Stop now: end your turn without calling another tool and without assuming an answer." }], timestamp: 3 },
];

const ANSWER = "Your caller answered: map src/auth.ts first.\n\nCarry on from where you stopped.";

const textOf = (message: any) => message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for a condition");
		await new Promise((r) => setTimeout(r, 25));
	}
}

test("outside a run dir a caller_ping call is an activity line like any other claude tool", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-noask-test-"));
	const claude = stubClaude(directory, `
import fs from "node:fs";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (c) => {
  buf += c;
  if (!buf.includes("\\n")) return;
  if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
  emit({ type: "system", subtype: "init", model: "claude-sonnet-5" });
  emit({ type: "assistant", message: { role: "assistant", content: [
    { type: "tool_use", id: "ask1", name: "mcp__pi_subagents__caller_ping", input: { question: "Which one?" } },
  ] } });
  emit({ type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "ask1", content: [{ type: "text", text: "Question sent to your caller." }], is_error: false },
  ] } });
  emit({ type: "result", subtype: "success", is_error: false, result: "Done", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 });
});
`);
	try {
		const events = await collect(streamClaudeTurn(MODEL, userContext("go"), undefined, CONFIG));
		const done = events.at(-1);
		assert.equal(done.reason, "stop");
		assert.ok(!claude.calls()[0].argv.includes("--mcp-config"), "no ask server outside a subagent");
		const text = textOf(done.message);
		assert.ok(text.includes("▸ mcp__pi_subagents__caller_ping"), "the ask is just another activity line here");
		assert.deepEqual(done.message.content.filter((c: any) => c.type === "toolCall"), [], "and it is not a pi tool call");
	} finally {
		claude.restore();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

askBridgeTest("inside a subagent run an ask is a real tool call, the child parks, and the answer completes it", async () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "provider-ask-test-"));
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-ask-run-"));
	const claude = stubClaude(scratch, FAKE_CLAUDE_ASK);
	const config = { ...CONFIG, subagentRunDir: runDir, askServerPath: ASK_SERVER_PATH };
	try {
		// Request 1: claude asks; the driver surfaces the ask and parks the child.
		const r1 = await collect(streamClaudeTurn(MODEL, userContext("map auth"), undefined, config));
		const done1 = r1.at(-1);
		assert.equal(done1.type, "done");
		assert.equal(done1.reason, "toolUse", "the ask ends the request the way a tool call does");
		assert.equal(done1.message.stopReason, "toolUse");
		const ask = done1.message.content.find((c: any) => c.type === "toolCall");
		assert.ok(ask, "the ask travels as a pi tool call");
		assert.equal(ask.id, "ask1", "claude's own tool_use id, so pi's tool result matches");
		assert.equal(ask.name, "caller_ping", "pi's tool name, not the mangled MCP one");
		assert.equal(ask.arguments.question, "Which auth module should I map first?");
		assert.equal(done1.message.usage.totalTokens, 0, "the ask turn's tokens are accounted when its result replays");
		assert.ok(!textOf(done1.message).includes("Question sent"), "the ask's own tool result is not double-recorded");

		const parked = residentSessions.get(runDir);
		assert.ok(parked, "the asking child is parked");
		assert.equal(parked!.proc.exitCode, null, "still alive, holding its context");

		// The spawn config: the ask server and its pre-approval, and none of the
		// subagent plumbing leaking into the claude child's env.
		const call1 = claude.calls()[0];
		const mcpIdx = call1.argv.indexOf("--mcp-config");
		const server = JSON.parse(call1.argv[mcpIdx + 1]).mcpServers.pi_subagents;
		assert.equal(server.env.PI_SUBAGENT_RUN_DIR, runDir, "the ask server points at the run dir");
		assert.ok(call1.argv.includes(ASK_TOOL), "the ask tool is pre-approved");
		assert.equal(call1.subagentEnv, null, "PI_SUBAGENT_* is scrubbed from the claude child's env");

		// Request 2: pi executed caller_ping; the continuation adopts the parked
		// child and lets its closing turn replay into this request.
		const r2 = await collect(streamClaudeTurn(MODEL, contextWith(ASK_TURN), undefined, config));
		const done2 = r2.at(-1);
		assert.equal(done2.type, "done");
		assert.equal(done2.reason, "stop");
		assert.ok(textOf(done2.message).includes("Asked my caller and will wait for the answer."));
		assert.deepEqual(done2.message.usage, {
			input: 150, output: 25, cacheRead: 5, cacheWrite: 0, totalTokens: 180,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
		}, "the ask turn's result usage is authoritative for the continuation");
		assert.equal(residentSessions.get(runDir), parked, "the same child is still parked");
		assert.equal(parked!.proc.exitCode, null, "the child survives the continuation: the answer is still coming");

		// Request 3: the parent's answer arrives as a user message; the driver
		// routes it into the parked child's stdin.
		const r3 = await collect(streamClaudeTurn(MODEL, contextWith([
			...ASK_TURN,
			{ role: "user", content: ANSWER, timestamp: 4 } as Message,
		]), undefined, config));
		const done3 = r3.at(-1);
		assert.equal(done3.type, "done");
		assert.equal(done3.reason, "stop");
		assert.ok(textOf(done3.message).includes("Answered: Your caller answered: map src/auth.ts first."), `got: ${JSON.stringify(textOf(done3.message))}`);
		assert.deepEqual(done3.message.usage, {
			input: 300, output: 40, cacheRead: 10, cacheWrite: 0, totalTokens: 350,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		});

		// One claude process served all three turns: the answer reached the
		// process that asked, not a fresh spawn.
		assert.equal(claude.calls().filter((c: any) => c.boot).length, 1);
		assert.ok(claude.calls().some((c: any) => c.stdin === ANSWER), "the parked child received the answer over stdin");

		// The delivery is recorded for the ask server's one-question bookkeeping.
		const answers = fs.readFileSync(path.join(runDir, "answers.jsonl"), "utf-8").trim().split("\n").filter(Boolean);
		assert.ok(answers.length >= 1, "the delivery marker was appended to answers.jsonl");
	} finally {
		for (const session of [...residentSessions.values()]) { try { session.proc.kill("SIGTERM"); } catch { /* already gone */ } }
		residentSessions.clear();
		claude.restore();
		fs.rmSync(scratch, { recursive: true, force: true });
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});

askBridgeTest("an abort during an attached turn kills the parked child and clears the park", async () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "provider-ask-abort-test-"));
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-ask-abort-run-"));
	const oldSlow = process.env.FAKE_CLAUDE_SLOW;
	process.env.FAKE_CLAUDE_SLOW = "1";
	const claude = stubClaude(scratch, FAKE_CLAUDE_ASK);
	const config = { ...CONFIG, subagentRunDir: runDir, askServerPath: ASK_SERVER_PATH };
	try {
		const r1 = await collect(streamClaudeTurn(MODEL, userContext("map auth"), undefined, config));
		assert.equal(r1.at(-1).reason, "toolUse");
		assert.ok(residentSessions.has(runDir));

		const control = new AbortController();
		const stream2 = streamClaudeTurn(MODEL, contextWith(ASK_TURN), { signal: control.signal } as any, config);
		const collected = collect(stream2);
		await new Promise((r) => setTimeout(r, 120));
		control.abort();
		const events = await collected;
		assert.equal(events.at(-1).type, "error");
		assert.equal(events.at(-1).reason, "aborted");
		await waitUntil(() => !residentSessions.has(runDir), 2000);
	} finally {
		for (const session of [...residentSessions.values()]) { try { session.proc.kill("SIGTERM"); } catch { /* already gone */ } }
		residentSessions.clear();
		if (oldSlow === undefined) delete process.env.FAKE_CLAUDE_SLOW; else process.env.FAKE_CLAUDE_SLOW = oldSlow;
		claude.restore();
		fs.rmSync(scratch, { recursive: true, force: true });
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});

// ── Residency: one claude process per run ─────────────────────────────
//
// Inside a run dir the child stays resident after its request settles and
// every later request of the run adopts it, delivering only what it has yet
// to see.

const FAKE_CLAUDE_ECHO = `
import fs from "node:fs";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const appendLog = (o) => { if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(o) + "\\n"); };
appendLog({ boot: true, argv: process.argv.slice(2) });
emit({ type: "system", subtype: "init", model: "claude-sonnet-5" });
let buf = "";
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const text = JSON.parse(line).message.content[0].text;
    appendLog({ stdin: text });
    const reply = "Echo: " + text;
    emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: reply } } });
    emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } });
    emit({ type: "result", subtype: "success", is_error: false, result: reply,
      usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 });
  }
});
`;

const RUN_CONFIG = { ...CONFIG, subagentRunDir: "/run/dir" };

function runDirConfig(runDir: string) {
	return { ...CONFIG, subagentRunDir: runDir };
}

const sessionIdOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

test("inside a run dir the child is resident: later turns adopt it and carry only the new message", async () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "provider-resident-test-"));
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-resident-run-"));
	const claude = stubClaude(scratch, FAKE_CLAUDE_ECHO);
	const config = runDirConfig(runDir);
	try {
		// Turn one: a full run, answered with no ask. The child stays.
		const r1 = await collect(streamClaudeTurn(MODEL, userContext("map auth"), undefined, config));
		assert.equal(r1.at(-1).reason, "stop");
		const resident = residentSessions.get(runDir);
		assert.ok(resident, "the child is resident after a plain completed turn");
		assert.equal(resident!.proc.exitCode, null, "still alive, holding its context");

		// Turn two: pi's transcript grew by one user message. The same process
		// serves it, and only that message reaches its stdin.
		const r2 = await collect(streamClaudeTurn(MODEL, contextWith([
			{ role: "user", content: "map auth", timestamp: 1 } as Message,
			{ role: "assistant", api: "test", provider: "test", model: "m", usage: zeroUsage(), stopReason: "stop", timestamp: 2,
				content: [{ type: "text", text: "Mapped." }] },
			{ role: "user", content: "now the login flow", timestamp: 3 } as Message,
		]), undefined, config));
		assert.equal(r2.at(-1).reason, "stop");
		assert.ok(textOf(r2.at(-1).message).includes("Echo: now the login flow"));

		assert.equal(claude.calls().filter((c: any) => c.boot).length, 1, "one claude process served the whole run");
		const stdinLines = claude.calls().filter((c: any) => c.stdin !== undefined).map((c: any) => c.stdin);
		assert.match(stdinLines[0], /\[user\]: map auth/, "the first spawn carries the transcript");
		assert.equal(stdinLines[1], "now the login flow", "later turns carry only the new message");

		// The first spawn named its session; the id is on file for a restart.
		const boot1 = claude.calls()[0];
		const recorded = fs.readFileSync(path.join(runDir, "claude-session-id"), "utf8").trim();
		assert.equal(sessionIdOf(boot1.argv, "--session-id"), recorded, "the recorded id is the one the child was given");
	} finally {
		for (const session of [...residentSessions.values()]) { try { session.proc.kill("SIGTERM"); } catch { /* already gone */ } }
		residentSessions.clear();
		claude.restore();
		fs.rmSync(scratch, { recursive: true, force: true });
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});

test("a run picked back up after a restart joins the recorded session with only the new message", async () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "provider-resume-test-"));
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-resume-run-"));
	fs.writeFileSync(path.join(runDir, "claude-session-id"), "0f0e0d0c-0b0a-4948-8476-554433221100\n", { mode: 0o600 });
	const claude = stubClaude(scratch, FAKE_CLAUDE_ECHO);
	try {
		const events = await collect(streamClaudeTurn(MODEL, userContext("carry on from here"), undefined, runDirConfig(runDir)));
		assert.equal(events.at(-1).reason, "stop");
		const call = claude.calls()[0];
		assert.deepEqual(sessionIdOf(call.argv, "--resume"), "0f0e0d0c-0b0a-4948-8476-554433221100", "the recorded session is joined, not restarted");
		assert.ok(!call.argv.includes("--session-id"));
		const stdin = claude.calls().find((c: any) => c.stdin !== undefined);
		assert.equal(stdin!.stdin, "carry on from here", "only the message the child has yet to see travels");
	} finally {
		for (const session of [...residentSessions.values()]) { try { session.proc.kill("SIGTERM"); } catch { /* already gone */ } }
		residentSessions.clear();
		claude.restore();
		fs.rmSync(scratch, { recursive: true, force: true });
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});

test("a resume the claude store cannot join falls back to a fresh conversation with the full transcript", async () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "provider-resume-fail-test-"));
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-resume-fail-run-"));
	fs.writeFileSync(path.join(runDir, "claude-session-id"), "deadbeef-0000-4000-8000-000000000000\n", { mode: 0o600 });
	const claude = stubClaude(scratch, `
if (process.argv.slice(2).includes("--resume")) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ boot: true, argv: process.argv.slice(2), resumeFail: true }) + "\\n");
  process.exit(1);
}
${FAKE_CLAUDE_ECHO}`);
	try {
		const events = await collect(streamClaudeTurn(MODEL, userContext("carry on from here"), undefined, runDirConfig(runDir)));
		const done = events.at(-1);
		assert.equal(done.type, "done", "the model saw one clean turn, not a resume error");
		assert.equal(done.reason, "stop");
		assert.ok(textOf(done.message).includes("[user]: carry on from here"), "the echo proves the full transcript traveled");

		const boots = claude.calls().filter((c: any) => c.boot);
		console.log("DBG21", JSON.stringify(claude.calls(), null, 0));
		assert.equal(boots.length, 2, "one failed join, one fresh conversation");
		assert.ok(boots[0].resumeFail && boots[0].argv.includes("--resume"));
		const secondId = sessionIdOf(boots[1].argv, "--session-id");
		assert.ok(secondId && secondId !== "deadbeef-0000-4000-8000-000000000000", "the retry named a new session");
		assert.equal(fs.readFileSync(path.join(runDir, "claude-session-id"), "utf8").trim(), secondId, "the record now points at the session that exists");
		const stdin = claude.calls().find((c: any) => c.stdin !== undefined);
		assert.match(stdin!.stdin, /\[user\]: carry on from here/, "the fresh conversation carries the full transcript");
	} finally {
		for (const session of [...residentSessions.values()]) { try { session.proc.kill("SIGTERM"); } catch { /* already gone */ } }
		residentSessions.clear();
		claude.restore();
		fs.rmSync(scratch, { recursive: true, force: true });
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});

test("outside a run dir the child is fresh per request and no session id is named", async () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "provider-fresh-test-"));
	const claude = stubClaude(scratch, FAKE_CLAUDE_ECHO);
	try {
		await collect(streamClaudeTurn(MODEL, userContext("first"), undefined, CONFIG));
		await collect(streamClaudeTurn(MODEL, userContext("second"), undefined, CONFIG));
		const boots = claude.calls().filter((c: any) => c.boot);
		assert.equal(boots.length, 2, "two requests, two children");
		assert.ok(boots.every((c: any) => !c.argv.includes("--session-id") && !c.argv.includes("--resume")));
		assert.ok(!residentSessions.size, "nothing is parked outside a run");
	} finally {
		claude.restore();
		fs.rmSync(scratch, { recursive: true, force: true });
	}
});
