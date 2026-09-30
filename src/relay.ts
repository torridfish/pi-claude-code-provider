/**
 * The pi tool relay's driver-side half: the names both sides agree on, the
 * catalog file the MCP server serves, and the result files it picks up.
 *
 * The relay lets a claude child call the child pi's own tools. The driver
 * spawns the relay MCP server (`relay-server.mjs`) alongside the ask server,
 * surfaces claude's `mcp__pi_relay__<tool>` calls as REAL pi tool calls, and
 * pi's loop executes them the way it executes its own — auto-approved, in a
 * headless child, with renderer rows and transcript entries like any other
 * tool call. The tool result comes back in the next request's transcript;
 * the driver drops it into `<runDir>/relay-res/<toolCallId>.res`, where the
 * server — still blocked in the `tools/call` it received from claude — finds
 * it by the (tool, arguments) key both sides compute, and answers claude.
 *
 * The server (`relay-server.mjs`) is plain Node with no build step and cannot
 * import this module; `canonicalCallKey` below is duplicated there on purpose.
 * If one changes, the other must.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** The MCP server name claude namespaces relay tools under. */
export const RELAY_SERVER = "pi_relay";

/** What a relayed tool is called in claude's tool_use blocks. */
export const RELAY_PREFIX = `mcp__${RELAY_SERVER}__`;

/** A pi tool as the relay server serves it to claude. `inputSchema` is pi's
 *  own parameter schema — typebox serializes as JSON Schema, which is what
 *  MCP expects. */
export interface RelayToolSpec {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

/** Where the driver publishes the catalog the server serves on tools/list. */
export const RELAY_CATALOG_FILE = "relay-tools.json";

/** Where result files travel from driver to server. */
export const RELAY_RESULT_DIR = "relay-res";

/** A pi tool result travels to claude no larger than this. The MCP client
 *  truncates on its own too; this keeps a pathological result from doing the
 *  truncating for it at file size. */
export const RELAY_RESULT_LIMIT = 300_000;

export function relayToolMcpName(tool: string): string {
	return RELAY_PREFIX + tool;
}

/** Stable JSON: key order canonicalized so both sides of the relay hash the
 *  same call to the same key. Duplicated in relay-server.mjs. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value as object).sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** The identity of a relayed call: the tool and its arguments, hashed. Two
 *  calls match when they hash equal — which also means two PARALLEL calls of
 *  the same tool with the same arguments are interchangeable, and each gets
 *  the other's result. For the tools pi registers that is harmless: same call,
 *  same result. */
export function canonicalCallKey(tool: string, args: unknown): string {
	return createHash("sha256").update(canonical({ tool, args })).digest("hex");
}

/** Publish the catalog. Called before every spawn: cheap, and it keeps the
 *  file honest if the child's active set changed under us. */
export function writeRelayCatalog(runDir: string, tools: RelayToolSpec[]): void {
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(path.join(runDir, RELAY_CATALOG_FILE), JSON.stringify(tools), { mode: 0o600 });
}

/** Drop one tool result where the server is waiting for it. The file name is
 *  the pi toolCall id (sanitized — claude's tool_use ids are already filename-
 *  safe, the driver's fallbacks may not be); the CONTENT is what matches,
 *  because only the two endpoints agree on (tool, arguments). */
export function deliverRelayResult(
	runDir: string,
	toolCallId: string,
	tool: string,
	args: unknown,
	text: string,
	isError: boolean,
): void {
	const dir = path.join(runDir, RELAY_RESULT_DIR);
	const safe = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_");
	const payload = {
		key: canonicalCallKey(tool, args),
		tool,
		text: text.slice(0, RELAY_RESULT_LIMIT),
		isError,
	};
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${safe}.res`), JSON.stringify(payload), { mode: 0o600 });
}
