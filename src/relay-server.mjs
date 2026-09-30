/**
 * pi tool relay for a Claude Code child, as a stdio MCP server.
 *
 * Where the ask server carries one hand-written tool, this one serves whatever
 * the child pi has active: the driver publishes the catalog to
 * `<runDir>/relay-tools.json` before spawning claude, and surfaces each
 * `mcp__pi_relay__<tool>` call as a real pi tool call that pi executes itself.
 * All this process does is describe those tools, and hold claude's
 * `tools/call` open until the executed result lands.
 *
 * The handoff is files in the run dir, keyed by content rather than by id —
 * the server knows only the MCP (tool, arguments) of the call it is holding,
 * and the driver knows only the tool_use id of the block it surfaced. Both
 * sides hash (tool, arguments) to the same key; a result file whose key
 * matches is claimed by atomic rename. Two parallel calls of the same tool
 * with the same arguments hash equal and are interchangeable — same call,
 * same result.
 *
 * `canonicalCallKey` lives in `relay.ts` too; the two copies must change
 * together.
 *
 * Spawned by `claude`, so: plain Node, no build step, no dependencies.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const runDir = process.env.PI_SUBAGENT_RUN_DIR;
const catalogPath = runDir ? path.join(runDir, "relay-tools.json") : undefined;
const resultDir = runDir ? path.join(runDir, "relay-res") : undefined;

/** How often the pending-call loop re-scans the result directory. A result
 *  written the instant before a scan is picked up within one interval; the
 *  tool executions this relays take seconds at least, so 100ms costs nothing
 *  and keeps the wait off any reasonable result's critical path. */
const POLL_MS = 100;

function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value).sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function callKey(tool, args) {
	return createHash("sha256").update(canonical({ tool, args })).digest("hex");
}

function catalog() {
	if (!catalogPath) return [];
	try {
		const tools = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
		return Array.isArray(tools) ? tools : [];
	} catch {
		return [];
	}
}

/** Claim the result file matching this call, or undefined while none has
 *  landed yet. The rename is the claim: two waiters can read the same file,
 *  but only one rename succeeds. */
function claim(tool, args) {
	if (!resultDir) return undefined;
	const key = callKey(tool, args);
	let entries;
	try {
		entries = fs.readdirSync(resultDir);
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".res")) continue;
		const file = path.join(resultDir, entry);
		let payload;
		try {
			payload = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			continue; // half-written or not ours
		}
		if (payload?.key !== key) continue;
		try {
			fs.renameSync(file, file + ".claimed");
		} catch {
			continue; // another waiter claimed it first
		}
		try { fs.unlinkSync(file + ".claimed"); } catch { /* cleanup only */ }
		return payload;
	}
	return undefined;
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });

function callTool(id, params) {
	const name = typeof params?.name === "string" ? params.name : "";
	const args = params?.arguments ?? {};
	if (!catalog().some((t) => t.name === name)) {
		return ok(id, { isError: true, content: [{ type: "text", text: `unknown relay tool ${name}` }] });
	}
	// Hold the call open, scanning for the driver's result. No timeout: the
	// tool may legitimately run for minutes (a nested subagent does), claude's
	// own MCP client timeout governs from its side, and this process dies with
	// claude's stdin either way.
	const wait = () => {
		const payload = claim(name, args);
		if (payload) {
			return ok(id, {
				isError: !!payload.isError,
				content: [{ type: "text", text: typeof payload.text === "string" ? payload.text : "" }],
			});
		}
		setTimeout(wait, POLL_MS);
	};
	wait();
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	let request;
	try {
		request = JSON.parse(line);
	} catch {
		return; // not ours to complain about
	}
	// Notifications carry no id and want no reply.
	if (request.id === undefined) return;

	switch (request.method) {
		case "initialize":
			return ok(request.id, {
				protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "pi-tool-relay", version: "1" },
			});
		case "tools/list":
			return ok(request.id, { tools: catalog() });
		case "tools/call":
			return callTool(request.id, request.params);
		default:
			return send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } });
	}
}).on("close", () => process.exit(0));
