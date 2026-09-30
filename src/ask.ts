/**
 * The ask bridge's static side: the names both sides of it agree on, and where
 * the MCP server that carries `caller_ping` into a claude child lives.
 *
 * The server script belongs to pi-subagents-herdr (`runners/claude-ask.mjs`):
 * one implementation of the ask protocol serves both of its consumers — that
 * repo's dedicated claude runner and this provider — so this repo points at the
 * sibling checkout instead of vendoring a copy that drifts. When the sibling is
 * not installed next to this repo the bridge stays off and the provider
 * degrades to its stage-one behavior, rather than spawning a claude whose tool
 * list names something no server answers.
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

/** The MCP server name claude namespaces tools under: `mcp__<server>__<tool>`. */
export const ASK_SERVER = "pi_subagents";

/** The tool name as the claude child sees it — what `--allowedTools` must
 *  pre-approve and what its stream's `tool_use` blocks are named. */
export const ASK_TOOL = `mcp__${ASK_SERVER}__caller_ping`;

/** The tool name as the pi child knows it: herdr/child.ts registers
 *  `caller_ping`, and the toolCall this provider surfaces must match that name
 *  for pi's loop to execute its own tool. */
export const ASK_PI_TOOL = "caller_ping";

/**
 * Where the ask MCP server lives, or undefined when the bridge cannot be
 * wired. `CLAUDE_CODE_PROVIDER_ASK_SERVER` overrides the sibling default —
 * for checkouts that do not sit side by side, or a vendored copy.
 */
export function resolveAskServerPath(): string | undefined {
	const override = process.env.CLAUDE_CODE_PROVIDER_ASK_SERVER;
	if (override) return fs.existsSync(override) ? override : undefined;
	const sibling = fileURLToPath(new URL("../../pi-subagents-herdr/runners/claude-ask.mjs", import.meta.url));
	return fs.existsSync(sibling) ? sibling : undefined;
}
